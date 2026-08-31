//! 极简笔记应用后端。
//!
//! 存储方案：每篇笔记一个 Markdown 文件，新建笔记时弹出系统保存对话框，
//! 由用户选择保存位置与文件名；笔记路径、名称、时间戳等元信息统一存在
//! `<app_data>/index.json`。旧版本遗留的笔记文件仍在 `<app_data>/notes/` 下。
//!
//! 外部文件：通过文件对话框 / 拖拽 / 系统文件关联打开的 .md 文件，
//! 由前端直接读写原路径（`open_md_file` / `save_md_file`），不进入笔记索引。
//!
//! 命名规则：**笔记名 = 文件名**，两者在整篇笔记范围内都不重复
//! （不区分大小写；重名自动加序号，绝不覆盖他人文件）。笔记名不再由正文首行
//! 自动派生——新建时取所选文件名主干，重命名时同步改名磁盘文件（非法字符清理）。
//! 外部在资源管理器里改名/移动笔记文件后，应用轮询按内容摘要匹配同一篇笔记，
//! 同步更新其路径与名称（`sync_fs_state` 轮询命令），并把该次改名记入版本控制。
//!
//! 版本控制：参考 git，版本只在用户显式提交时产生（自动保存不记录版本）。
//! 每次提交在 `<app_data>/versions/<id>/` 下写一个提交记录
//! （`v<seq>-<ts>-<hash>.md`，空文件，文件名承载元信息），形成线性提交历史
//! （没有分支）；seq 从 1 单调递增，hash 为内容 SHA-256 前 16 位十六进制。
//! 内容寻址存储：正文按 hash 只落盘一份（`blobs/<hash>`），内容回到历史值
//! 时直接复用既有对象；超过 4KB 的对象以 zlib 压缩存放（`blobs/<hash>.z`，
//! 原始大小记在 `blob-sizes.json`），压缩后不缩小的内容退化为未压缩存储。
//! 内容与名称都与最新版本一致时提交不产生新版本；提交说明存放在同目录
//! `history.json`，每个版本对应的笔记名存放在 `titles.json`（改名入版本控制：
//! 即使正文未变，改名也会生成记录该名称的新版本）。旧版把正文直接写在版本
//! 文件里的数据仍兼容读取。
//! 支持把笔记恢复为任意历史版本（`restore_note_version`）：直接以该版本
//! 内容覆写笔记文件并恢复该版本记录的笔记名，不产生新版本，恢复后可再提交
//! 把结果记录成新版本。删除笔记时一并清理其版本历史；外部文件不纳入版本控制。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use notify::{RecursiveMode, RecommendedWatcher, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use zip::write::SimpleFileOptions;

fn attachments_dir(data: &Path) -> PathBuf {
    data.join("attachments")
}

fn ensure_attachments_dir(data: &Path) -> Result<PathBuf, String> {
    let dir = attachments_dir(data);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn unique_attachment_path(dir: &Path, file_name: &str) -> PathBuf {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("pasted");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png");
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

/// 笔记元信息（与 index.json 中每条记录对应）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    id: String,
    /// 笔记名。全局唯一（不区分大小写），且始终等于磁盘文件名主干
    /// （即「笔记名 = 文件名」规则）。不再是正文首行派生而来。
    title: String,
    created_at: u64,
    updated_at: u64,
    /// 笔记文件在磁盘上的完整路径（新建时由用户选择保存位置）。
    /// 旧版索引没有该字段，加载时自动回填为 `<app_data>/notes/<id>.md`。
    #[serde(default)]
    path: String,
    /// 最近一次保存正文的 SHA-256 摘要（前 16 位十六进制）。
    /// 用于在外部改名/移动后，按内容匹配定位同一篇笔记。
    #[serde(default)]
    content_hash: String,
    /// 旧版「手动锁定标题」标记：自 笔记名=文件名 规则起不再参与逻辑，
    /// 仅保留字段以兼容读取旧索引。
    #[serde(default)]
    title_locked: bool,
    /// 是否置顶。置顶笔记在列表中始终排在最前面。
    #[serde(default)]
    pinned: bool,
}

/// 笔记完整数据（元信息 + 正文）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    #[serde(flatten)]
    meta: NoteMeta,
    content: String,
}

/// 外部 Markdown 文件内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedFile {
    path: String,
    name: String,
    content: String,
}

/// 笔记历史版本元信息（对应一个快照文件）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteVersion {
    /// 版本序号（1 起，越大越新）
    seq: u64,
    /// 快照创建时间（unix 毫秒）
    ts: u64,
    /// 内容字节数
    size: u64,
    /// 内容 SHA-256 前 16 位十六进制
    hash: String,
    /// 提交说明（可空）
    #[serde(default)]
    message: String,
    /// 该版本所属的笔记名（改名入版本控制后，能查到改名发生在哪个版本）；
    /// 旧版本没有记录时为 None。
    #[serde(default)]
    title: Option<String>,
}

/// 启动时由系统文件关联传入、等待前端取走的文件路径。
struct PendingFiles(Mutex<Vec<String>>);

/// 前端注册监听的目标目录集合（路径小写），与 notify watcher 实际监听目录 diff 增删。
#[derive(Default)]
struct WatchedDirs(Mutex<HashSet<String>>);

/// 全局 notify watcher（由 setup 初始化；事件在后台线程统一去抖合并后通知前端）。
static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// 应用全局共享状态：内存中维护笔记元信息，并用互斥锁保证并发安全。
struct AppState {
    index: Mutex<Vec<NoteMeta>>,
    /// 索引自上次落盘以来是否有未持久化的修改（update_note 懒刷盘用）。
    /// 内容类自动保存只更新 updated_at 等内存元信息，索引盘面合并去抖再写。
    index_dirty: AtomicBool,
    /// 全文搜索的内容缓存（按路径缓存正文，mtime/长度校验后复用）。
    search_cache: Arc<Mutex<SearchCache>>,
}

/// 全文搜索内容缓存：命中后无需再整篇读盘 + 分配小写副本。
struct SearchCache {
    /// 路径（小写）→ 缓存条目
    files: HashMap<String, SearchCacheEntry>,
    /// 已缓存内容总字节数（超出上限时整表清空，简单可预期）
    bytes: usize,
}

struct SearchCacheEntry {
    mtime: SystemTime,
    len: u64,
    content: String,
}

/// 全文搜索内容缓存上限：超过后整表清空。
const SEARCH_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 单文件超过该字节数不缓存（仍逐次读取搜索，避免缓存挤爆内存）。
const SEARCH_CACHE_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 临时文件序号：同进程内并发写不同目标时避免临时文件同名。
static TMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 原子写入：先写同目录下的临时文件再 rename 替换，进程在写入中途崩溃/断电
/// 也不会留下半截的目标文件（Windows 上 rename 会替换已存在的目标文件）。
/// 临时文件以 `.` 开头且扩展名为 .tmp，不会被笔记扫描当作 md 文件。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(
        ".{name}.{}.tmp",
        TMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, bytes).map_err(err)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err(e));
    }
    Ok(())
}

/// 是否为可打开的 Markdown 文件（扩展名不区分大小写）。
fn is_md_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"))
        .unwrap_or(false)
}

/// 从命令行参数中筛出可打开的文件路径（用于系统文件关联启动）。
fn filter_md_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file() && is_md_path(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {e}"))
}

fn notes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("notes");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("index.json"))
}

fn note_file(meta: &NoteMeta) -> PathBuf {
    PathBuf::from(&meta.path)
}

/* ---------- 版本控制 ---------- */

/// 单篇笔记的版本目录（`data` 为应用数据目录根）。
fn versions_dir_of(data: &Path, id: &str) -> PathBuf {
    data.join("versions").join(id)
}

/// 解析版本文件名 `v<seq>-<ts>-<hash>.md`；格式不符返回 None。
fn parse_version_file_name(name: &str) -> Option<(u64, u64, String)> {
    let rest = name.strip_suffix(".md")?.strip_prefix('v')?;
    let mut parts = rest.splitn(3, '-');
    let seq = parts.next()?.parse().ok()?;
    let ts = parts.next()?.parse().ok()?;
    let hash = parts.next()?;
    if hash.is_empty() {
        return None;
    }
    Some((seq, ts, hash.to_string()))
}

/// 内容摘要：SHA-256 前 16 位十六进制（类似 git 的内容寻址，用于判断是否变化）。
fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 版本目录内内容对象的存储目录：正文按 hash 只存一份（内容寻址）。
fn blobs_dir(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

/// 某个 hash 对应的内容对象路径（未压缩）。
fn blob_path(dir: &Path, hash: &str) -> PathBuf {
    blobs_dir(dir).join(hash)
}

/// 压缩版内容对象路径（zlib，后缀 .z）。
fn blob_z_path(dir: &Path, hash: &str) -> PathBuf {
    blobs_dir(dir).join(format!("{hash}.z"))
}

/// 内容对象是否存在（压缩或未压缩任一形式都算存在）。
fn blob_exists(dir: &Path, hash: &str) -> bool {
    blob_path(dir, hash).is_file() || blob_z_path(dir, hash).is_file()
}

/// 超过该字节数的内容对象才做 zlib 压缩：小文件压缩收益微乎其微，
/// 直接原样落盘，省去解压开销。
const BLOB_COMPRESS_MIN_BYTES: usize = 4096;

/// 压缩对象原始大小的存储文件（`hash -> 未压缩字节数`），
/// 列表时不必解压即可给出真实内容大小；缺失视为未压缩。
fn blob_sizes_path(dir: &Path) -> PathBuf {
    dir.join("blob-sizes.json")
}

fn load_blob_sizes(dir: &Path) -> HashMap<String, u64> {
    fs::read_to_string(blob_sizes_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 保存压缩对象的原始大小（尽力而为：失败最多列表时大小不准确）。
fn save_blob_size(dir: &Path, hash: &str, size: u64) {
    let mut map = load_blob_sizes(dir);
    map.insert(hash.to_string(), size);
    if let Ok(json) = serde_json::to_string(&map) {
        let _ = write_atomic(&blob_sizes_path(dir), json.as_bytes());
    }
}

/// 写入内容对象：大文件（≥ 阈值）做 zlib 压缩存为 `<hash>.z`；
/// 压缩后没有变小（如已被压缩过的内容）则退化存未压缩版。
/// 压缩用 fast 级别：提交大笔记时耗时远低于 default（压缩率略低，换取明显更快的提交）。
fn write_blob(dir: &Path, hash: &str, content: &str) -> Result<(), String> {
    let bytes = content.as_bytes();
    if bytes.len() >= BLOB_COMPRESS_MIN_BYTES {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(bytes).map_err(err)?;
        let compressed = enc.finish().map_err(err)?;
        if compressed.len() < bytes.len() {
            write_atomic(&blob_z_path(dir, hash), &compressed)?;
            save_blob_size(dir, hash, bytes.len() as u64);
            return Ok(());
        }
    }
    write_atomic(&blob_path(dir, hash), bytes)?;
    Ok(())
}

/// 读取内容对象：优先压缩版（`.z`），其次未压缩版；都不存在返回 None。
fn read_blob(dir: &Path, hash: &str) -> Option<Result<String, String>> {
    let z_path = blob_z_path(dir, hash);
    if z_path.is_file() {
        return Some(read_zlib_text(&z_path));
    }
    let path = blob_path(dir, hash);
    if path.is_file() {
        return Some(fs::read_to_string(&path).map_err(err));
    }
    None
}

/// 读取 zlib 压缩的文本内容（解压 + UTF-8 校验）。
fn read_zlib_text(path: &Path) -> Result<String, String> {
    let raw = fs::read(path).map_err(err)?;
    let mut dec = ZlibDecoder::new(&raw[..]);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).map_err(err)?;
    String::from_utf8(out).map_err(|e| format!("版本内容解码失败: {e}"))
}

/// 版本目录内提交说明的存储文件（`seq -> 说明` 的映射；缺失视为无说明）。
fn history_messages_path(dir: &Path) -> PathBuf {
    dir.join("history.json")
}

fn load_messages(dir: &Path) -> HashMap<u64, String> {
    fs::read_to_string(history_messages_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 保存提交说明（尽力而为：失败不影响快照本身，最多列表时缺少说明）。
fn save_commit_message(dir: &Path, seq: u64, message: &str) {
    let mut map = load_messages(dir);
    map.insert(seq, message.to_string());
    if let Ok(json) = serde_json::to_string(&map) {
        let _ = write_atomic(&history_messages_path(dir), json.as_bytes());
    }
}

/// 版本目录内「每个版本对应的笔记名」存储文件（`seq -> 名称`）。
/// 改名入版本控制：即使内容不变，改名也会生成一个记录该名称的新版本。
fn titles_path(dir: &Path) -> PathBuf {
    dir.join("titles.json")
}

fn load_titles(dir: &Path) -> HashMap<u64, String> {
    fs::read_to_string(titles_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 记录某个版本对应的笔记名（尽力而为：失败不影响版本本身）。
fn save_title(dir: &Path, seq: u64, title: &str) {
    let mut map = load_titles(dir);
    map.insert(seq, title.to_string());
    if let Ok(json) = serde_json::to_string(&map) {
        let _ = write_atomic(&titles_path(dir), json.as_bytes());
    }
}

/// 读取版本目录中的全部快照（按 seq 倒序，新的在前）；
/// 目录不存在视为空历史，无法解析的文件忽略。
fn list_versions_in(dir: &Path) -> Vec<NoteVersion> {
    let messages = load_messages(dir);
    let blob_sizes = load_blob_sizes(dir);
    let titles = load_titles(dir);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((seq, ts, hash)) = parse_version_file_name(&name) else {
            continue;
        };
        // 大小优先级：压缩 blob 记录的原大小 → 未压缩 blob 文件大小 →
        // 版本文件大小（旧格式，正文直接写在版本文件里）
        let mut size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if let Some(s) = blob_sizes.get(&hash) {
            size = *s;
        } else if let Ok(m) = blob_path(dir, &hash).metadata() {
            size = m.len();
        }
        out.push(NoteVersion {
            seq,
            ts,
            size,
            hash,
            message: messages.get(&seq).cloned().unwrap_or_default(),
            title: titles.get(&seq).cloned(),
        });
    }
    out.sort_by(|a, b| b.seq.cmp(&a.seq));
    out
}

/// 读取指定序号的版本内容（按文件名前缀 `v<seq>-` 匹配，时间戳/哈希任意）：
/// 优先读共享 blob（压缩或未压缩）；blob 不存在时回退读版本文件本身（兼容旧格式）。
fn read_version_in(dir: &Path, seq: u64) -> Result<String, String> {
    let prefix = format!("v{seq}-");
    let entries = fs::read_dir(dir).map_err(|_| format!("版本不存在: #{seq}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) {
            continue;
        }
        if let Some((_, _, hash)) = parse_version_file_name(&name) {
            if let Some(r) = read_blob(dir, &hash) {
                return r;
            }
        }
        // 旧格式：正文直接写在版本文件里
        return fs::read_to_string(entry.path()).map_err(err);
    }
    Err(format!("版本不存在: #{seq}"))
}

/// 把内容作为一次提交写入版本历史（目录须已存在）：
/// - 内容与名称都与最新版本一致 → 跳过（没有变化可提交），返回 None；
/// - 否则追加一个 seq 递增的提交记录并保存提交说明与名称，返回其序号。
/// 内容寻址：正文写入 `blobs/<hash>`，已存在则直接复用（如 git 的 blob 对象），
/// 因此 `A → B → A` 的历史里 A 只占一份存储。提交记录是空文件，元信息都在文件名里。
/// `title` 记录该版本对应笔记名：即使内容未变，只要改名也会生成新版本（改名入版本控制）。
fn commit_in(dir: &Path, content: &str, message: &str, title: &str) -> Result<Option<u64>, String> {
    let hash = content_hash(content);
    let versions = list_versions_in(dir);
    // 内容与名称都未变才算真正无变化（避免改名被去重吞掉）
    if versions
        .first()
        .map(|v| v.hash.as_str() == hash.as_str() && v.title.as_deref() == Some(title))
        .unwrap_or(false)
    {
        return Ok(None);
    }
    // 先写内容对象（大文件压缩，失败则本次提交失败，不留下悬空记录）
    if !blob_exists(dir, &hash) {
        fs::create_dir_all(blobs_dir(dir)).map_err(err)?;
        write_blob(dir, &hash, content)?;
    }
    // 再写提交记录（空指针文件）；最后尽力保存提交说明与笔记名
    let next_seq = versions.iter().map(|v| v.seq).max().unwrap_or(0) + 1;
    let path = dir.join(format!("v{next_seq}-{}-{hash}.md", now_millis()));
    fs::write(&path, "").map_err(err)?;
    save_commit_message(dir, next_seq, message);
    save_title(dir, next_seq, title);
    Ok(Some(next_seq))
}

/// 路径是否相同（Windows 路径不区分大小写）。
fn paths_same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_ascii_lowercase() == b.to_string_lossy().to_ascii_lowercase()
}

/// 把标题清理成合法的 Windows 文件名主干：替换非法字符、压缩连续空白、
/// 去掉首尾空白与收尾点号；结果为空时回退"无标题笔记"；
/// Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加下划线前缀规避。
fn sanitize_file_stem(title: &str) -> String {
    let spaced: String = title
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    // 连续空白压缩为一个空格
    let mut collapsed = String::with_capacity(spaced.len());
    let mut prev_space = false;
    for ch in spaced.chars() {
        if ch == ' ' {
            if !prev_space {
                collapsed.push(' ');
            }
            prev_space = true;
        } else {
            collapsed.push(ch);
            prev_space = false;
        }
    }
    let mut stem = collapsed.trim().trim_end_matches('.').trim_end().to_string();
    if stem.is_empty() {
        stem = "无标题笔记".to_string();
    }
    let base = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    ) {
        stem = format!("_{stem}");
    }
    stem
}

/// 给定期望笔记名与目标上下文，计算一个满足「笔记名 = 文件名」且都不重复的
/// 「(笔记名, 保存路径)」组合：
/// - 笔记名在全部笔记中唯一（不区分大小写，排除 exclude_id 自身）；
/// - 路径所在目录内不与其他文件冲突（绝不覆盖他人文件）；
/// - 笔记名严格等于最终路径的主干（不含扩展名）。
/// 两者冲突时统一自动追加序号（"名称 (1)"、"名称 (2)"…），绝不打扰用户重来。
fn resolve_note_target(
    metas: &[NoteMeta],
    exclude_id: &str,
    current: &Path,
    desired: &str,
) -> (String, PathBuf) {
    let dir = current
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let ext = current
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_ascii_lowercase();
    // 标题自带扩展名时避免 "计划.md.md"
    let mut base = sanitize_file_stem(desired);
    let ext_suffix = format!(".{ext}");
    if base.to_ascii_lowercase().ends_with(&ext_suffix) {
        base.truncate(base.len() - ext_suffix.len());
    }
    let same_title =
        |t: &str| metas.iter().any(|m| m.id != exclude_id && m.title.eq_ignore_ascii_case(t));
    let mut n = 0u32;
    loop {
        let candidate = if n == 0 {
            base.clone()
        } else {
            format!("{base} ({n})")
        };
        let candidate_path = dir.join(format!("{candidate}.{ext}"));
        // 与「当前笔记自己的文件」冲突不算冲突（改回同名时跳过）
        let disk_conflict = candidate_path.exists() && !paths_same(&candidate_path, current);
        if !disk_conflict && !same_title(&candidate) {
            return (candidate, candidate_path);
        }
        n += 1;
    }
}

/// 用 `resolve_note_target` 计算出的目标同步笔记元信息（尽力而为，不中断流程）：
/// - 当前文件存在 → 重命名到目标（目标与当前相同则不动；失败保留当前路径）；
/// - 当前文件不存在（被外部删除）→ 只更新记录路径与名称，下次保存在新路径重建。
/// 返回 true 表示发生了真实的命名/路径变化。
fn sync_note_to_resolved(meta: &mut NoteMeta, metas: &[NoteMeta], exclude_id: &str, desired: &str) -> bool {
    let current_files = note_file(meta);
    // 计算唯一目标（同时考虑其它笔记名与目录内文件）
    let (title, target) = resolve_note_target(metas, exclude_id, &current_files, desired);
    let renamed_title = !title.eq_ignore_ascii_case(&meta.title);
    let moved_path = !paths_same(&current_files, &target);
    if current_files.is_file() && moved_path {
        // 重命名失败（文件被占用等）→ 保持原路径原名称，下次保存再试
        if fs::rename(&current_files, &target).is_err() {
            return false;
        }
    }
    meta.title = title;
    meta.path = target.to_string_lossy().into_owned();
    renamed_title || moved_path
}

/// 把内容写入笔记文件（写失败则文件保持原状），并同步 content_hash。
fn write_note_content(meta: &mut NoteMeta, content: &str) -> Result<(), String> {
    write_atomic(&note_file(meta), content.as_bytes())?;
    meta.content_hash = content_hash(content);
    Ok(())
}

/// 读取索引文件（不存在的文件视为空索引）。
fn read_index(path: &Path) -> Result<Vec<NoteMeta>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(err)?;
    serde_json::from_str(&raw).map_err(err)
}

/// 把索引元信息写回索引文件。
fn write_index(path: &Path, metas: &[NoteMeta]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(metas).map_err(err)?;
    write_atomic(path, json.as_bytes())
}

fn load_index(app: &tauri::AppHandle) -> Result<Vec<NoteMeta>, String> {
    let path = index_path(app)?;
    let metas = read_index(&path)?;
    // 回填旧版缺失的路径字段。
    // 注意：文件被外部删除的笔记保留在索引中，由前端标记"已从磁盘删除"，
    // 继续编辑时会自动重新创建文件；若在这里过滤掉，保存就会报"笔记不存在"。
    let dir = notes_dir(app)?;
    Ok(metas
        .into_iter()
        .map(|mut m| {
            if m.path.is_empty() {
                m.path = dir.join(format!("{}.md", m.id)).to_string_lossy().into_owned();
            }
            m
        })
        .collect())
}

fn save_index(app: &tauri::AppHandle, metas: &[NoteMeta]) -> Result<(), String> {
    write_index(&index_path(app)?, metas)
}

/* ---------- 索引懒刷盘 ----------
 * update_note（自动保存）只更新 updated_at 等内存元信息，不每次整体重写 index.json：
 * 标记脏后由去抖线程合并落盘，切换/失焦/关窗（flush_index / close_ready）时立即冲刷。
 * 结构类修改（新建/删除/改名/置顶/恢复等）仍然即时落盘，保证关键操作持久化。 */

/// 索引懒刷盘去抖时长：合并连续自动保存期间的多次变更。
const INDEX_FLUSH_DEBOUNCE_MS: u64 = 1000;

/// 标记索引有未落盘修改并安排去抖刷盘（幂等：已有在途任务则不再开新线程）。
/// 刷盘失败只影响 updated_at 等时间戳的持久化，正文文件不受影响。
fn mark_index_dirty(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.index_dirty.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(INDEX_FLUSH_DEBOUNCE_MS));
        flush_pending_index(&handle);
    });
}

/// 若索引有未落盘修改则写盘（幂等；去抖线程/失焦/关窗多处触发安全）。
fn flush_pending_index(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if !state.index_dirty.swap(false, Ordering::AcqRel) {
        return;
    }
    let snapshot = match state.index.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    if let Err(e) = save_index(app, &snapshot) {
        eprintln!("索引懒刷盘失败: {e}");
        // 保留脏标记，下次触发时重试
        state.index_dirty.store(true, Ordering::Release);
    }
}

/// 列出全部笔记（置顶优先，同组按更新时间倒序）。
#[tauri::command]
async fn list_notes(state: tauri::State<'_, AppState>) -> Result<Vec<NoteMeta>, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?.clone();
    metas.sort_by(|a, b| {
        match (a.pinned, b.pinned) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.updated_at.cmp(&a.updated_at),
        }
    });
    Ok(metas)
}

/// 以字节数组做 ASCII 大小写不敏感比较（非 ASCII 字节精确比较）。
fn bytes_eq_ignore_ascii_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
}

/// 统计 needle 在 hay 中的出现次数（ASCII 大小写不敏感；非 ASCII 精确匹配）。
/// 旧实现先整篇 to_lowercase() 再查找，每文件两次全量分配；这里直接扫字节，
/// 不产生小写副本。查询串本身已由调用方统一小写化。
fn count_occurrences_ci(hay: &str, needle: &str) -> usize {
    let (hb, nb) = (hay.as_bytes(), needle.as_bytes());
    if nb.is_empty() || hb.len() < nb.len() {
        return 0;
    }
    let mut count = 0usize;
    let mut i = 0usize;
    while i + nb.len() <= hb.len() {
        if bytes_eq_ignore_ascii_case(&hb[i..i + nb.len()], nb) {
            count += 1;
            i += nb.len();
        } else {
            i += 1;
        }
    }
    count
}

/// 从缓存取正文；mtime/长度变化或未缓存则重新读盘。超过缓存上限的文件不缓存，
/// 但仍正常返回本次内容供搜索。
fn cached_or_read(cache: &mut SearchCache, path: &Path) -> Option<String> {
    let key = path.to_string_lossy().to_ascii_lowercase();
    let meta = fs::metadata(path).ok()?;
    let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
    let len = meta.len();
    if let Some(entry) = cache.files.get(&key) {
        if entry.mtime == mtime && entry.len == len {
            return Some(entry.content.clone());
        }
    }
    let content = fs::read_to_string(path).ok()?;
    if len <= SEARCH_CACHE_FILE_MAX_BYTES && content.len() <= SEARCH_CACHE_MAX_BYTES {
        if cache.bytes + content.len() > SEARCH_CACHE_MAX_BYTES {
            cache.files.clear();
            cache.bytes = 0;
        }
        cache.bytes += content.len();
        cache
            .files
            .insert(key, SearchCacheEntry { mtime, len, content: content.clone() });
    }
    Some(content)
}

/// 全文搜索笔记：标题命中权重高于正文命中，结果按权重降序排列。
/// 正文按 (mtime, 长度) 缓存复用，连续输入搜索词不会反复整篇读盘。
#[tauri::command]
async fn search_notes(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<NoteMeta>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let metas = state.index.lock().map_err(|e| e.to_string())?.clone();
    let cache = state.search_cache.clone();
    // 文件 IO 放到阻塞线程池，不阻塞 async 运行时
    let results = tauri::async_runtime::spawn_blocking(move || {
        let mut cache_guard = cache.lock().unwrap_or_else(|p| p.into_inner());
        let mut scored: Vec<(NoteMeta, i32)> = Vec::new();
        for meta in metas {
            let path = note_file(&meta);
            if !path.is_file() {
                continue;
            }
            let content = match cached_or_read(&mut cache_guard, &path) {
                Some(c) => c,
                None => continue,
            };
            let title = meta.title.to_lowercase();
            let mut score = 0;
            // 标题命中：权重 15；命中开头额外 +5
            if title.contains(&q) {
                score += 15;
                if title.starts_with(&q) {
                    score += 5;
                }
            }
            // 正文命中：每出现一次 +1（上限 50 避免过长文档过度加权）
            let count = count_occurrences_ci(&content, &q);
            if count > 0 {
                score += count.min(50) as i32;
            }
            if score > 0 {
                scored.push((meta, score));
            }
        }
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        scored.into_iter().map(|(m, _)| m).collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(results)
}

/// 切换笔记置顶状态，返回更新后的 NoteMeta。
#[tauri::command]
async fn toggle_pin(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let meta = metas
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    meta.pinned = !meta.pinned;
    let meta = meta.clone();
    save_index(&app, &metas)?;
    Ok(meta)
}

/// 新建一篇笔记：文件保存在用户选择的目录与初始文件名（前端先弹保存对话框）。
/// 若该路径已是一篇笔记，直接返回已有笔记。
/// 笔记名 = 文件名主干，整篇笔记范围内唯一（重名自动加序号）；创建后最新版本即记为初始版本。
#[tauri::command]
async fn create_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<NoteMeta, String> {
    let p = PathBuf::from(&path);
    if !is_md_path(&p) {
        return Err(format!("请选择 Markdown 文件: {}", p.display()));
    }
    if p.parent().map(|d| !d.is_dir()).unwrap_or(true) {
        return Err(format!("保存目录不存在: {}", p.display()));
    }

    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    if let Some(m) = metas.iter().find(|m| m.path.eq_ignore_ascii_case(&path)) {
        return Ok(m.clone());
    }

    let now = now_millis();
    // 初始名来自所选文件名主干（不再取正文首行）；全局去重并保证文件名不冲突。
    let desired = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: String::new(),
        created_at: now,
        updated_at: now,
        path: path.clone(),
        content_hash: String::new(),
        title_locked: true,
        pinned: false,
    };
    // 若所选位置已被一个同名文件占用（可能不是笔记），重名自动加序号绝不覆盖。
    // 已有内容的文件内容先读出来保留（新笔记不丢弃用户已放好的内容）。
    let existing = if p.is_file() {
        fs::read_to_string(&p).ok()
    } else {
        None
    };
    if !p.exists() {
        write_atomic(&p, b"")?;
    }
    let my_id = meta.id.clone();
    let changed = sync_note_to_resolved(&mut meta, &metas, &my_id, &desired);
    if let Some(content) = existing {
        meta.content_hash = content_hash(&content);
        // 目标路径因去重可能与所选位置不同，把原有内容搬到新文件
        let _ = write_atomic(&note_file(&meta), content.as_bytes());
        fs::remove_file(&p).ok();
    } else if changed {
        // 文件被改名到唯一位置（清空目标）
        write_atomic(&note_file(&meta), b"").ok();
    }
    metas.push(meta.clone());
    save_index(&app, &metas)?;
    // 新建即产生初始版本，便于改名纳入版本控制
    let dir = versions_dir_of(&data_dir(&app)?, &meta.id);
    fs::create_dir_all(&dir).ok();
    let content = fs::read_to_string(note_file(&meta)).unwrap_or_default();
    let _ = commit_in(&dir, &content, "新建笔记", &meta.title);
    Ok(meta)
}

/// 读取一篇笔记的完整内容。
#[tauri::command]
async fn get_note(state: tauri::State<'_, AppState>, id: String) -> Result<Note, String> {
    let metas = state.index.lock().map_err(|e| e.to_string())?;
    let meta = metas
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    drop(metas);
    let file = note_file(&meta);
    let content = if file.exists() {
        fs::read_to_string(&file).map_err(err)?
    } else {
        // 文件已被外部删除：按空内容打开，继续输入会自动重新创建
        String::new()
    };
    Ok(Note { meta, content })
}

/// 保存笔记内容。标题不再随正文首行变化（笔记名 = 文件名，改名走 `rename_note`）；
/// 这里只写正文、刷新更新时间与内容摘要。自动保存不记录版本。
/// 正文写盘仍在索引锁内（保证 content_hash 与文件一致，且顺序可预期）；
/// 索引盘面不再每次整体重写——标记脏 + 去抖懒刷，切换/失焦/关窗时冲刷。
#[tauri::command]
async fn update_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    content: String,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let meta = metas
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    meta.updated_at = now_millis();
    // 先写正文（写失败则文件保持原状），再刷新内容摘要；标题保持不变
    write_note_content(meta, &content)?;
    let meta = meta.clone();
    drop(metas);
    mark_index_dirty(&app);
    Ok(meta)
}

/// 前端在失焦/隐藏/切换时调用：立即冲刷未落盘的索引修改。
#[tauri::command]
fn flush_index(app: tauri::AppHandle) {
    flush_pending_index(&app);
}

/// 重命名一篇笔记：新名在全部笔记中唯一，磁盘文件同步改名为与名称一致（冲突自动加序号）。
/// 改名会记录到版本控制（即使正文未变也生成一个新版本，标记录改名的名称）。
#[tauri::command]
async fn rename_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let idx = metas
        .iter()
        .position(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("笔记名不能为空".to_string());
    }
    let old_title = metas[idx].title.clone();
    // 计算唯一目标名称与路径，并同步（同名则无变化）
    let connote = metas.clone();
    let changed = {
        let meta = &mut metas[idx];
        sync_note_to_resolved(meta, &connote, &id, trimmed)
    };
    if !changed {
        return Ok(metas[idx].clone());
    }
    let new_title = metas[idx].title.clone();
    metas[idx].updated_at = now_millis();
    let meta = metas[idx].clone();
    save_index(&app, &metas)?;
    // 改名入版本控制：即使正文未变也提交一个记录该名称的新版本
    let content = fs::read_to_string(note_file(&meta)).unwrap_or_default();
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    fs::create_dir_all(&dir).map_err(err)?;
    let _ = commit_in(&dir, &content, &format!("重命名：{old_title} → {new_title}"), &new_title);
    Ok(meta)
}

/// 删除一篇笔记（同时删除磁盘上的 .md 文件与索引项）。
#[tauri::command]
async fn delete_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let target = metas.iter().find(|m| m.id == id).cloned();
    let Some(target) = target else {
        return Err(format!("笔记不存在: {id}"));
    };
    metas.retain(|m| m.id != id);
    // 锁内只更新索引；磁盘清理（.md 文件与版本目录）放锁后进行，版本多时不阻塞其它命令
    save_index(&app, &metas)?;
    drop(metas);
    let file = note_file(&target);
    if file.exists() {
        fs::remove_file(&file).map_err(err)?;
    }
    // 笔记已删除，版本历史一并清理（尽力而为，不阻断删除）
    if let Ok(data) = data_dir(&app) {
        let versions = versions_dir_of(&data, &id);
        let _ = fs::remove_dir_all(&versions);
    }
    Ok(())
}

/// 批量删除多篇笔记（仅处理索引中存在的笔记；外部文件由前端自行关闭）。
/// 锁内只更新索引；文件清理在放锁后进行（尽力而为，不阻断其它命令）。
#[tauri::command]
async fn delete_selected_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let targets: Vec<NoteMeta> = {
        let mut metas = state.index.lock().map_err(|e| e.to_string())?;
        let mut targets = Vec::new();
        for id in &ids {
            if let Some(target) = metas.iter().find(|m| m.id == *id).cloned() {
                metas.retain(|m| m.id != *id);
                targets.push(target);
            }
        }
        if targets.is_empty() {
            return Ok(0);
        }
        save_index(&app, &metas)?;
        targets
    };
    let data = data_dir(&app);
    for target in &targets {
        let file = note_file(target);
        if file.exists() {
            let _ = fs::remove_file(&file);
        }
        if let Ok(data) = &data {
            let _ = fs::remove_dir_all(versions_dir_of(data, &target.id));
        }
    }
    Ok(targets.len())
}

/// 列出笔记的全部历史版本（新的在前）；没有历史时返回空数组。
#[tauri::command]
async fn list_note_versions(app: tauri::AppHandle, id: String) -> Result<Vec<NoteVersion>, String> {
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    Ok(list_versions_in(&dir))
}

/// 把笔记当前磁盘内容提交为一个新版本（类似 git commit）：
/// 内容与名称均与最新版本一致时返回 None（没有变化可提交），否则返回新版本信息。
#[tauri::command]
async fn commit_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    message: String,
) -> Result<Option<NoteVersion>, String> {
    let metas = state.index.lock().map_err(|e| e.to_string())?;
    let meta = metas
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?
        .clone();
    drop(metas);
    let content = fs::read_to_string(note_file(&meta))
        .map_err(|_| "笔记文件不存在，无法提交（继续编辑保存后会自动重建）".to_string())?;
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    fs::create_dir_all(&dir).map_err(err)?;
    let trimmed = message.trim();
    match commit_in(&dir, &content, trimmed, &meta.title)? {
        // 直接用已知信息构造返回值，免去提交后再整目录扫描一遍（历史列表自会重新读取）
        Some(seq) => Ok(Some(NoteVersion {
            seq,
            ts: now_millis(),
            size: content.as_bytes().len() as u64,
            hash: content_hash(&content),
            message: trimmed.to_string(),
            title: Some(meta.title.clone()),
        })),
        None => Ok(None),
    }
}

/// 批量导出选中条目（笔记 + 外部文件）为 zip 文件。
/// 仅导出磁盘上真实存在的文件；同名条目在压缩包内自动加序号避免冲突。
/// 元信息只在锁内复制一份，打包（可能较慢）放到阻塞线程池，不阻塞自动保存等命令；
/// 条目按原始字节写入，非 UTF-8 的外部文件（如 GBK 编码的 txt）也能导出。
#[tauri::command]
async fn export_notes(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    paths: Vec<String>,
    zip_path: String,
) -> Result<usize, String> {
    if ids.is_empty() && paths.is_empty() {
        return Err("未选择要导出的条目".into());
    }
    // 收集 (压缩包内文件名, 磁盘路径)：笔记用标题作文件名，外部文件用文件本名
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    {
        let metas = state.index.lock().map_err(|e| e.to_string())?;
        for id in ids {
            let Some(meta) = metas.iter().find(|m| m.id == id) else {
                continue;
            };
            let file = note_file(meta);
            if !file.is_file() {
                continue;
            }
            let ext = file
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e))
                .unwrap_or_default();
            entries.push((format!("{}{}", meta.title, ext), file));
        }
    }
    for p in paths {
        let file = PathBuf::from(&p);
        if !file.is_file() {
            continue;
        }
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        entries.push((name, file));
    }

    let zipping = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let mut writer = zip::ZipWriter::new(fs::File::create(&zip_path).map_err(err)?);
        let mut exported = 0usize;
        let mut used_names: HashMap<String, usize> = HashMap::new();
        for (name, file) in entries {
            // 同名条目加序号（foo.md -> foo (1).md -> foo (2).md …）
            let count = used_names.entry(name.clone()).or_insert(0);
            let arc_name = if *count == 0 {
                name.clone()
            } else {
                match name.rfind('.') {
                    Some(i) => format!("{} ({}).{}", &name[..i], *count, &name[i + 1..]),
                    None => format!("{} ({})", name, *count),
                }
            };
            *count += 1;
            let content = fs::read(&file).map_err(err)?;
            writer
                .start_file(arc_name, SimpleFileOptions::default())
                .map_err(err)?;
            writer.write_all(&content).map_err(err)?;
            exported += 1;
        }
        writer.finish().map_err(err)?;
        Ok(exported)
    });
    zipping.await.map_err(|e| e.to_string())?
}

/// 读取笔记某个历史版本的内容。
#[tauri::command]
async fn get_note_version(app: tauri::AppHandle, id: String, seq: u64) -> Result<String, String> {
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    read_version_in(&dir, seq)
}

/// 把指定版本的内容写回笔记文件（恢复版本的核心步骤，独立成纯函数便于测试）：
/// 读不到版本时报错且不触碰文件；文件所在目录不存在时自动重建（外部删除场景）。
fn restore_version_content(dir: &Path, seq: u64, file: &Path) -> Result<String, String> {
    let content = read_version_in(dir, seq)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    write_atomic(file, content.as_bytes())?;
    Ok(content)
}

/// 把笔记恢复为指定历史版本（类似 `git checkout <commit> -- <file>`）：
/// 直接以该版本内容覆写笔记文件，并把笔记名设为该版本记录的名称（笔记名 = 文件名），
/// 文件名随之同步改名（冲突自动加序号）；不产生新版本，恢复后再提交可记录成新版本。
#[tauri::command]
async fn restore_note_version(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    seq: u64,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let idx = metas
        .iter()
        .position(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    let content = restore_version_content(&dir, seq, &note_file(&metas[idx]))?;
    // 该版本记录的名称（旧版本没有名称记录时沿用当前名）
    let version_title = list_versions_in(&dir)
        .iter()
        .find(|v| v.seq == seq)
        .and_then(|v| v.title.clone())
        .unwrap_or_else(|| metas[idx].title.clone());
    let connote = metas.clone();
    let meta = &mut metas[idx];
    meta.updated_at = now_millis();
    meta.content_hash = content_hash(&content);
    // 名称可能因去重而带序号，但语义上恢复到该版本记录的名称
    let _ = sync_note_to_resolved(meta, &connote, &id, &version_title);
    let meta = meta.clone();
    save_index(&app, &metas)?;
    Ok(meta)
}

/// 用系统默认浏览器打开外部链接（仅允许 http/https）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("仅允许打开 http/https 链接: {url}"));
    }
    // 注意：不要用 `cmd /C start "" url` —— Rust 的 Command 会把参数里的引号
    // 转义成 `\"`，而 cmd.exe 不认这种转义，URL 前后会多出反斜杠导致
    // “找不到文件 \https://...\”。rundll32 的 FileProtocolHandler 是
    // Windows 打开 URL 的标准入口，且按正常规则解析参数，不会出错。
    #[cfg(target_os = "windows")]
    let ok = std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(&url)
        .spawn()
        .is_ok();
    #[cfg(target_os = "macos")]
    let ok = std::process::Command::new("open").arg(&url).spawn().is_ok();
    #[cfg(target_os = "linux")]
    let ok = std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .is_ok();
    if ok {
        Ok(())
    } else {
        Err("无法启动系统浏览器".to_string())
    }
}

/// 在系统文件管理器中显示文件所在位置：
/// Windows 资源管理器定位选中该文件（`explorer /select,` 与路径必须拆成两个参数，
/// 否则路径含空格时 Rust 会给单个参数整体加引号，explorer 解析失败并退化为打开默认位置）；
/// macOS Finder 显示文件；文件不存在（被外部删除）时退化为打开其所在目录。
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let ok = {
        let p = Path::new(&path);
        if p.exists() {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&path)
                .spawn()
                .is_ok()
        } else {
            std::process::Command::new("explorer")
                .arg(p.parent().unwrap_or_else(|| Path::new(".")))
                .spawn()
                .is_ok()
        }
    };
    #[cfg(target_os = "macos")]
    let ok = {
        let p = Path::new(&path);
        if p.exists() {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .spawn()
                .is_ok()
        } else {
            std::process::Command::new("open")
                .arg(p.parent().unwrap_or_else(|| Path::new(".")))
                .spawn()
                .is_ok()
        }
    };
    #[cfg(target_os = "linux")]
    let ok = {
        let p = Path::new(&path);
        std::process::Command::new("xdg-open")
            .arg(p.parent().unwrap_or_else(|| Path::new(".")))
            .spawn()
            .is_ok()
    };
    if ok {
        Ok(())
    } else {
        Err("无法打开文件所在位置".to_string())
    }
}

/// 读取外部 Markdown 文件（校验扩展名；非 UTF-8 编码按 UTF-8 宽容解码，避免直接报错）。
#[tauri::command]
async fn open_md_file(path: String) -> Result<OpenedFile, String> {
    let p = PathBuf::from(&path);
    if !is_md_path(&p) {
        return Err(format!("不支持的文件类型: {}", p.display()));
    }
    if !p.is_file() {
        return Err(format!("文件不存在: {}", p.display()));
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let content = match fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => String::from_utf8_lossy(&fs::read(&p).map_err(err)?).into_owned(),
    };
    Ok(OpenedFile { path, name, content })
}

/// 将内容以 UTF-8 保存回外部 Markdown 文件原路径。
#[tauri::command]
async fn save_md_file(path: String, content: String) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    if !is_md_path(&p) {
        return Err(format!("不支持的文件类型: {}", p.display()));
    }
    write_atomic(&p, content.as_bytes())?;
    Ok(now_millis())
}

/// 把外部文件另存为一篇笔记的核心逻辑（与 AppHandle 解耦，便于测试）：
/// - 源文件须存在且为 .md/.markdown/.txt，内容按宽容 UTF-8 读取；
/// - 目标路径必须是 Markdown 文件且所在目录存在；
/// - 目标已是一篇笔记 → 报错；目标文件已存在且未确认覆盖 → 报错；
/// - 成功：内容复制到目标路径、登记进索引，返回新笔记元信息（源文件保持不动）。
/// 笔记名 = 目标文件名主干，整篇笔记范围内唯一（重名自动加序号，绝不覆盖他人文件）。
#[cfg(test)]
fn save_file_as_note_core(
    index: &Path,
    source: &Path,
    target: &Path,
    overwrite: bool,
) -> Result<NoteMeta, String> {
    if !is_md_path(source) || !source.is_file() {
        return Err(format!("源文件不存在: {}", source.display()));
    }
    if !is_md_path(target) {
        return Err(format!("请选择 Markdown 文件: {}", target.display()));
    }
    if target.parent().map(|d| !d.is_dir()).unwrap_or(true) {
        return Err(format!("保存目录不存在: {}", target.display()));
    }
    let mut metas = read_index(index)?;
    if let Some(m) = metas
        .iter()
        .find(|m| m.path.eq_ignore_ascii_case(&target.to_string_lossy()))
    {
        return Err(format!("该路径已是一篇笔记「{}」，请选择其他位置", m.title));
    }
    if target.exists() && !overwrite {
        return Err(format!("目标文件已存在: {}", target.display()));
    }
    let content = match fs::read_to_string(source) {
        Ok(s) => s,
        Err(_) => String::from_utf8_lossy(&fs::read(source).map_err(err)?).into_owned(),
    };
    let now = now_millis();
    let desired = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: String::new(),
        created_at: now,
        updated_at: now,
        path: target.to_string_lossy().into_owned(),
        content_hash: String::new(),
        title_locked: true,
        pinned: false,
    };
    // 若覆盖到一个已存在的目标文件，先把它移走/改名成本笔记唯一目标
    let (title, resolved) = resolve_note_target(&metas, &meta.id, target, &desired);
    meta.title = title;
    meta.path = resolved.to_string_lossy().into_owned();
    if target.exists() {
        // 用户确认覆盖：直接写到唯一目标路径；若与目标不同则清理原文件
        if !paths_same(&resolved, target) {
            fs::remove_file(target).ok();
        }
    }
    write_note_content(&mut meta, &content)?;
    metas.push(meta.clone());
    write_index(index, &metas)?;
    Ok(meta)
}

/// 把当前打开的外部文件另存为一篇笔记：内容复制到用户选择的新路径，
/// 原文件保持不动；新路径登记进笔记索引，从此可参与版本管理。
#[tauri::command]
async fn save_file_as_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source: String,
    target: String,
    overwrite: bool,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let source_p = Path::new(&source);
    let target_p = Path::new(&target);

    if !is_md_path(source_p) || !source_p.is_file() {
        return Err(format!("源文件不存在: {}", source_p.display()));
    }
    if !is_md_path(target_p) {
        return Err(format!("请选择 Markdown 文件: {}", target_p.display()));
    }
    if target_p.parent().map(|d| !d.is_dir()).unwrap_or(true) {
        return Err(format!("保存目录不存在: {}", target_p.display()));
    }
    if let Some(m) = metas
        .iter()
        .find(|m| m.path.eq_ignore_ascii_case(&target_p.to_string_lossy()))
    {
        return Err(format!("该路径已是一篇笔记「{}」，请选择其他位置", m.title));
    }
    if target_p.exists() && !overwrite {
        return Err(format!("目标文件已存在: {}", target_p.display()));
    }
    let content = match fs::read_to_string(source_p) {
        Ok(s) => s,
        Err(_) => String::from_utf8_lossy(&fs::read(source_p).map_err(err)?).into_owned(),
    };
    let now = now_millis();
    let desired = target_p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: String::new(),
        created_at: now,
        updated_at: now,
        path: target_p.to_string_lossy().into_owned(),
        content_hash: String::new(),
        title_locked: true,
        pinned: false,
    };
    // 用唯一目标（笔记名=文件名，重名自动加序号）；覆盖目标时清理原文件
    let (title, resolved) = resolve_note_target(&metas, &meta.id, target_p, &desired);
    meta.title = title;
    meta.path = resolved.to_string_lossy().into_owned();
    if target_p.exists() && !paths_same(&resolved, target_p) {
        fs::remove_file(target_p).ok();
    }
    write_note_content(&mut meta, &content)?;
    metas.push(meta.clone());
    save_index(&app, &metas)?;
    Ok(meta)
}

/// 批量检查文件是否仍存在于磁盘（前端轮询，用于同步外部删除）。
#[tauri::command]
async fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).exists()).collect()
}

/// 扫描被外部改名/移动的笔记（纯读操作，不持索引锁）：
/// 对每篇笔记：若其记录路径上的文件已不存在，就在原所在目录里找一个未被其它笔记占用、
/// 且内容摘要与笔记最近保存一致的 .md/.markdown/.txt 文件，视为同一篇笔记被外部改名/移动。
/// 返回 (id, 新路径, 新笔记名)。
fn find_note_relocations(metas: &[NoteMeta]) -> Vec<(String, PathBuf, String)> {
    // 小写路径集合：O(1) 判断候选文件是否已被某篇笔记占用
    let mut claimed: HashSet<String> = metas.iter().map(|m| m.path.to_ascii_lowercase()).collect();
    let mut out = Vec::new();
    for m in metas {
        let file = note_file(m);
        if file.is_file() || m.content_hash.is_empty() {
            continue;
        }
        // 只在同一目录里找：外部改名/移动到同目录最常见，跨目录难以定位，保持安全。
        let Some(dir) = file.parent() else {
            continue;
        };
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        let own = m.path.to_ascii_lowercase();
        let mut found: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() || !is_md_path(&p) {
                continue;
            }
            let pk = p.to_string_lossy().to_ascii_lowercase();
            if pk == own || claimed.contains(&pk) {
                continue;
            }
            // 内容匹配定位同一篇笔记
            if fs::read_to_string(&p)
                .map(|c| content_hash(&c) == m.content_hash)
                .unwrap_or(false)
            {
                found = Some(p);
                break;
            }
        }
        let Some(found) = found else {
            continue;
        };
        let new_stem = found
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let new_title = if new_stem.is_empty() {
            m.title.clone()
        } else {
            new_stem
        };
        // 本篇已认领新路径，后续笔记不再把它当候选
        claimed.remove(&own);
        claimed.insert(found.to_string_lossy().to_ascii_lowercase());
        out.push((m.id.clone(), found, new_title));
    }
    out
}

/// 前端周期轮询的合并命令：单次往返同时完成「外部改名/移动同步」与「文件存在性检查」，
/// 代替原先 reconcile_notes + files_exist 两次 IPC；磁盘扫描与版本提交都不持索引锁，
/// 慢速操作不阻塞自动保存等命令。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsSyncResult {
    /// 本次因外部改名/移动而同步的笔记
    changed: Vec<NoteMeta>,
    /// 与入参 paths 一一对应的存在性
    exists: Vec<bool>,
}

#[tauri::command]
async fn sync_fs_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> Result<FsSyncResult, String> {
    // 阶段一：无锁快照后立刻放锁，目录扫描/内容哈希不阻塞其它命令
    let snapshot = state.index.lock().map_err(|e| e.to_string())?.clone();
    let relocations = find_note_relocations(&snapshot);

    let mut changed: Vec<NoteMeta> = Vec::new();
    // (id, 旧名, 新名, 新路径)：放锁后写版本控制
    let mut commits: Vec<(String, String, String, PathBuf)> = Vec::new();
    if !relocations.is_empty() {
        // 阶段二：锁内把重定位应用回当前索引（扫描期间索引可能已被修改）
        let mut metas = state.index.lock().map_err(|e| e.to_string())?;
        for (id, found, new_title) in relocations {
            let Some(idx) = metas.iter().position(|x| x.id == id) else {
                continue; // 扫描期间笔记已被删除
            };
            // 外部改出的新名若与其它笔记重名，自动加序号（保持 笔记名=文件名 且都不重复），
            // 并把磁盘文件同步改名为唯一名（沿用 resolve_note_target 的磁盘冲突保护）。
            // 克隆需在拿可变借用前完成，后续重定位也要看到已应用的新名。
            let connote = metas.clone();
            let (final_title, resolved) = resolve_note_target(&connote, &id, &found, &new_title);
            let mut final_path = resolved;
            if !paths_same(&final_path, &found) {
                if fs::rename(&found, &final_path).is_err() {
                    // 改名失败（文件占用等）：本次放弃同步，保持缺失状态待下次
                    continue;
                }
            } else {
                final_path = found;
            }
            let m = &mut metas[idx];
            let old_title = m.title.clone();
            m.path = final_path.to_string_lossy().into_owned();
            m.title = final_title;
            m.updated_at = now_millis();
            changed.push(m.clone());
            if old_title != m.title {
                commits.push((id, old_title, m.title.clone(), final_path));
            }
        }
        if !changed.is_empty() {
            write_index(&index_path(&app)?, &metas)?;
        }
    }

    // 阶段三：外部改名记入版本控制（I/O 放锁后进行）
    if let Ok(data) = data_dir(&app) {
        for (id, old_title, new_title, path) in commits {
            let content = fs::read_to_string(&path).unwrap_or_default();
            let dirv = versions_dir_of(&data, &id);
            fs::create_dir_all(&dirv).ok();
            let _ = commit_in(
                &dirv,
                &content,
                &format!("外部重命名：{old_title} -> {new_title}"),
                &new_title,
            );
        }
    }

    let exists = paths.iter().map(|p| PathBuf::from(p).exists()).collect();
    Ok(FsSyncResult { changed, exists })
}

/// 取出启动时由系统文件关联传入、待打开的文件路径（取走即清空）。
#[tauri::command]
fn pending_open_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// 同步文件监听：按笔记与打开文件的路径推导目标目录集合，与当前监听 diff 后增删
/// （重复调用且集合未变时直接返回，不发 IPC 往返）。外部文件变更由 notify 统一
/// 合并成 `fs-notes-changed` 事件，前端收到后执行一次同步（取代 3 秒轮询）。
#[tauri::command]
fn watch_note_dirs(
    state: tauri::State<'_, WatchedDirs>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut dirs = state.0.lock().map_err(|e| e.to_string())?;
    let mut wanted: HashSet<String> = HashSet::new();
    for p in paths {
        if let Some(parent) = Path::new(&p).parent() {
            let key = parent.to_string_lossy().to_ascii_lowercase();
            if !key.is_empty() {
                wanted.insert(key);
            }
        }
    }
    if wanted == *dirs {
        return Ok(());
    }
    let mut watcher = WATCHER.lock().map_err(|e| e.to_string())?;
    if let Some(w) = watcher.as_mut() {
        for dir in wanted.difference(&*dirs) {
            let _ = w.watch(Path::new(dir), RecursiveMode::NonRecursive);
        }
        for dir in dirs.difference(&wanted) {
            let _ = w.unwatch(Path::new(dir));
        }
    }
    *dirs = wanted;
    Ok(())
}

/// 将粘贴图片写入附件目录，返回实际保存路径（相对或绝对，前端按 Markdown 链接使用）。
#[tauri::command]
async fn save_pasted_image(
    app: tauri::AppHandle,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let data_dir = data_dir(&app)?;
    let dir = ensure_attachments_dir(&data_dir)?;
    let target = unique_attachment_path(&dir, &file_name);
    write_atomic(&target, &data)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 前端冲刷完未保存内容后调用，确认可以真正关闭窗口。
#[tauri::command]
fn close_ready(window: tauri::Window) {
    // 关窗前冲刷未落盘的索引修改（懒刷盘去抖期间也保证时间戳等元信息持久化）
    flush_pending_index(window.app_handle());
    let _ = window.destroy();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending = filter_md_args(std::env::args());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二个实例启动（如双击 .md 文件）：把文件路径转交给已运行的实例
            let files = filter_md_args(argv.into_iter());
            if files.is_empty() {
                return;
            }
            // 事件可能早于前端监听器注册（窗口刚启动时），放入待打开列表兜底
            if let Ok(mut list) = app.state::<PendingFiles>().0.lock() {
                list.extend(files.iter().cloned());
            }
            let _ = app.emit("open-md-files", files);
        }))
        .setup(|app| {
            let metas = load_index(app.handle())?;
            app.manage(AppState {
                index: Mutex::new(metas),
                index_dirty: AtomicBool::new(false),
                search_cache: Arc::new(Mutex::new(SearchCache {
                    files: HashMap::new(),
                    bytes: 0,
                })),
            });
            app.manage(WatchedDirs::default());
            // 初始化文件监听：目录增删由 watch_note_dirs 命令控制；
            // 事件在后台线程合并成 `fs-notes-changed`（外部文件变更的事件驱动同步入口）。
            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
            match notify::recommended_watcher(tx) {
                Ok(w) => {
                    if let Ok(mut guard) = WATCHER.lock() {
                        *guard = Some(w);
                    }
                    std::thread::spawn(move || {
                        while rx.recv().is_ok() {
                            // 合并风暴：排空积压后统一通知一次，前端只触发一次同步
                            while rx.try_recv().is_ok() {}
                            let _ = handle.emit("fs-notes-changed", ());
                        }
                    });
                }
                Err(e) => eprintln!("文件监听初始化失败: {e}"),
            }
            Ok(())
        })
        .manage(PendingFiles(Mutex::new(pending)))
        .invoke_handler(tauri::generate_handler![
            list_notes,
            search_notes,
            toggle_pin,
            create_note,
            get_note,
            update_note,
            rename_note,
            delete_note,
            delete_selected_notes,
            list_note_versions,
            get_note_version,
            commit_note,
            export_notes,
            restore_note_version,
            open_external,
            reveal_in_folder,
            open_md_file,
            save_md_file,
            save_file_as_note,
            files_exist,
            sync_fs_state,
            pending_open_files,
            watch_note_dirs,
            flush_index,
            save_pasted_image,
            close_ready
        ])
        .on_window_event(|window, event| {
            // 关闭窗口前先让前端冲刷未保存内容（自动保存的防抖期间不丢字）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app-close-request", ());
                // 兜底：前端 2 秒内未确认（页面异常等）则强制关闭
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let _ = win.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("notebook-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_stem_rules() {
        // 非法字符替换为空格（全角冒号在 Windows 文件名中合法，保留以完全一致）
        assert_eq!(sanitize_file_stem("我的笔记：计划"), "我的笔记：计划");
        assert_eq!(sanitize_file_stem("a<b>c:d"), "a b c d");
        // 连续空白压缩、首尾清理、收尾点号去掉
        assert_eq!(sanitize_file_stem("  a  b  "), "a b");
        assert_eq!(sanitize_file_stem("foo."), "foo");
        // Windows 保留设备名加下划线前缀
        assert_eq!(sanitize_file_stem("CON"), "_CON");
        assert_eq!(sanitize_file_stem("com1"), "_com1");
        // 全部非法字符回退默认名
        assert_eq!(sanitize_file_stem(":::*?"), "无标题笔记");
    }

    #[test]
    fn target_path_self_and_conflict() {
        let dir = tmp_dir("target");
        // 名称与当前文件名一致、且无其它笔记占用：目标就是自身
        let cur = dir.join("读书笔记.md");
        fs::write(&cur, "# 读书笔记").unwrap();
        let (title, path) = resolve_note_target(&[], "", &cur, "读书笔记");
        assert_eq!(title, "读书笔记");
        assert_eq!(path, cur);
        // 名称变化：取同目录新名
        let (t, t1) = resolve_note_target(&[], "", &cur, "工作日志");
        assert_eq!((t.as_str(), t1.clone()), ("工作日志", dir.join("工作日志.md")));
        // 目标路径被一个非笔记文件占用：自动加序号，绝不覆盖
        fs::write(&t1, "占位").unwrap();
        let (t2a, t2) = resolve_note_target(&[], "", &cur, "工作日志");
        assert_eq!(t2a, "工作日志 (1)");
        assert_eq!(t2, dir.join("工作日志 (1).md"));
        fs::write(&t2, "占位2").unwrap();
        let (t3a, t3) = resolve_note_target(&[], "", &cur, "工作日志");
        assert_eq!(t3a, "工作日志 (2)");
        assert_eq!(t3, dir.join("工作日志 (2).md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_path_dedup_against_other_notes() {
        let dir = tmp_dir("target-title");
        let cur = dir.join("旧.md");
        fs::write(&cur, "").unwrap();
        // 另一篇笔记已占用 "计划"（即使在不同需求下同目录判断也要全局唯一）
        let other = NoteMeta {
            id: "other".into(),
            title: "计划".into(),
            created_at: 0,
            updated_at: 0,
            path: dir.join("计划.md").to_string_lossy().into_owned(),
            content_hash: String::new(),
            title_locked: true,
            pinned: false,
        };
        let metas = vec![other];
        let (title, path) = resolve_note_target(&metas, "", &cur, "计划");
        assert_eq!(title, "计划 (1)");
        assert_eq!(path, dir.join("计划 (1).md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_path_handles_extension_in_name() {
        let dir = tmp_dir("ext");
        let cur = dir.join("旧.md");
        fs::write(&cur, "").unwrap();
        // 名称自带扩展名时不产生 "计划.md.md"
        let (t1, p1) = resolve_note_target(&[], "", &cur, "计划.md");
        assert_eq!((t1.as_str(), p1.clone()), ("计划", dir.join("计划.md")));
        let (t2, p2) = resolve_note_target(&[], "", &cur, "计划.MD");
        assert_eq!((t2.as_str(), p2.clone()), ("计划", dir.join("计划.md")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_version_name_rules() {
        assert_eq!(
            parse_version_file_name("v1-1700000000000-abcdef0123456789.md"),
            Some((1, 1700000000000, "abcdef0123456789".to_string()))
        );
        // 扩展名 / 前缀 / 结构不符都不予识别
        assert_eq!(parse_version_file_name("v1-1700000000000-abcd.txt"), None);
        assert_eq!(parse_version_file_name("x1-1-aa.md"), None);
        assert_eq!(parse_version_file_name("v1-1700000000000.md"), None);
        assert_eq!(parse_version_file_name("v1-1700000000000-.md"), None);
        assert_eq!(parse_version_file_name("v-1-aa.md"), None);
    }

    #[test]
    fn content_hash_is_sha256_prefix() {
        // sha256("abc") 的前 16 位十六进制
        assert_eq!(content_hash("abc"), "ba7816bf8f01cfea");
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
    }

    #[test]
    fn version_history_linear_and_dedup() {
        let dir = tmp_dir("versions");
        // 空历史：第一次提交作为基线
        assert_eq!(commit_in(&dir, "hello", "初稿", "笔记").unwrap(), Some(1));
        // 与最新版本内容、名称一致：提交无效
        assert_eq!(commit_in(&dir, "hello", "再提交", "笔记").unwrap(), None);
        assert_eq!(commit_in(&dir, "world", "", "笔记").unwrap(), Some(2));
        // 内容回到更早的值：仍产生新版本（线性历史记录每次提交时刻）
        assert_eq!(commit_in(&dir, "hello", "改回 hello", "笔记").unwrap(), Some(3));

        let list = list_versions_in(&dir);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].seq, 3); // 新的在前
        assert_eq!(list[1].seq, 2);
        assert_eq!(list[2].seq, 1);
        assert_eq!(list[2].hash, content_hash("hello"));

        assert_eq!(read_version_in(&dir, 2).unwrap(), "world");
        assert_eq!(read_version_in(&dir, 1).unwrap(), "hello");
        assert!(read_version_in(&dir, 9).is_err());

        // 目录不存在：空历史，读取报错
        let empty = dir.join("不存在");
        assert!(list_versions_in(&empty).is_empty());
        assert!(read_version_in(&empty, 1).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_commit_tracks_title_even_with_same_content() {
        let dir = tmp_dir("renamerv");
        // 内容相同但名称变化：也会生成新版本并记录名称（改名入版本控制）
        assert_eq!(commit_in(&dir, "内容", "初稿", "旧名称").unwrap(), Some(1));
        assert_eq!(commit_in(&dir, "内容", "改名为新", "新名称").unwrap(), Some(2));
        let list = list_versions_in(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title.as_deref(), Some("新名称"));
        assert_eq!(list[1].title.as_deref(), Some("旧名称"));
        // 两个版本共享同一 blob
        assert_eq!(list[0].hash, list[1].hash);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_messages_persist_across_list() {
        let dir = tmp_dir("msg");
        commit_in(&dir, "a", "第一次提交", "笔记").unwrap();
        commit_in(&dir, "b", "  带空白的说明  ", "笔记").unwrap();

        // 同一目录重新列出：说明从 history.json 恢复
        let list = list_versions_in(&dir);
        assert_eq!(list[0].message, "  带空白的说明  "); // trim 由命令层负责
        assert_eq!(list[1].message, "第一次提交");

        // 说明不存在的旧版本（无 history.json 条目）回退为空串
        fs::write(dir.join("v3-1700000000000-deadbeefdeadbeef.md"), "c").unwrap();
        let list = list_versions_in(&dir);
        let v3 = list.iter().find(|v| v.seq == 3).unwrap();
        assert_eq!(v3.message, "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_reuses_content_blobs() {
        let dir = tmp_dir("blob");
        commit_in(&dir, "内容A", "初稿", "笔记").unwrap();
        commit_in(&dir, "内容B", "", "笔记").unwrap();
        // 内容回到历史值：新提交复用既有 blob，不重复落盘
        commit_in(&dir, "内容A", "改回", "笔记").unwrap();

        let list = list_versions_in(&dir);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].hash, content_hash("内容A"));

        // blobs 目录只有两个对象：A 与 B 各一份
        let blobs: Vec<String> = fs::read_dir(blobs_dir(&dir))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(blobs.len(), 2);

        // 提交记录是空指针文件（正文不在里面）
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if parse_version_file_name(&name).is_some() {
                assert_eq!(fs::read_to_string(entry.path()).unwrap(), "");
            }
        }

        // 任意版本读取内容正确（v1 与 v3 共享同一 blob）
        assert_eq!(read_version_in(&dir, 1).unwrap(), "内容A");
        assert_eq!(read_version_in(&dir, 2).unwrap(), "内容B");
        assert_eq!(read_version_in(&dir, 3).unwrap(), "内容A");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_inline_version_files_still_readable() {
        let dir = tmp_dir("legacy");
        // 模拟旧格式：正文直接写在版本文件里，没有 blobs 目录
        fs::write(dir.join("v1-1700000000000-abcdef0123456789.md"), "# 旧内容").unwrap();
        let list = list_versions_in(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].size, "# 旧内容".len() as u64); // 大小取自版本文件本身
        assert_eq!(read_version_in(&dir, 1).unwrap(), "# 旧内容");

        // 之后的新提交走 blob，旧版本仍可正常读取
        commit_in(&dir, "新内容", "", "笔记").unwrap();
        assert_eq!(read_version_in(&dir, 1).unwrap(), "# 旧内容");
        assert_eq!(read_version_in(&dir, 2).unwrap(), "新内容");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn large_blobs_compressed_small_ones_plain() {
        let dir = tmp_dir("zlib");
        // 大内容（高度可压缩的重复文本）→ 存为 <hash>.z
        let big = "这是一段用于测试压缩的重复文本。".repeat(300);
        assert!(big.len() > BLOB_COMPRESS_MIN_BYTES);
        commit_in(&dir, &big, "大文件", "笔记").unwrap();
        let big_hash = content_hash(&big);
        assert!(blob_z_path(&dir, &big_hash).is_file(), "大对象应压缩存储");
        assert!(!blob_path(&dir, &big_hash).exists(), "大对象不应有未压缩副本");
        assert!(
            fs::metadata(blob_z_path(&dir, &big_hash)).unwrap().len() < big.len() as u64,
            "压缩后应小于原文"
        );

        // 列表大小是原始字节数，读取内容完整还原
        let list = list_versions_in(&dir);
        assert_eq!(list[0].size, big.len() as u64);
        assert_eq!(read_version_in(&dir, 1).unwrap(), big);

        // 小内容：直接未压缩落盘
        let small = "短内容";
        commit_in(&dir, small, "小文件", "笔记").unwrap();
        let small_hash = content_hash(small);
        assert!(blob_path(&dir, &small_hash).is_file());
        assert!(!blob_z_path(&dir, &small_hash).exists());

        // 阈值边界：恰好达到阈值即走压缩
        let boundary = "a".repeat(BLOB_COMPRESS_MIN_BYTES);
        assert_eq!(boundary.len(), BLOB_COMPRESS_MIN_BYTES);
        commit_in(&dir, &boundary, "边界", "笔记").unwrap();
        assert!(blob_z_path(&dir, &content_hash(&boundary)).is_file());
        assert_eq!(read_version_in(&dir, 3).unwrap(), boundary);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_version_overwrites_file_and_keeps_history() {
        let dir = tmp_dir("restore");
        // 提交 A → B 两个版本
        assert_eq!(commit_in(&dir, "第一版", "初始", "笔记").unwrap(), Some(1));
        assert_eq!(commit_in(&dir, "第二版", "更新", "笔记").unwrap(), Some(2));

        // 笔记文件当前是 B，恢复到 #1 后文件变回 A
        let file = dir.join("note.md");
        fs::write(&file, "第二版").unwrap();
        assert_eq!(restore_version_content(&dir, 1, &file).unwrap(), "第一版");
        assert_eq!(fs::read_to_string(&file).unwrap(), "第一版");

        // 历史本身不受影响：两个版本都还能读
        assert_eq!(read_version_in(&dir, 1).unwrap(), "第一版");
        assert_eq!(read_version_in(&dir, 2).unwrap(), "第二版");

        // 文件所在目录不存在时自动重建（外部删除目录的场景）
        let recreated = dir.join("sub").join("note.md");
        assert_eq!(
            restore_version_content(&dir, 2, &recreated).unwrap(),
            "第二版"
        );
        assert_eq!(fs::read_to_string(&recreated).unwrap(), "第二版");

        // 版本不存在：报错且不触碰文件
        assert!(restore_version_content(&dir, 9, &file).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "第一版");

        // 恢复后再次提交（内容与 #1 相同）：生成新版本并复用既有 blob
        assert_eq!(commit_in(&dir, "第一版", "恢复", "笔记").unwrap(), Some(3));
        assert_eq!(list_versions_in(&dir).len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_file_as_note_copies_and_indexes() {
        let dir = tmp_dir("saveas");
        let index = dir.join("index.json");
        // 源外部文件（不在索引中）
        let src = dir.join("外部.txt");
        fs::write(&src, "# 会议记录\n\n- 事项一\n- 事项二").unwrap();

        // 目标不存在：直接另存成功，内容复制、索引登记、源文件不动；
        // 笔记名 = 目标文件名主干（不再取正文首行）
        let target = dir.join("我的会议.md");
        let meta = save_file_as_note_core(&index, &src, &target, false).unwrap();
        assert_eq!(meta.title, "我的会议");
        assert_eq!(fs::read_to_string(&target).unwrap(), "# 会议记录\n\n- 事项一\n- 事项二");
        assert_eq!(fs::read_to_string(&src).unwrap(), "# 会议记录\n\n- 事项一\n- 事项二");
        let metas = read_index(&index).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, meta.id);

        // 目标已是一篇笔记：即使确认覆盖也报错
        assert!(save_file_as_note_core(&index, &src, &target, true).is_err());

        // 目标文件已存在且未确认覆盖：报错且不覆盖原文件
        let occupied = dir.join("被占用.md");
        fs::write(&occupied, "旧内容").unwrap();
        assert!(save_file_as_note_core(&index, &src, &occupied, false).is_err());
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "旧内容");

        // 确认覆盖目标文件后成功：内容被替换并登记（笔记名不变 = 目标文件名主干）
        let meta2 = save_file_as_note_core(&index, &src, &occupied, true).unwrap();
        assert_eq!(meta2.title, "被占用");
        assert_eq!(meta2.path, occupied.to_string_lossy());
        assert_eq!(
            fs::read_to_string(&occupied).unwrap(),
            "# 会议记录\n\n- 事项一\n- 事项二"
        );
        assert_eq!(read_index(&index).unwrap().len(), 2);
        assert_ne!(meta2.id, meta.id);

        // 目标是一个已存在的普通文件且确认覆盖：按目标文件名建笔记
        let stray = dir.join("另一个文件.md");
        fs::write(&stray, "占位").unwrap();
        let meta3 = save_file_as_note_core(&index, &src, &stray, true).unwrap();
        assert_eq!(meta3.title, "另一个文件");
        assert_eq!(meta3.path, stray.to_string_lossy());
        assert_eq!(
            fs::read_to_string(&stray).unwrap(),
            "# 会议记录\n\n- 事项一\n- 事项二"
        );

        // 源文件非法 / 目标目录不存在 / 源不存在：均报错
        let bad_src = dir.join("图片.png");
        fs::write(&bad_src, "x").unwrap();
        assert!(save_file_as_note_core(&index, &bad_src, &target, false).is_err());
        let no_dir = dir.join("不存在").join("笔记.md");
        assert!(save_file_as_note_core(&index, &src, &no_dir, false).is_err());
        let missing = dir.join("没有的文件.md");
        assert!(save_file_as_note_core(&index, &missing, &target, false).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_file_as_note_named_after_target_file() {
        let dir = tmp_dir("saveas-title");
        let index = dir.join("index.json");
        let src = dir.join("外部.md");
        // 正文首行与所选文件名不一致：笔记名取所选文件名（不再跟随正文首行）
        fs::write(&src, "# 实际标题\n内容").unwrap();
        let target = dir.join("随意起的名字.md");
        let meta = save_file_as_note_core(&index, &src, &target, false).unwrap();
        assert_eq!(meta.title, "随意起的名字");
        assert_eq!(meta.path, target.to_string_lossy());
        assert!(target.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
