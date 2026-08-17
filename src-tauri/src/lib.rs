//! 极简笔记应用后端。
//!
//! 存储方案：每篇笔记一个 Markdown 文件，新建笔记时弹出系统保存对话框，
//! 由用户选择保存位置与文件名；笔记路径、标题、时间戳等元信息统一存在
//! `<app_data>/index.json`。旧版本遗留的笔记文件仍在 `<app_data>/notes/` 下。
//!
//! 外部文件：通过文件对话框 / 拖拽 / 系统文件关联打开的 .md 文件，
//! 由前端直接读写原路径（`open_md_file` / `save_md_file`），不进入笔记索引。
//!
//! 文件名与笔记名称保持一致：标题（正文首行或手动重命名）变化时，磁盘上的
//! 笔记文件自动同步改名（非法字符清理、重名自动加序号，绝不覆盖已有文件）。
//!
//! 版本控制：参考 git，版本只在用户显式提交时产生（自动保存不记录版本）。
//! 每次提交在 `<app_data>/versions/<id>/` 下写一个提交记录
//! （`v<seq>-<ts>-<hash>.md`，空文件，文件名承载元信息），形成线性提交历史
//! （没有分支）；seq 从 1 单调递增，hash 为内容 SHA-256 前 16 位十六进制。
//! 内容寻址存储：正文按 hash 只落盘一份（`blobs/<hash>`），内容回到历史值
//! 时直接复用既有对象；超过 4KB 的对象以 zlib 压缩存放（`blobs/<hash>.z`，
//! 原始大小记在 `blob-sizes.json`），压缩后不缩小的内容退化为未压缩存储。
//! 内容与最新版本一致时提交不产生新版本。提交说明存放在同目录
//! `history.json`；旧版把正文直接写在版本文件里的数据仍兼容读取。
//! 支持把笔记恢复为任意历史版本（`restore_note_version`）：直接以该版本
//! 内容覆写笔记文件，不产生新版本，恢复后可再提交把结果记录成新版本。
//! 删除笔记时一并清理其版本历史；外部文件不纳入版本控制。

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// 笔记元信息（与 index.json 中每条记录对应）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteMeta {
    id: String,
    title: String,
    created_at: u64,
    updated_at: u64,
    /// 笔记文件在磁盘上的完整路径（新建时由用户选择保存位置）。
    /// 旧版索引没有该字段，加载时自动回填为 `<app_data>/notes/<id>.md`。
    #[serde(default)]
    path: String,
    /// 用户手动重命名后为 true：保存正文时不再用首行覆盖标题。
    #[serde(default)]
    title_locked: bool,
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
}

/// 启动时由系统文件关联传入、等待前端取走的文件路径。
struct PendingFiles(Mutex<Vec<String>>);

/// 应用全局共享状态：内存中维护笔记元信息，并用互斥锁保证并发安全。
struct AppState {
    index: Mutex<Vec<NoteMeta>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
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
        let _ = fs::write(blob_sizes_path(dir), json);
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
            fs::write(blob_z_path(dir, hash), compressed).map_err(err)?;
            save_blob_size(dir, hash, bytes.len() as u64);
            return Ok(());
        }
    }
    fs::write(blob_path(dir, hash), bytes).map_err(err)?;
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
        let _ = fs::write(history_messages_path(dir), json);
    }
}

/// 读取版本目录中的全部快照（按 seq 倒序，新的在前）；
/// 目录不存在视为空历史，无法解析的文件忽略。
fn list_versions_in(dir: &Path) -> Vec<NoteVersion> {
    let messages = load_messages(dir);
    let blob_sizes = load_blob_sizes(dir);
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
/// - 内容与最新版本一致 → 跳过（没有变化可提交），返回 None；
/// - 否则追加一个 seq 递增的提交记录并保存提交说明，返回其序号。
/// 内容寻址：正文写入 `blobs/<hash>`，已存在则直接复用（如 git 的 blob 对象），
/// 因此 `A → B → A` 的历史里 A 只占一份存储。提交记录是空文件，元信息都在文件名里。
fn commit_in(dir: &Path, content: &str, message: &str) -> Result<Option<u64>, String> {
    let hash = content_hash(content);
    let versions = list_versions_in(dir);
    if versions.first().map(|v| v.hash.as_str()) == Some(hash.as_str()) {
        return Ok(None);
    }
    // 先写内容对象（大文件压缩，失败则本次提交失败，不留下悬空记录）
    if !blob_exists(dir, &hash) {
        fs::create_dir_all(blobs_dir(dir)).map_err(err)?;
        write_blob(dir, &hash, content)?;
    }
    // 再写提交记录（空指针文件）；最后尽力保存提交说明
    let next_seq = versions.iter().map(|v| v.seq).max().unwrap_or(0) + 1;
    let path = dir.join(format!("v{next_seq}-{}-{hash}.md", now_millis()));
    fs::write(&path, "").map_err(err)?;
    save_commit_message(dir, next_seq, message);
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

/// 计算与标题一致的笔记保存路径：同目录、同名、保留原扩展名；
/// 目标已存在且不是当前文件时自动追加序号（"标题 (1).md"），绝不覆盖他人文件。
fn note_path_for_title(current: &Path, title: &str) -> PathBuf {
    let dir = current
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let ext = current
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_ascii_lowercase();
    // 标题自带扩展名时避免 "标题.md.md"
    let mut stem = sanitize_file_stem(title);
    let ext_suffix = format!(".{ext}");
    if stem.to_ascii_lowercase().ends_with(&ext_suffix) {
        stem.truncate(stem.len() - ext_suffix.len());
    }
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 1u32;
    while candidate.exists() && !paths_same(&candidate, current) {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

/// 让笔记文件跟随标题重命名（尽力而为，不中断保存流程）：
/// - 目标与当前路径相同（忽略大小写）→ 不动；
/// - 当前文件存在 → 重命名到目标（冲突由 `note_path_for_title` 加序号）；
/// - 当前文件不存在（被外部删除）→ 只更新记录路径，下次保存在新路径重建；
/// - 重命名失败（文件被占用等）→ 保留原路径，下次保存再试。
fn sync_note_file_to_title(meta: &mut NoteMeta) {
    let current = note_file(meta);
    let target = note_path_for_title(&current, &meta.title);
    if paths_same(&current, &target) {
        return;
    }
    if current.is_file() && fs::rename(&current, &target).is_err() {
        return;
    }
    meta.path = target.to_string_lossy().into_owned();
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
    fs::write(path, json).map_err(err)
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

/// 标题截断到 50 字符（超出加省略号），与侧栏显示一致。
fn truncate_title(t: &str) -> String {
    if t.chars().count() > 50 {
        let mut s: String = t.chars().take(50).collect();
        s.push('…');
        s
    } else {
        t.to_string()
    }
}

/// 从正文第一行提取标题；空笔记显示"无标题笔记"。
fn derive_title(content: &str) -> String {
    let first_line = content
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty());

    let mut title = first_line.unwrap_or("无标题笔记").to_string();
    if title.chars().count() > 50 {
        title = title.chars().take(50).collect();
        title.push('…');
    }
    title
}

/// 列出全部笔记（按更新时间倒序）。
#[tauri::command]
async fn list_notes(state: tauri::State<'_, AppState>) -> Result<Vec<NoteMeta>, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?.clone();
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

/// 新建一篇笔记：文件保存在用户选择的路径（前端先弹保存对话框）。
/// 若该路径已有一篇笔记，直接返回已有笔记；若已存在同名文件则保留其内容不覆盖。
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
    // 初始标题与文件名保持一致：已有内容的文件取正文首行，否则取所选文件名主干
    let initial_title = if p.exists() {
        fs::read_to_string(&p)
            .map(|c| derive_title(&c))
            .unwrap_or_else(|_| "无标题笔记".to_string())
    } else {
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if stem.is_empty() {
            "无标题笔记".to_string()
        } else {
            truncate_title(&stem)
        }
    };
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: initial_title,
        created_at: now,
        updated_at: now,
        path,
        title_locked: false,
    };
    if !p.exists() {
        fs::write(&p, "").map_err(err)?;
    }
    // 让文件名立即与标题一致（新建空文件时标题=文件名主干，通常无需改名）
    sync_note_file_to_title(&mut meta);
    metas.push(meta.clone());
    save_index(&app, &metas)?;
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

/// 保存笔记内容，并更新标题与更新时间；文件名自动跟随标题。
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
    if !meta.title_locked {
        meta.title = derive_title(&content);
    }
    meta.updated_at = now_millis();
    // 先写正文（写失败则文件保持原状），再让文件名跟随标题
    // 注意：自动保存不记录版本，版本只在用户显式提交（commit_note）时产生
    fs::write(note_file(meta), &content).map_err(err)?;
    sync_note_file_to_title(meta);
    let meta = meta.clone();
    save_index(&app, &metas)?;
    Ok(meta)
}

/// 重命名一篇笔记（锁定标题，之后保存正文不再自动派生标题），
/// 同时把磁盘文件改名为与标题一致的名字（冲突自动加序号）。
/// 传空标题可解除锁定，恢复按首行自动命名。
#[tauri::command]
async fn rename_note(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> Result<NoteMeta, String> {
    let mut metas = state.index.lock().map_err(|e| e.to_string())?;
    let meta = metas
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("笔记不存在: {id}"))?;
    let trimmed = title.trim();
    if trimmed.is_empty() {
        // 恢复自动命名：标题与文件名都回到跟随正文首行
        let content = fs::read_to_string(note_file(meta)).unwrap_or_default();
        meta.title = derive_title(&content);
        meta.title_locked = false;
    } else {
        meta.title = truncate_title(trimmed);
        meta.title_locked = true;
    }
    // 让文件名与笔记名称保持一致
    sync_note_file_to_title(meta);
    let meta = meta.clone();
    save_index(&app, &metas)?;
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
    let file = note_file(&target);
    metas.retain(|m| m.id != id);
    if file.exists() {
        fs::remove_file(&file).map_err(err)?;
    }
    // 笔记已删除，版本历史一并清理（尽力而为，不阻断删除）
    if let Ok(data) = data_dir(&app) {
        let versions = versions_dir_of(&data, &id);
        let _ = fs::remove_dir_all(&versions);
    }
    save_index(&app, &metas)
}

/// 列出笔记的全部历史版本（新的在前）；没有历史时返回空数组。
#[tauri::command]
async fn list_note_versions(app: tauri::AppHandle, id: String) -> Result<Vec<NoteVersion>, String> {
    let dir = versions_dir_of(&data_dir(&app)?, &id);
    Ok(list_versions_in(&dir))
}

/// 把笔记当前磁盘内容提交为一个新版本（类似 git commit）：
/// 内容与最新版本一致时返回 None（没有变化可提交），否则返回新版本信息。
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
    match commit_in(&dir, &content, message.trim())? {
        Some(seq) => Ok(list_versions_in(&dir).into_iter().find(|v| v.seq == seq)),
        None => Ok(None),
    }
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
    fs::write(file, &content).map_err(err)?;
    Ok(content)
}

/// 把笔记恢复为指定历史版本（类似 `git checkout <commit> -- <file>`）：
/// 直接以该版本内容覆写笔记文件并更新元信息（标题跟随规则与普通保存一致），
/// 不产生新版本；恢复后内容与最新版本不同，可再提交把结果记录成新版本。
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
    let meta = &mut metas[idx];
    if !meta.title_locked {
        meta.title = derive_title(&content);
    }
    meta.updated_at = now_millis();
    sync_note_file_to_title(meta);
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
/// Windows 资源管理器定位选中该文件（`explorer /select,` 必须是单个参数，
/// 路径含空格时由 Rust 自动加引号，explorer 会解析出逗号后的完整路径）；
/// macOS Finder 显示文件；文件不存在（被外部删除）时退化为打开其所在目录。
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let ok = std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .is_ok();
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
    fs::write(&p, content).map_err(err)?;
    Ok(now_millis())
}

/// 把外部文件另存为一篇笔记的核心逻辑（与 AppHandle 解耦，便于测试）：
/// - 源文件须存在且为 .md/.markdown/.txt，内容按宽容 UTF-8 读取；
/// - 目标路径必须是 Markdown 文件且所在目录存在；
/// - 目标已是一篇笔记 → 报错；目标文件已存在且未确认覆盖 → 报错；
/// - 成功：内容复制到目标路径、登记进索引，返回新笔记元信息（源文件保持不动）。
/// 标题与文件名跟随全局规则：标题取正文首行，文件名同步改为与标题一致
/// （重名自动加序号，绝不覆盖他人文件）。
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
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: derive_title(&content),
        created_at: now,
        updated_at: now,
        path: target.to_string_lossy().into_owned(),
        title_locked: false,
    };
    fs::write(note_file(&meta), &content).map_err(err)?;
    sync_note_file_to_title(&mut meta);
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
    let mut meta = NoteMeta {
        id: uuid::Uuid::new_v4().to_string(),
        title: derive_title(&content),
        created_at: now,
        updated_at: now,
        path: target_p.to_string_lossy().into_owned(),
        title_locked: false,
    };
    fs::write(note_file(&meta), &content).map_err(err)?;
    sync_note_file_to_title(&mut meta);
    metas.push(meta.clone());
    save_index(&app, &metas)?;
    Ok(meta)
}

/// 批量检查文件是否仍存在于磁盘（前端轮询，用于同步外部删除）。
#[tauri::command]
async fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).exists()).collect()
}

/// 取出启动时由系统文件关联传入、待打开的文件路径（取走即清空）。
#[tauri::command]
fn pending_open_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// 前端冲刷完未保存内容后调用，确认可以真正关闭窗口。
#[tauri::command]
fn close_ready(window: tauri::Window) {
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
            });
            Ok(())
        })
        .manage(PendingFiles(Mutex::new(pending)))
        .invoke_handler(tauri::generate_handler![
            list_notes,
            create_note,
            get_note,
            update_note,
            rename_note,
            delete_note,
            list_note_versions,
            get_note_version,
            commit_note,
            restore_note_version,
            open_external,
            reveal_in_folder,
            open_md_file,
            save_md_file,
            save_file_as_note,
            files_exist,
            pending_open_files,
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
        // 标题与当前文件名一致：目标就是自身
        let cur = dir.join("读书笔记.md");
        fs::write(&cur, "# 读书笔记").unwrap();
        assert_eq!(note_path_for_title(&cur, "读书笔记"), cur);
        // 标题变化：取同目录新名
        let t1 = note_path_for_title(&cur, "工作日志");
        assert_eq!(t1, dir.join("工作日志.md"));
        // 目标被占用：自动加序号，绝不覆盖
        fs::write(&t1, "占位").unwrap();
        let t2 = note_path_for_title(&cur, "工作日志");
        assert_eq!(t2, dir.join("工作日志 (1).md"));
        fs::write(&t2, "占位2").unwrap();
        let t3 = note_path_for_title(&cur, "工作日志");
        assert_eq!(t3, dir.join("工作日志 (2).md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn target_path_handles_extension_in_title() {
        let dir = tmp_dir("ext");
        let cur = dir.join("旧.md");
        fs::write(&cur, "").unwrap();
        // 标题自带扩展名时不产生 "计划.md.md"
        assert_eq!(note_path_for_title(&cur, "计划.md"), dir.join("计划.md"));
        assert_eq!(note_path_for_title(&cur, "计划.MD"), dir.join("计划.md"));
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
        assert_eq!(commit_in(&dir, "hello", "初稿").unwrap(), Some(1));
        // 与最新版本内容一致：提交无效
        assert_eq!(commit_in(&dir, "hello", "再提交").unwrap(), None);
        assert_eq!(commit_in(&dir, "world", "").unwrap(), Some(2));
        // 内容回到更早的值：仍产生新版本（线性历史记录每次提交时刻）
        assert_eq!(commit_in(&dir, "hello", "改回 hello").unwrap(), Some(3));

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
    fn commit_messages_persist_across_list() {
        let dir = tmp_dir("msg");
        commit_in(&dir, "a", "第一次提交").unwrap();
        commit_in(&dir, "b", "  带空白的说明  ").unwrap();

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
        commit_in(&dir, "内容A", "初稿").unwrap();
        commit_in(&dir, "内容B", "").unwrap();
        // 内容回到历史值：新提交复用既有 blob，不重复落盘
        commit_in(&dir, "内容A", "改回").unwrap();

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
        commit_in(&dir, "新内容", "").unwrap();
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
        commit_in(&dir, &big, "大文件").unwrap();
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
        commit_in(&dir, small, "小文件").unwrap();
        let small_hash = content_hash(small);
        assert!(blob_path(&dir, &small_hash).is_file());
        assert!(!blob_z_path(&dir, &small_hash).exists());

        // 阈值边界：恰好达到阈值即走压缩
        let boundary = "a".repeat(BLOB_COMPRESS_MIN_BYTES);
        assert_eq!(boundary.len(), BLOB_COMPRESS_MIN_BYTES);
        commit_in(&dir, &boundary, "边界").unwrap();
        assert!(blob_z_path(&dir, &content_hash(&boundary)).is_file());
        assert_eq!(read_version_in(&dir, 3).unwrap(), boundary);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_version_overwrites_file_and_keeps_history() {
        let dir = tmp_dir("restore");
        // 提交 A → B 两个版本
        assert_eq!(commit_in(&dir, "第一版", "初始").unwrap(), Some(1));
        assert_eq!(commit_in(&dir, "第二版", "更新").unwrap(), Some(2));

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
        assert_eq!(commit_in(&dir, "第一版", "恢复").unwrap(), Some(3));
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

        // 目标不存在：直接另存成功，内容复制、索引登记、源文件不动
        let target = dir.join("会议记录.md");
        let meta = save_file_as_note_core(&index, &src, &target, false).unwrap();
        assert_eq!(meta.title, "会议记录");
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

        // 确认覆盖后成功：内容被替换并登记；
        // 标题（会议记录）与文件名（被占用）不一致，文件同步改名为"会议记录 (1).md"
        // （"会议记录.md" 已被第一篇笔记占用，自动加序号）
        let meta2 = save_file_as_note_core(&index, &src, &occupied, true).unwrap();
        assert_eq!(meta2.title, "会议记录");
        assert_eq!(meta2.path, dir.join("会议记录 (1).md").to_string_lossy());
        assert!(!occupied.exists(), "原目标名应已被同步改名");
        assert_eq!(
            fs::read_to_string(&dir.join("会议记录 (1).md")).unwrap(),
            "# 会议记录\n\n- 事项一\n- 事项二"
        );
        assert_eq!(read_index(&index).unwrap().len(), 2);
        assert_ne!(meta2.id, meta.id);

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
    fn save_file_as_note_syncs_filename_to_title() {
        let dir = tmp_dir("saveas-title");
        let index = dir.join("index.json");
        let src = dir.join("外部.md");
        // 正文首行与所选文件名不一致：另存后文件名跟随标题
        fs::write(&src, "# 实际标题\n内容").unwrap();
        let target = dir.join("随意起的名字.md");
        let meta = save_file_as_note_core(&index, &src, &target, false).unwrap();
        assert_eq!(meta.title, "实际标题");
        assert_eq!(meta.path, dir.join("实际标题.md").to_string_lossy());
        assert!(!target.exists(), "原目标名应已被同步改名");
        assert!(dir.join("实际标题.md").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
