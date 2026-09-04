# Annal (Notebook)

> English | [简体中文](README.md)

A minimal desktop note app built with **Tauri 2 + Vite + vanilla TypeScript + Rust**.
Each note is a standalone Markdown file stored wherever you choose; a built-in git-like version history keeps every explicit commit traceable and restorable.

## Features

**Editing & Writing**

- Three views — Edit / Split / Preview (CodeMirror 6 editor + marked + DOMPurify + on-demand syntax highlighting)
- Adaptive debounced autosave (300ms–4s); unsaved content is flushed on window close — nothing is lost
- The title (first line of the body) doubles as the file name; renames sync to disk automatically, illegal characters are cleaned up, and name collisions get a numeric suffix — files are never overwritten
- Outline navigation, scroll-synced split view, live word count in the status bar
- Pasted / dropped images are saved as attachments and inserted automatically

**Version History (git-like)**

- An explicit "Commit" creates a version snapshot; content is content-addressed and deduplicated (identical content is stored once), and any historical version can be restored with one click
- The history panel supports line-level diff comparison between versions

**Files & Search**

- Open external Markdown files via file dialog (Ctrl+O), drag & drop, or double-click through file association
- External files are edited and saved in place without entering the note index; "Save as Note" adopts one into management with a click
- Full-text search in the sidebar (case-insensitive, cached)
- "Reveal in Folder" locates a file instantly

**Appearance & Customization**

- Light / dark theme with a "follow system" option; light theme offers multiple palettes (Classic / Sakura / Mist …)
- Font size, font family (serif / sans-serif), content density, line numbers, and more
- Fully customizable shortcuts (conflict detection, one-click reset)
- Bilingual UI (Chinese / English)

## Installation

The Windows installer (NSIS, `annal_<ver>_x64-setup.exe`) is produced by `npm run tauri build` — see "Build" below.

## Development

Prerequisites: Node.js ≥ 18, a stable Rust toolchain, and WebView2 on Windows (built into Windows 11).

```bash
npm install
npm run tauri dev      # dev mode with HMR (Vite pinned to port 1420)
```

Typecheck & tests:

```bash
npx tsc --noEmit       # the only frontend gate
cargo test             # Rust backend unit tests (src-tauri/)
```

## Build

```bash
npm run tauri build
# On Windows this produces the NSIS installer:
#   src-tauri/target/release/bundle/nsis/annal_<ver>_x64-setup.exe
```

Build pipeline: `npm run build` (frontend) → cargo release compile (Rust) → tauri-bundler packages the installer.
The installer is currently unsigned, so Windows SmartScreen may warn about an "unknown publisher" — choose "Run anyway".

## Data & Storage

- Each note is a standalone `.md` file; you pick its location
- Metadata (id, title, timestamps, path) lives in `index.json`; your text always stays in plain sight
- Version history lives under `versions/` (pointer records + content-addressed `blobs/`, large blobs auto-compressed)
- Image attachments live under `attachments/`

The app data directory is managed by the OS (Windows: `%APPDATA%\com.annal.desktop`,
macOS: `~/Library/Application Support/com.annal.desktop`,
Linux: `~/.local/share/com.annal.desktop`).

## Project Structure

```
├── index.html            # UI skeleton (titlebar / sidebar / editor / preview / overlays)
├── src/                  # Frontend (framework-free, signal-driven)
│   ├── editor.ts         # CodeMirror 6 editor
│   ├── markdownModel.ts  # Block model + Markdown rendering (incremental)
│   ├── virtualPreview.ts # Virtualized preview
│   ├── sidebar.ts        # Sidebar (notes / external files / search / multi-select)
│   ├── outline.ts        # Document outline
│   ├── i18n.ts           # Internationalization (zh-CN / en-US)
│   └── app/              # Composition root & app coordinators (save / sync / settings / window)
└── src-tauri/
    ├── src/lib.rs        # Rust backend: note CRUD + version history + search + file sync
    ├── tauri.conf.json   # App configuration
    └── windows/          # NSIS installer hooks
```

## License

This project is released under the [GNU GPL v3](LICENSE) (SPDX: `GPL-3.0-or-later`).
You are free to use, modify and redistribute it, but any derivative work must be open-sourced under the same GPL-3.0 terms.

Copyright © 2026 yilv

## Roadmap

- Tags / folders
- Multiple windows
- Mobile sync
