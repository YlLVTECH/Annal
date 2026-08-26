const fs = require('fs');
let css = fs.readFileSync('src/styles.css', 'utf8');

// 1. Add sidebar-tabs + sidebar-pane styles after #sidebar closing }
css = css.replace(
  '#sidebar {\n  width: 260px;\n  min-width: 210px;\n  display: flex;\n  flex-direction: column;\n  background-color: var(--bg-app);\n  border-right: 1px solid var(--border-soft);\n  transition: background-color 0.18s ease, border-color 0.18s ease;\n}',
  `#sidebar {
  width: 260px;
  min-width: 210px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-app);
  border-right: 1px solid var(--border-soft);
  transition: background-color 0.18s ease, border-color 0.18s ease;
}

/* ---------- 侧栏标签栏（笔记 / 大纲切换） ---------- */
.sidebar-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}

.sidebar-tab {
  flex: 1;
  padding: 9px 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.sidebar-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.sidebar-tab:hover:not(.active) {
  color: var(--text);
}

/* ---------- 侧栏面板容器 ---------- */
.sidebar-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-pane[hidden] {
  display: none !important;
}`
);

// 2. Replace #outline panel CSS with #outline-pane
css = css.replace(
  /\/\* ---------- 大纲面板（编辑器右侧目录树） ---------- \*\//,
  '/* ---------- 大纲面板（侧栏内嵌面板） ---------- */'
);
css = css.replace(
  '#outline {\n  width: 218px;\n  flex-shrink: 0;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  border-left: 1px solid var(--border-soft);\n  background: var(--bg-pane);\n  transition: background-color 0.18s ease, border-color 0.18s ease;\n}',
  `#outline-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-pane);
  border-top: 1px solid var(--border-soft);
  transition: background-color 0.18s ease, border-color 0.18s ease;
}`
);

// 3. Remove outline-toggle.active CSS and narrow-screen outline rules
css = css.replace(
  /\n\/\* 工具栏大纲开关：激活\（面板可见\）时强调色 \*\/\n#outline-toggle\.active \{[^}]+\}\n\n\/\* 中窄屏空间紧张，隐藏大纲面板与开关，避免挤压编辑区 \*\/\n@media \(max-width: 720px\) \{\n  #outline,\n  #outline-toggle \{\n    display: none !important;\n  }\n\}\n/,
  '\n'
);

fs.writeFileSync('src/styles.css', css);
console.log('CSS updated successfully');
