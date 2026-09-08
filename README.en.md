<div align="center">

<img src="public/icon.png" alt="Annal icon" width="110" />

# Annal

**Minimal desktop notes · one Markdown file per note**

[![Release](https://img.shields.io/github/v/release/YlLVTECH/Annal?style=flat-square)](https://github.com/YlLVTECH/Annal/releases/latest)
[![License](https://img.shields.io/github/license/YlLVTECH/Annal?style=flat-square)](LICENSE)
[![Build & Publish](https://github.com/YlLVTECH/Annal/actions/workflows/release.yml/badge.svg?style=flat-square)](https://github.com/YlLVTECH/Annal/actions/workflows/release.yml)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=24C8DB&style=flat-square)](https://v2.tauri.app)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows11&logoColor=0078D6&style=flat-square)](#-installation)

English | [简体中文](README.md)

Built with **Tauri 2 + Vite + vanilla TypeScript + Rust**.
Fully local-first: each note is a standalone `.md` file stored wherever you choose, with a built-in git-like version history where every explicit commit is traceable and restorable.

[Download latest](https://github.com/YlLVTECH/Annal/releases/latest) · [Changelog](CHANGELOG.md) · [Report an issue](https://github.com/YlLVTECH/Annal/issues)

</div>

## ✨ Features

**✍️ Writing & Editing**

- **Live rendering** — Markdown layout rendered right inside the editor; nodes fall back to raw source under the caret (CodeMirror 6 + on-demand syntax highlighting)
- Adaptive debounced autosave (300ms–4s); unsaved content is flushed on window close — nothing is lost
- The title (first line of the body) doubles as the file name: renames sync to disk, illegal characters are cleaned up, collisions get a numeric suffix — files are never overwritten
- Outline navigation, word count, find & replace, table insertion (8×10 grid with smart CSV/TSV/MD detection)
- Pasted / dropped images are saved as attachments and inserted automatically

**🕘 Version History (git-like)**

- An explicit "Commit" creates a version snapshot; content is content-addressed and deduplicated (identical content stored once), large blobs auto-compressed
- The history panel supports line-level diff comparison and one-click restore of any version

**📁 Files & Search**

- Open external Markdown files via the file dialog (Ctrl+O), drag & drop, or double-click through file association
- External files are edited and saved in place without entering the note index; "Save as Note" adopts one into management
- Full-text search in the sidebar (case-insensitive, cached)
- "Reveal in Folder" locates a file instantly

**🎨 Appearance & Customization**

- Light / dark theme with "follow system"; light theme offers multiple palettes (Classic / Sakura / Mist …)
- Font size, font family (serif / sans-serif), content density, line numbers, and more
- Fully customizable shortcuts (conflict detection, one-click reset)
- Bilingual UI (Chinese / English)

## 📥 Installation

Download `annal_<version>_x64-setup.exe` (Windows 10/11 x64) from [Releases](https://github.com/YlLVTECH/Annal/releases/latest) and run the installer.

> The installer is currently unsigned, so Windows SmartScreen may warn about an "unknown publisher" — choose "More info → Run anyway".

## 🛠 Development

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

## 📦 Build

```bash
npm run tauri build
# On Windows this produces the NSIS installer:
#   src-tauri/target/release/bundle/nsis/annal_<ver>_x64-setup.exe
```

Build pipeline: `npm run build` (frontend) → cargo release compile (Rust) → tauri-bundler packages the installer.

## 🏷 Release Process

The version in `package.json` is the single source of truth; npm lifecycle hooks sync it into `package-lock.json`, `src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock` automatically:

```bash
git pull               # keep the worktree clean first (npm version requires it)
npm version patch      # or minor / major: syncs the manifests and creates a v<version> tag
git push --follow-tags # the tag triggers GitHub Actions to build the NSIS installer and publish a Release
```

The version shown on the settings page is injected at build time via the Vite `define` (`__APP_VERSION__`) — no version string is hardcoded anywhere. Notable changes per release are tracked in [CHANGELOG.md](CHANGELOG.md).

## 🗂 Data & Storage

- Each note is a standalone `.md` file; you pick its location
- Metadata (id, title, timestamps, path) lives in `index.json`; your text always stays in plain sight
- Version history lives under `versions/` (pointer records + content-addressed `blobs/`, large blobs auto-compressed)
- Image attachments live under `attachments/`

The app data directory is managed by the OS (Windows: `%APPDATA%\com.annal.desktop`,
macOS: `~/Library/Application Support/com.annal.desktop`,
Linux: `~/.local/share/com.annal.desktop`).

## 🧱 Project Structure

```
├── index.html            # UI skeleton (titlebar / sidebar / editor / outline / overlays)
├── src/                  # Frontend (framework-free, signal-driven)
│   ├── editor.ts         # CodeMirror 6 editor
│   ├── liveRender.ts     # Live rendering (Lezer-syntax-tree-driven viewport decorations)
│   ├── markdownModel.ts  # Block model + Markdown rendering (incremental)
│   ├── sidebar.ts        # Sidebar (notes / external files / search / multi-select)
│   ├── outline.ts        # Document outline
│   ├── history.ts        # Version history panel (compare / restore)
│   ├── i18n.ts           # Internationalization (zh-CN / en-US)
│   └── app/              # Composition root & app coordinators (save / sync / settings / window)
├── scripts/              # Utility scripts (version sync, etc.)
└── src-tauri/
    ├── src/lib.rs        # Rust backend: note CRUD + version history + search + file sync
    ├── tauri.conf.json   # App configuration
    └── windows/          # NSIS installer hooks
```

## 🤝 Contributing

Issues and pull requests are welcome. Please make sure `npx tsc --noEmit` passes before submitting; UI strings and code comments are written in Chinese.

## 📄 License

This project is released under the [GNU GPL v3](LICENSE) (SPDX: `GPL-3.0-or-later`).
You are free to use, modify and redistribute it, but any derivative work must be open-sourced under the same GPL-3.0 terms.

Copyright © 2026 yilv

## 🗺 Roadmap

- [ ] Tags / folders
- [ ] Multiple windows
- [ ] Mobile sync
