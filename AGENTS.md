# AGENTS.md

Tauri 2 desktop note app: Rust backend (`src-tauri/`) + vanilla TypeScript frontend (`src/`, no framework). UI strings and code comments are in Chinese — keep it that way.

## Commands

- `npm run tauri dev` — dev mode (requires Rust toolchain). Vite is pinned to port 1420 (`strictPort`); plain `npm run dev` serves the frontend without working Tauri APIs.
- `npm run build` — `tsc && vite build`; tsc is the only typecheck. No lint script, no test framework, no CI — verify with `npx tsc --noEmit` plus a manual dev run.
- `npm run tauri build` — release bundle; installer at `src-tauri/target/release/bundle/nsis/notebook_<ver>_x64-setup.exe`.
- Version lives in both `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.

## Architecture

- `index.html` holds the entire UI skeleton; `src/main.ts` (~1140 lines) is all frontend logic; `src/markdown.ts` renders Markdown (marked + DOMPurify + highlight.js); `src/styles.css` defines light/dark themes.
- All backend commands are in `src-tauri/src/lib.rs`, invoked from the frontend via `invoke(...)`; `main.rs` only calls `notebook_lib::run()`.
- Data model: each note is a standalone .md file at a user-chosen path; `index.json` in the app-data dir holds metadata only (camelCase via `serde(rename_all)`). **Deleting a note deletes the on-disk .md file.**
- Note version history (git-like linear, no branches): commit records `<app_data>/versions/<noteId>/v<seq>-<ts>-<hash>.md` (empty pointer files, metadata in the filename) with commit messages in `history.json`. Content is stored content-addressed in `blobs/<hash>` — identical content shares one blob (like git objects); blobs ≥ 4KB (`BLOB_COMPRESS_MIN_BYTES`) are zlib-compressed as `blobs/<hash>.z` with original sizes kept in `blob-sizes.json` (plain storage fallback when compression doesn't shrink). Legacy versions that stored content inline in the record file are still read (fallback when the blob is missing). Versions are created only on explicit commit (`commit_note`, via the 提交 button / context menu), never on autosave (`update_note`); committing content identical to the latest version is a no-op. `restore_note_version` restores any version by overwriting the note file (git checkout semantics: no new version is created — commit afterwards to keep the restored state). The history overlay offers a 对比 mode (line diff via the `diff` npm package, frontend-only) comparing the selected version against a selectable source defaulting to the latest version, and hides 恢复此版本 when the latest version is selected; cleaned up with the note.
- External files opened via dialog / drag-drop / file association are read and written in place and never enter the note index (and are never versioned).
- Notes whose .md file was deleted externally are intentionally kept in the index so editing recreates the file — do not filter them in `load_index`.

## Runtime gotchas

- Window close is intercepted (`prevent_close` + `app-close-request` event): the frontend flushes pending debounced saves, then invokes `close_ready` to actually close; a 2s fallback force-destroys the window. Any new close-time work must fit this handshake.
- File association / second instance: CLI args are filtered to `.md/.markdown/.txt` and relayed to the running instance via the `open-md-files` event and the `pending_open_files` command. The frontend polls pending files on startup because the event can fire before listeners register.
- `withGlobalTauri: false` — always `import { invoke } from "@tauri-apps/api/core"`; there is no `window.__TAURI__`.
- API permissions are gated in `src-tauri/capabilities/default.json`; adding a plugin or new core API requires a permission entry there.
- `open_external` on Windows must use `rundll32 url.dll,FileProtocolHandler` — `cmd /C start` mangles quoted URLs (see comment in lib.rs).
- `csp: null`, asset protocol scope `**`: local preview images load via `convertFileSrc` (asset: scheme, whitelisted in the DOMPurify config).
- Custom titlebar (`decorations: false`); .md file drops arrive via `getCurrentWindow().onDragDropEvent`.
- UI state persists under `notebook:*` localStorage keys (view mode, sidebar width/hidden, focus mode, theme).
