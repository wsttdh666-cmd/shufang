/* 阅读器：书架里点“阅读”打开。左右翻页（点两侧或左右滑），目录跳章，
   复制整章，长按某一段复制那一段。读到哪一章哪一页会记住。 */
(() => {
  "use strict";
  const GAP = 36;                       // 两页之间的间隔，等于左右留白之和
  const HEAD = /^\s*(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章节回卷集部篇话].{0,40}|chapter\s+\d+.{0,40}|序章?|楔子|引子|前言|后记|尾声|终章|番外.{0,30})\s*$/i;
  let cur = null;                       // {id, name, chapters:[{title, lines}], ch, page, pages}
  let fontSize = 18;
  try { fontSize = +localStorage.getItem("sf:read:font") || 18; } catch(e){}

  /* ---------- 把整本书切成章 ---------- */
  function split(text){
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const marks = [];
    for (let i = 0; i < lines.length; i++){
      const s = lines[i].trim();
      if (!s || s.length > 45) continue;
      // 写着“第几章”的行；或者前面空两行、后面空一行的短行（导书存下来的书是这个格式）
      const spaced = i >= 2 && !lines[i - 1].trim() && !lines[i - 2].trim() && i + 1 < lines.length && !lines[i + 1].trim();
      if (HEAD.test(s) || spaced) marks.push(i);
    }
    const chapters = [];
    if (marks.length >= 2){
      const pre = lines.slice(0, marks[0]).filter(l => l.trim());
      if (pre.length) chapters.push({title: "开头", lines: pre});
      marks.forEach((at, k) => {
        const body = lines.slice(at + 1, k + 1 < marks.length ? marks[k + 1] : lines.length).filter(l => l.trim());
        chapters.push({title: lines[at].trim(), lines: body});
      });
    } else {
      // 认不出章节：按大约 3000 字一段来分
      let buf = [], n = 0;
      const flush = () => { if (buf.length){ chapters.push({title: "第 " + (chapters.length + 1) + " 段", lines: buf}); buf = []; n = 0; } };
      for (const l of lines){ if (!l.trim()) continue; buf.push(l); n += l.length; if (n >= 3000) flush(); }
      flush();
    }
    if (!chapters.length) chapters.push({title: "（空）", lines: []});
    return chapters;
  }

  /* ---------- 小工具 ---------- */
  let toastTimer = 0;
  function toast(msg){
    const t = $("rdToast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }
  async function copy(text, okMsg){
    try { await navigator.clipboard.writeText(text); toast(okMsg); return; } catch(e){}
    try {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove();
      toast(ok ? okMsg : "复制失败");
    } catch(e){ toast("复制失败"); }
  }
  function remember(){
    if (!cur) return;
    try { localStorage.setItem("sf:read:" + cur.id, JSON.stringify({ch: cur.ch, page: cur.page})); } catch(e){}
  }

  /* ---------- 排版和翻页 ---------- */
  function pageWidth(){ return $("rdBody").clientWidth - GAP; }
  function layout(){
    const box = $("rdText"), w = pageWidth();
    box.style.fontSize = fontSize + "px";
    box.style.columnWidth = w + "px";
    box.style.columnGap = GAP + "px";
    cur.pages = Math.max(1, Math.round((box.scrollWidth + GAP) / (w + GAP)));
    if (cur.page >= cur.pages) cur.page = cur.pages - 1;
    if (cur.page < 0) cur.page = 0;
    place();
  }
  function place(){
    $("rdText").style.transform = "translateX(" + (-cur.page * (pageWidth() + GAP)) + "px)";
    $("rdPos").textContent = (cur.ch + 1) + " / " + cur.chapters.length + " 章 · 第 " + (cur.page + 1) + " / " + cur.pages + " 页";
    $("rdPrev").disabled = cur.ch === 0;
    $("rdNext").disabled = cur.ch === cur.chapters.length - 1;
    remember();
  }
  function render(page){
    const c = cur.chapters[cur.ch], box = $("rdText");
    box.textContent = "";
    box.style.transform = "translateX(0)";
    box.append(el("h3", null, c.title));
    const frag = document.createDocumentFragment();
    for (const l of c.lines) frag.append(el("p", null, l.trim()));
    if (!c.lines.length) frag.append(el("p", "empty", "（这一章没有正文）"));
    box.append(frag);
    $("rdTitle").textContent = c.title;
    cur.page = page === "last" ? 1e9 : (page || 0);
    layout();
  }
  function goChapter(i, page){
    if (i < 0 || i >= cur.chapters.length) return false;
    cur.ch = i; render(page); return true;
  }
  function turn(d){
    if (!cur) return;
    const p = cur.page + d;
    if (p >= 0 && p < cur.pages){ cur.page = p; place(); return; }
    if (d > 0){ if (!goChapter(cur.ch + 1, 0)) toast("已经是最后一页"); }
    else if (!goChapter(cur.ch - 1, "last")) toast("已经是第一页");
  }

  /* ---------- 打开 / 关闭 ---------- */
  async function open(b){
    let text;
    try { text = await bookText(b.id); } catch(e){ $("shelfMsg").textContent = "这本书打不开：" + ((e && e.message) || e); return; }
    if (!text || !String(text).trim()){ $("shelfMsg").textContent = "这本书是空的。"; return; }
    cur = {id: b.id, name: b.name, chapters: split(text), ch: 0, page: 0, pages: 1};
    let at = null;
    try { at = JSON.parse(localStorage.getItem("sf:read:" + b.id) || "null"); } catch(e){}
    if (at && at.ch >= 0 && at.ch < cur.chapters.length) cur.ch = at.ch;
    $("rdToc").hidden = true;
    $("reader").hidden = false;
    document.body.style.overflow = "hidden";
    try { history.pushState({reader: 1}, ""); } catch(e){}
    render(at && at.ch === cur.ch ? at.page : 0);
  }
  function close(fromBack){
    if (!cur) return;
    cur = null;
    $("reader").hidden = true; $("rdText").textContent = "";
    document.body.style.overflow = "";
    if (!fromBack){ try { if (history.state && history.state.reader) history.back(); } catch(e){} }
  }
  // 手机的返回键：目录开着就先关目录，否则退出阅读
  window.addEventListener("popstate", () => {
    if (!cur) return;
    if (!$("rdToc").hidden){ $("rdToc").hidden = true; try { history.pushState({reader: 1}, ""); } catch(e){} return; }
    close(true);
  });
  window.addEventListener("resize", () => { if (cur) layout(); });

  /* ---------- 目录 ---------- */
  function openToc(){
    const box = $("rdTocList"); box.textContent = "";
    const frag = document.createDocumentFragment(); let here = null;
    cur.chapters.forEach((c, i) => {
      const b = el("button", i === cur.ch ? "on" : "", c.title);
      b.onclick = () => { $("rdToc").hidden = true; goChapter(i, 0); };
      if (i === cur.ch) here = b;
      frag.append(b);
    });
    box.append(frag);
    $("rdToc").hidden = false;
    if (here) here.scrollIntoView({block: "center"});
  }

  /* ---------- 按钮 ---------- */
  $("rdClose").onclick = () => close(false);
  $("rdTocBtn").onclick = openToc;
  $("rdTocClose").onclick = () => { $("rdToc").hidden = true; };
  $("rdPrev").onclick = () => goChapter(cur.ch - 1, 0);
  $("rdNext").onclick = () => goChapter(cur.ch + 1, 0);
  $("rdCopy").onclick = () => {
    const c = cur.chapters[cur.ch];
    copy(c.title + "\n\n" + c.lines.map(l => l.trim()).join("\n"), "已复制这一章（" + c.lines.join("").length + " 字）");
  };
  function setFont(d){
    fontSize = Math.max(14, Math.min(28, fontSize + d));
    try { localStorage.setItem("sf:read:font", fontSize); } catch(e){}
    // 字号变了页数会变，尽量留在原来读到的位置
    const ratio = cur.pages > 1 ? cur.page / (cur.pages - 1) : 0;
    layout(); cur.page = Math.round(ratio * (cur.pages - 1)); place();
  }
  $("rdSmaller").onclick = () => setFont(-1);
  $("rdBigger").onclick = () => setFont(1);

  /* ---------- 翻页手势、长按复制一段 ---------- */
  const body = $("rdBody");
  let sx = 0, sy = 0, moved = false, pressTimer = 0, swallow = false, lit = null;
  function unlit(){ if (lit){ lit.classList.remove("lit"); lit = null; } }
  body.addEventListener("touchstart", e => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; moved = false; swallow = false;
    const p = e.target.closest ? e.target.closest("#rdText p, #rdText h3") : null;
    clearTimeout(pressTimer);
    if (p && !p.classList.contains("empty")) pressTimer = setTimeout(() => {
      if (moved) return;
      swallow = true; lit = p; p.classList.add("lit");
      copy(p.textContent, "已复制这一段");
      setTimeout(unlit, 900);
    }, 550);
  }, {passive: true});
  body.addEventListener("touchmove", e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10){ moved = true; clearTimeout(pressTimer); }
  }, {passive: true});
  body.addEventListener("touchend", e => {
    clearTimeout(pressTimer);
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (swallow) return;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5){ swallow = true; turn(dx < 0 ? 1 : -1); }
  });
  body.addEventListener("touchcancel", () => { clearTimeout(pressTimer); });
  body.addEventListener("contextmenu", e => e.preventDefault());   // 不弹系统的长按菜单
  // 点左边三分之一上一页，点右边三分之一下一页
  body.addEventListener("click", e => {
    if (swallow){ swallow = false; return; }
    const r = body.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    if (x < 0.34) turn(-1); else if (x > 0.66) turn(1);
  });
  document.addEventListener("keydown", e => {
    if (!cur) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") turn(-1);
    else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") turn(1);
    else if (e.key === "Escape") close(false);
  });

  window.openReader = open;
})();
