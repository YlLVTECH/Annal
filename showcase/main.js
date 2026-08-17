/* ============================================================
   极简笔记 · 展示页脚本 —— 原生 JS，无框架
   墨迹晕染 / 阴阳主题 / 落笔演示 / 滚动揭示 / 章节导航
   ============================================================ */
(() => {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;

  /* ----------------------------------------------------------
   * 一、阴阳主题（宣纸 / 碑拓）
   * -------------------------------------------------------- */
  const THEME_KEY = "notebook:showcase:theme";

  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "dark" || savedTheme === "light") {
    root.dataset.theme = savedTheme === "dark" ? "dark" : "";
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    root.dataset.theme = "dark";
  }

  function inkRGB() {
    const v = getComputedStyle(root).getPropertyValue("--ink-rgb").trim();
    return v || "38, 36, 31";
  }

  function toggleTheme() {
    const dark = root.dataset.theme !== "dark";
    root.dataset.theme = dark ? "dark" : "";
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }

  $("#themeToggle").addEventListener("click", toggleTheme);

  const taiji = $("#taiji");
  if (taiji) {
    taiji.addEventListener("click", toggleTheme);
    taiji.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTheme();
      }
    });
  }

  /* ----------------------------------------------------------
   * 二、卷首墨迹画布：墨滴落纸，晕化洇边
   * -------------------------------------------------------- */
  const hero = $("#dao");
  const canvas = $("#ink");
  const ctx = canvas.getContext("2d");
  const blots = [];
  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = hero.clientWidth;
    H = hero.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeBlot(x, y, maxR, alpha) {
    const pts = [];
    const n = 24 + (Math.random() * 10) | 0;
    for (let i = 0; i < n; i++) {
      pts.push({
        ang: Math.random() * Math.PI * 2,
        dist: 0.72 + Math.random() * 0.4,
        rr: 0.015 + Math.random() * 0.07,
      });
    }
    return { x, y, r: maxR * 0.12, maxR, a: alpha, a0: alpha, pts };
  }

  function spawn(x, y, maxR, alpha) {
    blots.push(makeBlot(x, y, maxR, alpha));
    if (blots.length > 22) blots.shift();
  }

  function frame() {
    ctx.clearRect(0, 0, W, H);
    const ink = inkRGB();
    for (const b of blots) {
      if (b.r < b.maxR) {
        b.r += (b.maxR - b.r) * 0.028 + 0.25;   // 晕开
      } else if (b.a > b.a0 * 0.45) {
        b.a *= 0.9985;                          // 墨沉
      }
      // 主晕
      const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.1, b.x, b.y, b.r);
      g.addColorStop(0, `rgba(${ink},${b.a})`);
      g.addColorStop(0.75, `rgba(${ink},${b.a * 0.55})`);
      g.addColorStop(1, `rgba(${ink},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, 7);
      ctx.fill();
      // 洇边（锯齿状水痕）
      for (const p of b.pts) {
        const px = b.x + Math.cos(p.ang) * b.r * p.dist;
        const py = b.y + Math.sin(p.ang) * b.r * p.dist;
        const pr = Math.max(b.r * p.rr, 0.6);
        const gg = ctx.createRadialGradient(px, py, 0, px, py, pr);
        gg.addColorStop(0, `rgba(${ink},${b.a * 0.5})`);
        gg.addColorStop(1, `rgba(${ink},0)`);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, 7);
        ctx.fill();
      }
    }
    window.requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);

  // 初始几笔淡墨
  for (let i = 0; i < 4; i++) {
    spawn(
      Math.random() * W,
      Math.random() * H * 0.8,
      60 + Math.random() * 110,
      0.035 + Math.random() * 0.045
    );
  }
  window.requestAnimationFrame(frame);

  if (!reduceMotion) {
    // 间或有墨自落
    window.setInterval(() => {
      spawn(
        Math.random() * W,
        Math.random() * H,
        50 + Math.random() * 110,
        0.03 + Math.random() * 0.05
      );
    }, 2600);

    // 鼠标过处，微痕相随
    let last = null;
    hero.addEventListener("pointermove", (e) => {
      const rect = hero.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!last || Math.hypot(x - last.x, y - last.y) > 110) {
        spawn(x, y, 7 + Math.random() * 12, 0.05);
        last = { x, y };
      }
    });

    // 点按落一大笔
    hero.addEventListener("pointerdown", (e) => {
      const rect = hero.getBoundingClientRect();
      spawn(
        e.clientX - rect.left,
        e.clientY - rect.top,
        60 + Math.random() * 80,
        0.09
      );
    });
  }

  /* ----------------------------------------------------------
   * 三、滚动揭示
   * -------------------------------------------------------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.16 });
  $$(".reveal").forEach((el) => io.observe(el));

  /* ----------------------------------------------------------
   * 四、章节导航高亮
   * -------------------------------------------------------- */
  const links = $$(".side-nav a");
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        links.forEach((l) => l.classList.toggle("act", l.dataset.sec === e.target.id));
      }
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  ["dao", "xu", "yi", "er", "san", "wan"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) spy.observe(el);
  });

  /* ----------------------------------------------------------
   * 五、落笔演示：模拟输入 + 防抖自动保存 + 字数统计
   * -------------------------------------------------------- */
  const DEMO = [
    "# 山间日记",
    "",
    "今日雨。檐下煮茶，读《道德经》至四十二章：",
    "",
    "「道生一，一生二，二生三，三生万物。」",
    "",
    "忽有所悟 —— **简**，不是少，而是恰好。",
    "",
    "- 一篇笔记",
    "- 一个文件",
    "- 别无他物",
  ].join("\n");

  const demoText = $("#demoText");
  const caret = $("#caret");
  const demoSave = $("#demoSave");
  const demoCount = $("#demoCount");

  function countChars(text) {
    return Array.from(text.replace(/\s/g, "")).length;
  }

  if (reduceMotion) {
    // 静观：直接呈现全文
    demoText.textContent = DEMO;
    demoText.appendChild(caret);
    demoCount.textContent = `共 ${countChars(DEMO)} 字`;
    demoSave.textContent = "已自动保存";
    demoSave.classList.add("saved");
  } else {
    let typed = "";
    let saveTimer = null;
    let demoVisible = false;
    let started = false;

    // 演示窗口进入视野时才开始落笔
    const demoIO = new IntersectionObserver((entries) => {
      demoVisible = entries[0].isIntersecting;
      if (demoVisible && !started) {
        started = true;
        tick();
      }
    }, { threshold: 0.3 });
    demoIO.observe($("#demo"));

    function render() {
      demoText.textContent = typed;
      demoText.appendChild(caret);
      demoCount.textContent = `共 ${countChars(typed)} 字`;
    }

    function markSaved() {
      demoSave.textContent = "已自动保存";
      demoSave.classList.add("saved");
    }

    function scheduleSave() {
      demoSave.textContent = "书写中…";
      demoSave.classList.remove("saved");
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(markSaved, 500); // 与产品一致：防抖 500ms
    }

    function tick() {
      if (!demoVisible) {           // 离屏暂停，回屏续写
        window.setTimeout(tick, 600);
        return;
      }
      if (typed.length < DEMO.length) {
        typed += DEMO[typed.length];
        render();
        scheduleSave();
        const ch = typed[typed.length - 1];
        const pause = ch === "\n" ? 200 : /[。！？：」]/.test(ch) ? 260 : 55 + Math.random() * 90;
        window.setTimeout(tick, pause);
      } else {
        markSaved();
        window.setTimeout(() => {   // 搁笔片刻，另起一页
          typed = "";
          render();
          demoSave.textContent = "就绪";
          demoSave.classList.remove("saved");
          window.setTimeout(tick, 900);
        }, 3400);
      }
    }
  }
})();
