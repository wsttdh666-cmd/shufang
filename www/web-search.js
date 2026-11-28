/* web-search.js: 在线站点搜书 → 预览 → 选章节 → 下载
   加载时机：在 index.html 主脚本和 reader.js 之后，共享全局的
   $, el, NATIVE, decode, http, bookAdd, bookText, loadBooks, show, fmtChars, fileOut, safe, openReader */
(() => {
  "use strict";

  const UA = navigator.userAgent;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ============================================================
     工具函数
     ============================================================ */

  // 超时包装：原生请求有时会卡住不返回，到点就当连不上处理，避免整页干等
  function withTimeout(promise, ms) {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("连不上：超时")), ms); });
    return Promise.race([promise, timer]).finally(() => clearTimeout(t));
  }

  async function fetchPage(url, timeout = 9000) {
    let html;
    if (NATIVE) {
      let r;
      try {
        r = await withTimeout(Capacitor.nativePromise("AppTools", "get", { url, redirect: true, ua: UA }), timeout);
      } catch (e) {
        throw new Error("连不上：" + ((e && e.message) || e));
      }
      if ([403, 429, 503].includes(r.status))
        throw new Error("网站拦了请求（HTTP " + r.status + "），可能需要人机验证或稍后再试");
      if (r.status === 301 || r.status === 302) {
        const loc = r.location || "";
        if (loc) return fetchPage(loc.startsWith("http") ? loc : new URL(loc, url).href, timeout);
        throw new Error("网站跳转了但没给新地址（HTTP " + r.status + "）");
      }
      if (r.status !== 200) throw new Error("HTTP " + r.status);
      const bytes = r.data
        ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0))
        : new Uint8Array(0);
      html = decode(bytes);
    } else {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeout);
      let res;
      try { res = await fetch(url, { signal: ctrl.signal }); }
      catch (e) { throw new Error("连不上：" + ((e && e.message) || e)); }
      finally { clearTimeout(to); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      html = await res.text();
    }
    return { html, doc: new DOMParser().parseFromString(html, "text/html") };
  }

  function cleanStr(s) {
    return String(s || "")
      .replace(/[​‌‍⁠﻿]/g, "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textOf(node) {
    if (!node) return "";
    const c = node.cloneNode(true);
    c.querySelectorAll("script, style, noscript, iframe").forEach(n => n.remove());
    c.querySelectorAll("br").forEach(n => n.replaceWith("\n"));
    c.querySelectorAll("p, div, li, h1, h2, h3, h4").forEach(n => n.append("\n"));
    return String(c.textContent || "")
      .split("\n").map(s => s.trim()).join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, "")
      .replace(/[​‌‍⁠﻿]/g, "")
      .replace(/ /g, " ");
  }

  /* ============================================================
     解析规则：笔趣阁通用 —— 覆盖绝大多数镜像站
     ============================================================ */

  const RULE_BIQUGE = {
    name: "笔趣阁通用",

    /* 解析搜索结果页 */
    search(doc, baseUrl) {
      const results = [];
      // 多种常见搜索结果布局
      let items = doc.querySelectorAll(".novelslist2 li, .result-list .result-item, .bookbox, #sitembox .bookbox");
      if (!items.length) items = doc.querySelectorAll("#main .grid tr:not(:first-child), #main table tbody tr");
      if (!items.length) items = doc.querySelectorAll(".search-list li, .search-result-list li, #main li");
      // 兜底：body 下的结构性 div
      if (!items.length) items = doc.querySelectorAll("#content .item, .book-list .item, .result .item");

      for (const item of items) {
        const a = item.querySelector("a[href]");
        if (!a) continue;
        const href = a.getAttribute("href");
        if (!href || href === "#" || href === "/") continue;
        const title = cleanStr(a.textContent);
        if (!title || title.length > 60) continue;

        let author = "";
        for (const sel of [".s4", ".author", "[class*=author]", "span:nth-child(3)", "td:nth-child(3)"]) {
          const e = item.querySelector(sel);
          if (e) { author = cleanStr(e.textContent).replace(/^作者[：:]\s*/, ""); break; }
        }

        let latest = "";
        for (const sel of [".s3 a", ".update a", "[class*=latest]", "[class*=update]", "td:nth-child(2) a"]) {
          const e = item.querySelector(sel);
          if (e) { latest = cleanStr(e.textContent); break; }
        }

        let bookUrl;
        try { bookUrl = new URL(href, baseUrl).href; } catch (e) { continue; }

        results.push({ title, author, latest, url: bookUrl });
      }
      return results;
    },

    /* 解析书籍信息页 */
    book(doc, pageUrl) {
      // 书名
      let title = "";
      for (const sel of ["#info h1", ".book-info h1", ".bookname h1", "h1.booktitle", ".book_name h1", "#maininfo h1"]) {
        const e = doc.querySelector(sel);
        if (e && e.textContent.trim().length < 60) { title = cleanStr(e.textContent); break; }
      }
      if (!title) {
        const h1 = doc.querySelector("h1");
        if (h1 && h1.textContent.trim().length < 60) title = cleanStr(h1.textContent);
      }

      // 作者
      let author = "";
      for (const sel of ["#info p", "#info .small span", ".book-info .author", "#maininfo p", ".book_info span", "#info span"]) {
        const e = doc.querySelector(sel);
        if (e) {
          const t = cleanStr(e.textContent);
          const m = t.match(/作者[：:]\s*(\S+)/);
          if (m) { author = m[1]; break; }
        }
      }

      // 简介
      let intro = "";
      for (const sel of ["#intro", ".book-intro", ".intro", "#bookintro", ".book_intro", "#intro p"]) {
        const e = doc.querySelector(sel);
        if (e) { intro = textOf(e).slice(0, 2000); break; }
      }

      // 状态、字数
      let status = "", words = "";
      const infoText = (doc.querySelector("#info") || doc.querySelector(".book-info") || doc.querySelector("#maininfo") || {}).textContent || "";
      if (/连载/.test(infoText)) status = "连载中";
      else if (/完结|完本/.test(infoText)) status = "已完结";
      const wm = infoText.match(/([\d.]+)\s*万字/);
      if (wm) words = wm[1] + " 万字";

      // 目录
      const chapters = [];
      let links = doc.querySelectorAll("#list dd a, .listmain dd a, #chapterList a, .chapter-list a, .list-chapter a, #list-chapterAll dd a");
      if (!links.length) links = doc.querySelectorAll("#list a, .listmain a, .zjlist a, #chapterlist a");
      // 有些站把 dt（卷名）和 dd（章节）混在一起，dt 里的 a 通常不是章节
      let num = 0;
      for (const a of links) {
        const href = a.getAttribute("href");
        if (!href || href === "#" || href === "javascript:void(0)") continue;
        const name = cleanStr(a.textContent);
        if (!name || name.length > 80) continue;
        // 跳过"展开全部""查看更多"之类
        if (/展开|查看更多|点击加载|最新章节/.test(name)) continue;
        num++;
        let chUrl;
        try { chUrl = new URL(href, pageUrl).href; } catch (e) { continue; }
        chapters.push({ num, name, url: chUrl, state: "可导", pick: true });
      }

      return { title, author, intro, status, words, chapters };
    },

    /* 解析章节正文 */
    chapter(doc) {
      let content = null;
      for (const sel of ["#content", "#chaptercontent", ".content", "#BookText", ".chapter_content",
        ".read-content", "#htmlContent", "#TextContent", "#chapter_content"]) {
        content = doc.querySelector(sel);
        if (content && content.textContent.trim().length > 50) break;
        content = null;
      }
      if (!content) return { text: "" };

      // 删广告、脚本、导航
      content.querySelectorAll(
        "script, style, .ads, .ad, [class*=adsbygoogle], [class*=recommend], " +
        "[class*=share], iframe, ins, [class*=bottem], [class*=readinline], " +
        ".copy, .chapter-nav, .page-nav"
      ).forEach(n => n.remove());

      // 删掉带广告特征的链接
      content.querySelectorAll("a").forEach(n => {
        const t = n.textContent.trim();
        if (t.length < 5 || /笔趣|下一|上一|返回|目录|www\.|\.com|\.net|\.cc|首页|书架/.test(t)) n.remove();
      });

      let text = textOf(content);

      // 清除常见广告水印
      const adPatterns = [
        /笔趣阁.{0,30}(?:更新|最快|首发|www|biquge)/gi,
        /手机端.{0,40}阅读/g,
        /本章未完.{0,30}(?:点击|请翻)/g,
        /请记住.{0,80}(?:网址|地址|域名)/g,
        /最新网址.{0,60}/g,
        /天才一秒记住.{0,80}/g,
        /一秒记住.{0,80}/g,
        /(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|net|cc|la|so|xyz|cx|me)\/?/gi,
        /本站网址.{0,60}/g,
        /百度搜索.{0,40}/g,
        /推荐阅读.{0,80}/g,
        /收藏本站.{0,40}/g,
        /加入书签.{0,20}/g,
      ];
      for (const p of adPatterns) text = text.replace(p, "");
      text = text.replace(/\n{3,}/g, "\n\n").trim();

      return { text };
    }
  };

  const RULES = { biquge: RULE_BIQUGE };

  /* ============================================================
     源站配置
     ============================================================ */

  // 默认源站：域名经常变，打不开就到"密钥"里改地址或用"测试搜索"找对路径。
  // 搜索路径按笔趣阁家族最常见的几种格式预设，可能需要按站点微调。
  const DEFAULT_SOURCES = [
    { id: "bixia", name: "笔下文学", base: "https://www.bixia01.cc", searchPath: "/s?q={kw}", type: "biquge", enabled: true },
    { id: "18shuw", name: "18书屋", base: "https://www.18shuw.com", searchPath: "/search.php?keyword={kw}", type: "biquge", enabled: true },
    { id: "69shuba", name: "69书吧", base: "https://www.69shuba.cx", searchPath: "/modules/article/search.php?searchkey={kw}", type: "biquge", enabled: true },
    { id: "biquge", name: "笔趣阁", base: "https://www.biqg.cc", searchPath: "/s?q={kw}", type: "biquge", enabled: true },
  ];

  let sources = [];
  try {
    const saved = JSON.parse(localStorage.getItem("sf:websrc") || "null");
    sources = Array.isArray(saved) && saved.length ? saved : DEFAULT_SOURCES.map(s => Object.assign({}, s));
  } catch (e) {
    sources = DEFAULT_SOURCES.map(s => Object.assign({}, s));
  }
  function saveSources() {
    try { localStorage.setItem("sf:websrc", JSON.stringify(sources)); } catch (e) { }
  }

  /* ============================================================
     搜索引擎
     ============================================================ */

  // 笔趣阁家族常见的搜索路径，配置路径搜不到时按顺序再试
  const FALLBACK_PATHS = [
    "/s?q={kw}", "/search.php?keyword={kw}", "/search.php?q={kw}",
    "/modules/article/search.php?searchkey={kw}", "/search.html?q={kw}", "/search/{kw}.html"
  ];

  async function searchOne(src, keyword) {
    const rule = RULES[src.type || "biquge"];
    if (!rule) return [];
    const base = src.base.replace(/\/+$/, "");
    // 配置路径优先；域名活着但没搜到时，再试最多 2 个常见路径（最多 3 条，保证够快）
    const paths = [src.searchPath];
    for (const p of FALLBACK_PATHS) { if (paths.length >= 3) break; if (!paths.includes(p)) paths.push(p); }

    for (let i = 0; i < paths.length; i++) {
      const url = base + paths[i].replace("{kw}", encodeURIComponent(keyword));
      let doc;
      try {
        doc = (await fetchPage(url)).doc;
      } catch (e) {
        // 第一条路径就连不上/超时/被拦 → 域名多半是死的，立刻放弃，不再逐条干等
        if (i === 0) throw e;
        continue;   // 域名活着、只是这条路径不对，试下一条
      }
      const results = rule.search(doc, src.base);
      if (results.length) return results.map(r => Object.assign(r, { source: src }));
    }
    return [];
  }

  async function searchAll(keyword) {
    const enabled = sources.filter(s => s.enabled);
    if (!enabled.length) return { results: [], errors: ['没有启用的源站。到"密钥"页面添加或启用源站。'] };
    const errors = [];
    const promises = enabled.map(s =>
      searchOne(s, keyword).catch(e => {
        errors.push(s.name + "：" + ((e && e.message) || String(e)));
        return [];
      })
    );
    const all = (await Promise.all(promises)).flat();
    // 去重：相同标题+作者只留第一个
    const seen = new Set();
    const unique = [];
    for (const r of all) {
      const key = r.title + "|" + (r.author || "");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    return { results: unique, errors };
  }

  /* ============================================================
     书籍详情与章节下载
     ============================================================ */

  async function loadWebBook(source, url) {
    const rule = RULES[source.type || "biquge"];
    if (!rule) throw new Error("不支持的源站类型");
    const { doc } = await fetchPage(url);
    const book = rule.book(doc, url);
    if (!book.title) throw new Error("没有在页面上找到书名，可能这个站的结构变了");
    if (!book.chapters.length) throw new Error("没有找到章节目录");
    book.url = url;
    book.source = source;
    return book;
  }

  async function downloadChapter(source, chUrl) {
    const rule = RULES[source.type || "biquge"];
    if (!rule) throw new Error("不支持的源站类型");
    const { doc } = await fetchPage(chUrl);
    return rule.chapter(doc);
  }

  /* ============================================================
     UI 状态
     ============================================================ */

  let webResults = [];
  let webBook = null;
  let webRun = null;

  const ST = { wait: "·", ok: "✓", fail: "✗", busy: "…" };

  function setWebMsg(id, text, kind) {
    const e = $(id);
    e.textContent = text;
    e.className = "note" + (kind ? " " + kind : "");
    e.hidden = !text;
  }

  /* ============================================================
     统一搜索：一次搜网盘 + 在线站点，结果用标签筛选
     ============================================================ */

  // 原网盘搜索（index.html 里的 doSearch）：搜完结果在全局 PAN 里、渲染到 panBox
  const _origPanSearch = window.doSearch;

  let filter = "all";                 // all | pan | web
  try { filter = localStorage.getItem("sf:filter") || "all"; } catch (e) { }
  let searchDone = false;
  let webErr = [];

  function panCount() {
    try { return (PAN.good ? PAN.good.length : 0) + (PAN.rest ? PAN.rest.length : 0); }
    catch (e) { return 0; }
  }

  function applyFilter() {
    for (const b of document.querySelectorAll("[data-filter]"))
      b.setAttribute("aria-checked", b.dataset.filter === filter);
    if (!searchDone) return;

    const showPan = filter === "all" || filter === "pan";
    const showWeb = filter === "all" || filter === "web";
    // 正在看某本书的详情 / 下载进度时，不被筛选打断
    const inWebDrill = !$("webInfo").hidden || !$("webRun").hidden;

    $("panBox").hidden = !(showPan && panCount() > 0);
    if (!showWeb) {
      $("webBox").hidden = true;
      $("webInfo").hidden = true;
      $("webRun").hidden = true;
    } else if (!inWebDrill) {
      $("webBox").hidden = !(webResults.length > 0 || webErr.length > 0);
    }
  }

  function setFilter(f) {
    filter = f;
    try { localStorage.setItem("sf:filter", f); } catch (e) { }
    applyFilter();
  }

  for (const b of document.querySelectorAll("[data-filter]"))
    b.onclick = () => setFilter(b.dataset.filter);

  // 搜索按钮 / 回车：同时搜两边
  $("doSearch").onclick = doCombinedSearch;
  $("kw").onkeydown = e => { if (e.key === "Enter") doCombinedSearch(); };

  // 恢复保存的筛选高亮
  applyFilter();

  async function doCombinedSearch() {
    const kw = $("kw").value.trim();
    if (!kw) { $("searchMsg").textContent = "先输入书名或作者。"; return; }

    $("doSearch").disabled = true;
    $("searchMsg").textContent = "搜索中，可能要等十几秒…";
    $("webInfo").hidden = true;
    $("webRun").hidden = true;

    // 网盘搜索：index.html 的 doSearch 会自己把结果渲染到 panBox
    const panP = Promise.resolve()
      .then(() => _origPanSearch && _origPanSearch())
      .catch(() => { });
    // 在线站点搜索
    const webP = doWebSearchCore(kw).catch(e => {
      webErr = [String((e && e.message) || e)];
      webResults = [];
      renderWebResults();
    });

    await Promise.all([panP, webP]);

    searchDone = true;
    $("doSearch").disabled = false;
    $("searchMsg").textContent = "网盘 " + panCount() + " 条 · 在线站点 " + webResults.length + " 个。用上面的标签切换查看。";
    applyFilter();
  }

  /* ============================================================
     在线站点搜索
     ============================================================ */

  async function doWebSearchCore(kw) {
    webErr = [];
    webResults = [];
    if (!sources.some(s => s.enabled)) {
      webErr = ['没有启用的源站。到"密钥"页面添加或启用源站。'];
      renderWebResults();
      return;
    }
    const { results, errors } = await searchAll(kw);
    webResults = results;
    webErr = errors || [];
    renderWebResults();
  }

  function renderWebResults() {
    const box = $("webList");
    box.textContent = "";
    $("webCount").textContent = webResults.length + " 个";

    if (!webResults.length) {
      box.append(el("p", "hint", webErr.length
        ? "没搜到。" + webErr.join("；")
        : '没搜到结果。换个关键词，或到"密钥"里检查、添加源站。'));
    }

    for (const r of webResults) {
      if (r.error) continue;
      const d = el("div", "item");
      const t = el("div", "t");
      t.append(el("span", "tag", r.source.name));
      const a = el("button", "small primary", r.title);
      a.style.cssText = "text-align:left;white-space:normal;min-height:auto;padding:4px 8px;font-size:15px";
      a.onclick = () => openWebBook(r);
      t.append(a);
      d.append(t);

      const sub = [r.author, r.latest].filter(Boolean).join(" · ");
      if (sub) d.append(el("div", "s", sub));
      box.append(d);
    }
  }

  /* ============================================================
     书籍详情与章节选择
     ============================================================ */

  async function openWebBook(result) {
    $("webInfo").hidden = true;
    $("webRun").hidden = true;
    setWebMsg("webNotice", "正在加载书的信息和目录…");
    $("webNotice").hidden = false;

    try {
      webBook = await loadWebBook(result.source, result.url);
      showWebBook();
    } catch (e) {
      setWebMsg("webNotice", "加载失败：" + ((e && e.message) || e), "warn");
      $("webInfo").hidden = false;
      $("webTitle").textContent = result.title || "加载失败";
      $("webSite").textContent = result.source.name;
      $("webMeta").textContent = "";
      $("webIntro").textContent = "";
      $("webAvail").textContent = "";
      $("webChList").textContent = "";
    }
  }

  function showWebBook() {
    const b = webBook;
    $("webTitle").textContent = b.title;
    $("webSite").textContent = b.source.name;
    $("webMeta").textContent = [b.author && "作者：" + b.author, b.status, b.words, "目录 " + b.chapters.length + " 章"].filter(Boolean).join(" · ");
    $("webIntro").textContent = b.intro || "（没有简介）";
    $("webAvail").textContent = "共 " + b.chapters.length + " 章可下载。";
    setWebMsg("webNotice", "", "");

    const first = b.chapters[0] ? b.chapters[0].num : 1;
    const last = b.chapters[b.chapters.length - 1] ? b.chapters[b.chapters.length - 1].num : first;
    $("webFrom").value = first;
    $("webTo").value = last;
    $("webFrom").max = $("webTo").max = last;
    $("webAddShelf").textContent = "加入书架";

    drawWebPicks();
    $("webBox").hidden = true;        // 详情替换掉结果列表
    $("webInfo").hidden = false;
    $("webInfo").scrollIntoView({ block: "start" });
  }

  function drawWebPicks() {
    const b = webBook, box = $("webChList");
    box.textContent = "";
    const frag = document.createDocumentFragment();
    b.chapters.forEach((c, i) => {
      const row = el("label", "ck nocmt");
      const pk = el("input");
      pk.type = "checkbox";
      pk.checked = !!c.pick;
      pk.dataset.i = i;
      pk.setAttribute("aria-label", "下载 " + c.name);
      const nm = el("span", "nm", c.num + "  " + c.name);
      row.append(pk, nm);
      frag.append(row);
    });
    box.append(frag);
    countWebRange();
  }

  $("webChList").addEventListener("change", e => {
    const t = e.target;
    if (!t.dataset || t.dataset.i === undefined || !webBook) return;
    webBook.chapters[+t.dataset.i].pick = t.checked;
    countWebRange();
  });

  function webPicked() { return webBook ? webBook.chapters.filter(c => c.pick) : []; }

  function countWebRange() {
    if (!webBook) return;
    const p = webPicked();
    $("webRange").textContent = "已选 " + p.length + " 章。";
    $("webStart").disabled = !p.length;
  }

  function setWebAll(fn) {
    if (!webBook) return;
    webBook.chapters.forEach(c => fn(c));
    drawWebPicks();
  }

  $("webPickAll").onclick = $("webPickAll2").onclick = () => setWebAll(c => { c.pick = true; });
  $("webPickNone").onclick = $("webPickNone2").onclick = () => setWebAll(c => { c.pick = false; });
  $("webPickRange").onclick = () => {
    const f = +$("webFrom").value || 1, t = +$("webTo").value || 1e9;
    const lo = Math.min(f, t), hi = Math.max(f, t);
    setWebAll(c => { c.pick = c.num >= lo && c.num <= hi; });
  };

  $("webBackList").onclick = () => {
    if (webRun && webRun.active) return;
    $("webInfo").hidden = true;
    $("webRun").hidden = true;
    applyFilter();                    // 回到结果列表，遵守当前筛选
  };

  /* ============================================================
     加入书架（只存目录，不含正文）
     ============================================================ */

  $("webAddShelf").onclick = async () => {
    if (!webBook) return;
    const b = webBook;
    const lines = [
      b.title,
      "作者：" + (b.author || "未知") + "　来源：" + b.source.name + "　" + b.url,
      [b.status, b.words, "目录 " + b.chapters.length + " 章"].filter(Boolean).join(" · ")
    ];
    if (b.intro) lines.push("简介：\n" + b.intro);
    lines.push("目录：\n" + b.chapters.map(c => c.num + " " + c.name).join("\n"));
    try {
      await bookAdd(b.title, lines.join("\n\n") + "\n", "web-" + b.source.id + "-" + btoa(b.url).slice(0, 20),
        { kind: "catalog", platform: b.source.name, url: b.url, author: b.author, chapters: b.chapters.length });
      $("webAddShelf").textContent = "已在书架";
      setWebMsg("webNotice", "已加入书架。", "ok");
      try { await loadBooks(); } catch (e) { }
    } catch (e) {
      setWebMsg("webNotice", "没加进去：" + ((e && e.message) || e), "warn");
    }
  };

  /* ============================================================
     下载流程
     ============================================================ */

  $("webStart").onclick = () => {
    if (!webBook) return;
    const list = webPicked();
    if (!list.length) { setWebMsg("webNotice", "先勾选要下载的章节。", "warn"); return; }

    webRun = {
      book: webBook,
      list: list.map(c => Object.assign({}, c, { st: "wait", text: "", err: "" })),
      next: 0, active: false, stop: false, savedId: null
    };
    $("webInfo").hidden = true;
    $("webBox").hidden = true;
    $("webRun").hidden = false;
    $("webDone").hidden = true;
    webLoop();
  };

  $("webPause").onclick = () => {
    if (webRun) { webRun.stop = true; setWebMsg("webRunMsg", "这一章下完就暂停…"); }
  };
  $("webResume").onclick = () => webLoop();
  $("webRunBack").onclick = () => {
    if (webRun && webRun.active) return;
    $("webRun").hidden = true;
    if (webBook) $("webInfo").hidden = false;
  };

  function drawWebRun() {
    const r = webRun, n = r.list.length;
    let ok = 0, fail = 0;
    r.list.forEach(x => { if (x.st === "ok") ok++; if (x.st === "fail") fail++; });

    $("webRunTitle").textContent = "《" + r.book.title + "》 " + r.book.source.name;
    $("webRunCount").textContent = "已下载 " + ok + " / " + n + " 章" + (fail ? " · 失败 " + fail + " 章" : "");
    $("webRunBar").style.width = Math.round(100 * (ok + fail) / n) + "%";

    // 章节列表
    const box = $("webRunList");
    box.textContent = "";
    const frag = document.createDocumentFragment();
    let focus = Math.min(r.next, n - 1);
    r.list.forEach((x, i) => {
      const line = el("div", "ch" + (x.st === "fail" ? " bad" : x.st === "wait" ? " off" : ""));
      line.textContent = ST[x.st] + " " + x.num + "  " + x.name + (x.st === "fail" ? "  （" + x.err + "）" : "");
      frag.append(line);
      if (i === focus) {
        // 自动滚动到当前章
        requestAnimationFrame(() => {
          if (line.offsetTop) box.scrollTop = Math.max(0, line.offsetTop - box.offsetTop - 60);
        });
      }
    });
    box.append(frag);

    $("webPause").hidden = !r.active;
    $("webResume").hidden = r.active || r.next >= n;
    $("webRunBack").hidden = r.active;
  }

  // 后台保活：下载时起前台服务（通知栏进度），切到别的 App 也接着下。
  // 复用导书那套原生实现（AppToolsPlugin 的 bgStart/bgUpdate/bgStop）。
  const bg = {
    on: false,
    call(m, o) { return Capacitor.nativePromise("AppTools", m, o || {}); },
    start(title) {
      if (!NATIVE) return;
      this.on = true;
      this.call("bgPermission").catch(() => { });   // 安卓13+ 弹一次通知权限，不等它
      this.call("bgStart", { title }).catch(() => { });
    },
    update(text, done, total) {
      if (!NATIVE || !this.on) return;
      this.call("bgUpdate", { text: String(text || ""), done: done | 0, total: total | 0 }).catch(() => { });
    },
    stop(text) {
      if (!NATIVE || !this.on) return;
      this.on = false;
      this.call("bgStop", { text: String(text || "") }).catch(() => { });
    }
  };

  async function webLoop() {
    const r = webRun;
    if (!r || r.active) return;
    r.active = true;
    r.stop = false;
    let streak = 0;
    setWebMsg("webRunMsg", "");
    drawWebRun();
    bg.start("《" + r.book.title + "》 " + r.book.source.name);

    try {
      while (r.next < r.list.length) {
        if (r.stop) {
          setWebMsg("webRunMsg", '已暂停。点"继续"接着下。');
          break;
        }
        const ch = r.list[r.next];
        ch.st = "busy";
        drawWebRun();
        bg.update("正在下载：" + ch.name + "（" + (r.next + 1) + " / " + r.list.length + "）", r.next, r.list.length);
        setWebMsg("webRunMsg", "正在下载：" + ch.name);

        let tries = 0;
        for (; ;) {
          try {
            const got = await downloadChapter(r.book.source, ch.url);
            if (!got.text) throw new Error("正文是空的");
            ch.text = got.text;
            ch.st = "ok";
            streak = 0;
            break;
          } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/连不上|HTTP 5|没有返回/.test(msg) && tries < 2) {
              tries++;
              await sleep(2500 * tries);
              continue;
            }
            ch.st = "fail";
            ch.err = msg;
            streak++;
            break;
          }
        }
        r.next++;
        drawWebRun();
        if (streak >= 3) {
          setWebMsg("webRunMsg", '连着 3 章没下成，先暂停了：' + ch.err + '。可以过一会儿点"继续"。', "warn");
          break;
        }
        if (r.next < r.list.length) await sleep(600 + Math.random() * 800);
      }
    } finally {
      r.active = false;
    }

    try {
      if (r.next >= r.list.length) await webFinish();
    } finally {
      drawWebRun();
      bg.stop(($("webRunMsg").textContent || "").trim() || $("webRunCount").textContent);
    }
  }

  function composeWebText(r) {
    const b = r.book;
    const parts = [
      b.title,
      "作者：" + (b.author || "未知") + "　来源：" + b.source.name + "　" + b.url
    ];
    if (b.intro) parts.push("简介：\n" + b.intro);
    for (const c of r.list) {
      if (c.st !== "ok") {
        parts.push(c.name + "\n\n（这一章没有下载成功：" + (c.err || "未下载") + "）");
        continue;
      }
      parts.push(c.name + "\n\n" + c.text);
    }
    return parts.join("\n\n\n") + "\n";
  }

  async function webFinish() {
    const r = webRun;
    const okList = r.list.filter(c => c.st === "ok");
    if (!okList.length) {
      setWebMsg("webRunMsg", "一章都没下成，没有存进书架。", "warn");
      return;
    }

    const text = composeWebText(r);
    const fail = r.list.filter(c => c.st === "fail").length;

    try {
      const id = await bookAdd(r.book.title, text, undefined,
        { platform: r.book.source.name, url: r.book.url, author: r.book.author });
      r.savedId = id;
      setWebMsg("webRunMsg",
        "下载完成，已存进书架：《" + r.book.title + "》（" + okList.length + " 章）"
        + (fail ? "，有 " + fail + " 章没下成" : ""),
        "ok");
      $("webDone").hidden = false;
      try { await loadBooks(); } catch (e) { }
    } catch (e) {
      setWebMsg("webRunMsg", "存书架失败：" + ((e && e.message) || e), "warn");
    }
  }

  /* 保存 / 做卡 / 去书架 */
  $("webSaveTxt").onclick = async () => {
    if (!webRun || !webRun.savedId) return;
    try {
      const text = await bookText(webRun.savedId);
      setWebMsg("webRunMsg", await fileOut("save", safe(webRun.book.title) + ".txt", text), "ok");
    } catch (e) { setWebMsg("webRunMsg", "没存成：" + ((e && e.message) || e), "warn"); }
  };
  $("webMakeCard").onclick = () => {
    if (!webRun || !webRun.savedId) return;
    show("card");
    $("cardBook").value = webRun.savedId;
    if ($("cardBook").onchange) $("cardBook").onchange();
  };
  $("webToShelf").onclick = () => show("shelf");

  /* ============================================================
     源站管理 UI（密钥 tab）
     ============================================================ */

  let editingSrc = null;   // 正在编辑的源站 id; 新增时是 ""

  function renderSources() {
    const box = $("srcList");
    box.textContent = "";
    if (!sources.length) box.append(el("p", "hint", '还没有源站。点下面"新增源站"添加。'));
    for (const s of sources) {
      const d = el("div", "item");
      const t = el("div", "t");
      t.append(document.createTextNode(s.name));
      if (!s.enabled) {
        const tag = el("span", "tag", "已禁用");
        tag.style.marginLeft = "8px";
        t.append(tag);
      }
      d.append(t);
      d.append(el("div", "s", s.base + s.searchPath));

      const row = el("div", "row");
      const toggle = el("button", "small", s.enabled ? "禁用" : "启用");
      toggle.onclick = () => { s.enabled = !s.enabled; saveSources(); renderSources(); };
      const edit = el("button", "small", "编辑");
      edit.onclick = () => openSrcForm(s);
      const del = el("button", "small", "删除");
      del.onclick = () => {
        if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "确认删除"; return; }
        sources = sources.filter(x => x.id !== s.id);
        saveSources();
        if (editingSrc === s.id) closeSrcForm();
        renderSources();
      };
      row.append(toggle, edit, del);
      d.append(row);
      box.append(d);
    }
  }

  function openSrcForm(s) {
    editingSrc = s ? s.id : "";
    $("srcFormTitle").textContent = s ? "编辑源站" : "新增源站";
    $("s_name").value = s ? s.name : "";
    $("s_base").value = s ? s.base : "";
    $("s_search").value = s ? s.searchPath : "/s?q={kw}";
    $("srcTestMsg").textContent = "";
    $("srcForm").hidden = false;
    $("srcAdd").hidden = true;
    $("srcForm").scrollIntoView({ block: "start" });
  }

  function closeSrcForm() {
    editingSrc = null;
    $("srcForm").hidden = true;
    $("srcAdd").hidden = false;
  }

  $("srcAdd").onclick = () => openSrcForm(null);
  $("srcCancel").onclick = closeSrcForm;

  $("srcSave").onclick = () => {
    const name = $("s_name").value.trim();
    const base = $("s_base").value.trim().replace(/\/+$/, "");
    const searchPath = $("s_search").value.trim();
    if (!name || !base || !searchPath) {
      $("srcTestMsg").textContent = "站点名、地址、搜索路径都要填。";
      return;
    }
    if (!searchPath.includes("{kw}")) {
      $("srcTestMsg").textContent = "搜索路径里要包含 {kw}（关键词占位）。";
      return;
    }
    const cur = sources.find(x => x.id === editingSrc);
    if (cur) {
      cur.name = name;
      cur.base = base;
      cur.searchPath = searchPath;
    } else {
      sources.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, base, searchPath, type: "biquge", enabled: true
      });
    }
    saveSources();
    closeSrcForm();
    renderSources();
  };

  $("srcTest").onclick = async () => {
    const base = $("s_base").value.trim().replace(/\/+$/, "");
    const searchPath = $("s_search").value.trim();
    if (!base || !searchPath) { $("srcTestMsg").textContent = "先填地址和搜索路径。"; return; }
    $("srcTestMsg").textContent = "测试中…";
    try {
      const src = { base, searchPath, type: "biquge", name: "测试" };
      const results = await searchOne(src, "斗破苍穹");
      $("srcTestMsg").textContent = results.length
        ? "连接成功！搜到 " + results.length + " 个结果，第一个是《" + results[0].title + "》。"
        : "连上了，但搜索没有返回结果（可能是搜索路径不对）。";
    } catch (e) {
      $("srcTestMsg").textContent = "测试失败：" + ((e && e.message) || e);
    }
  };

  $("srcReset").onclick = () => {
    if ($("srcReset").dataset.sure !== "1") {
      $("srcReset").dataset.sure = "1";
      $("srcReset").textContent = "确认恢复？";
      return;
    }
    $("srcReset").dataset.sure = "";
    $("srcReset").textContent = "恢复默认";
    sources = DEFAULT_SOURCES.map(s => Object.assign({}, s));
    saveSources();
    closeSrcForm();
    renderSources();
  };

  renderSources();

})();
