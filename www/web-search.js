/* web-search.js: 在线站点搜书 → 预览 → 选章节 → 下载
   加载时机：在 index.html 主脚本和 reader.js 之后，共享全局的
   $, el, NATIVE, decode, http, bookAdd, bookText, loadBooks, show, fmtChars, fileOut, safe, openReader */
(() => {
  "use strict";

  const UA = navigator.userAgent;
  // 用桌面 UA 请求搜索引擎，拿稳定的桌面版结果页布局
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  // 搜索引擎（"找书"入口）：默认 Bing，反爬宽松、结果好解析。可在 localStorage sf:engine 覆盖
  // 搜索引擎预设（"找书"入口）。render:true 用隐藏 WebView 渲染（JS 重的引擎必须）
  const ENGINES = {
    quark: { name: "夸克", base: "https://quark.sm.cn/s?q=", host: "sm.cn", render: false, warmup: "https://quark.sm.cn/" },
    bing: { name: "Bing", base: "https://cn.bing.com/search?q=", host: "bing.com", render: false, quote: true },
    so360: { name: "360", base: "https://www.so.com/s?q=", host: "so.com", render: false },
    sogou: { name: "搜狗", base: "https://www.sogou.com/web?query=", host: "sogou.com", render: true },
  };
  let engineId = "quark";
  try { const id = localStorage.getItem("sf:engineId"); if (id && ENGINES[id]) engineId = id; } catch (e) { }
  function ENG() { return ENGINES[engineId] || ENGINES.quark; }
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

  async function fetchPage(url, timeout = 9000, ua = UA) {
    let html;
    if (NATIVE) {
      let r;
      try {
        r = await withTimeout(Capacitor.nativePromise("AppTools", "get", { url, redirect: true, ua }), timeout);
      } catch (e) {
        throw new Error("连不上：" + ((e && e.message) || e));
      }
      if ([403, 429, 503].includes(r.status))
        throw new Error("网站拦了请求（HTTP " + r.status + "），可能需要人机验证或稍后再试");
      if (r.status === 301 || r.status === 302) {
        const loc = r.location || "";
        if (loc) return fetchPage(loc.startsWith("http") ? loc : new URL(loc, url).href, timeout, ua);
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

  // 用隐藏 WebView 渲染页面（执行 JS、带 cookie），能过大多数反爬。只在 App 里可用。
  async function fetchRendered(url, ua, timeout) {
    if (!NATIVE) throw new Error("渲染模式只能在 App 里用");
    let r;
    try {
      r = await Capacitor.nativePromise("AppTools", "getRendered", { url, ua: ua || UA, timeout: timeout || 20000 });
    } catch (e) {
      throw new Error("连不上：" + ((e && e.message) || e));
    }
    if (!r || !r.data) throw new Error("页面没返回内容");
    const html = decode(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
    return { html, doc: new DOMParser().parseFromString(html, "text/html") };
  }

  // 普通请求优先；被反爬拦了（403/超时/5xx）再用隐藏 WebView 渲染兜底
  async function fetchSmart(url, timeout, ua) {
    try {
      return await fetchPage(url, timeout || 9000, ua || UA);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (NATIVE && /HTTP 403|拦了请求|超时|连不上|HTTP 5/.test(msg)) {
        return await fetchRendered(url, ua || UA, (timeout || 9000) + 9000);
      }
      throw e;
    }
  }

  // 相关度：结果标题是否跟搜索词沾边（过滤掉把书名拆成单字搜出来的字典等噪音）
  function relevant(title, kw) {
    title = String(title || "");
    const k = String(kw || "").replace(/\s+/g, "");
    if (!k) return true;
    if (title.indexOf(k) >= 0) return true;
    if (k.length <= 3) return title.indexOf(k) >= 0;
    const n = Math.min(4, k.length);               // 任一长度4的连续子串命中即算相关
    for (let i = 0; i + n <= k.length; i++)
      if (title.indexOf(k.slice(i, i + n)) >= 0) return true;
    return false;
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
      const seenUrl = new Set();
      const pushCh = (href, name) => {
        if (!href || href === "#" || /^javascript:/.test(href)) return;
        name = cleanStr(name);
        if (!name || name.length > 80) return;
        if (/展开|查看更多|点击加载|最新章节|^目录$|书架|首页|下一页|上一页|书签|评论|报错|加入/.test(name)) return;
        let chUrl; try { chUrl = new URL(href, pageUrl).href; } catch (e) { return; }
        if (seenUrl.has(chUrl)) return;
        seenUrl.add(chUrl);
        chapters.push({ num: chapters.length + 1, name, url: chUrl, state: "可导", pick: true });
      };

      let links = doc.querySelectorAll("#list dd a, .listmain dd a, #chapterList a, .chapter-list a, .list-chapter a, #list-chapterAll dd a, .catalog a, .mulu a, .chapterlist a, .section-list a, .book_list a, .booklist a, .list_xm a");
      if (!links.length) links = doc.querySelectorAll("#list a, .listmain a, .zjlist a, #chapterlist a, .catalog a, dd a");
      for (const a of links) pushCh(a.getAttribute("href"), a.textContent);

      // 通用兜底：固定选择器没抓到（够多）时，按 URL 里的书号把"像章节"的链接都收进来，不管容器叫什么
      if (chapters.length < 5) {
        const bookId = (pageUrl.match(/\/(\d{3,})(?:[\/_.]|$)/) || [])[1];
        if (bookId) {
          chapters.length = 0; seenUrl.clear();
          for (const a of doc.querySelectorAll("a[href]")) {
            const href = a.getAttribute("href"); if (!href) continue;
            let abs; try { abs = new URL(href, pageUrl).href; } catch (e) { continue; }
            if (abs.indexOf(bookId) < 0 || abs.replace(/[#?].*$/, "") === pageUrl.replace(/[#?].*$/, "")) continue;
            const name = cleanStr(a.textContent);
            if (name && name.length <= 60 && /[第章节回话卷]|\d/.test(name)) pushCh(href, name);
          }
        }
      }

      return { title, author, intro, status, words, chapters };
    },

    /* 解析章节正文 */
    chapter(doc) {
      let content = null;
      for (const sel of ["#content", "#chaptercontent", "#novelcontent", ".novelcontent", ".content",
        "#BookText", ".chapter_content", ".read-content", "#htmlContent", "#TextContent", "#chapter_content",
        "#nr1", "#nr", ".nr_nr", "#booktext", ".article-content", ".articlecontent", "#txt", ".txtnav", ".neirong"]) {
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

  /* ---------- 搜索引擎"找书"：像浏览器那样搜，拿到各站的书页链接 ---------- */

  // 跳过搜索引擎自己和明显无关的大站（按域名后缀匹配，含 page.sm.cn、ubook.reader.qq.com 这类子域）
  const BAD_DOMAINS = ["bing.com", "microsoft.com", "msn.com", "live.com", "baidu.com", "google.com", "google.com.hk", "sogou.com", "so.com", "haosou.com", "360.cn", "zhihu.com", "weibo.com", "douban.com", "bilibili.com", "jd.com", "taobao.com", "tmall.com", "qq.com", "163.com", "sina.com.cn", "csdn.net", "xiaohongshu.com", "toutiao.com", "sm.cn", "uc.cn", "quark.cn", "apple.com", "youtube.com", "facebook.com", "zimgs.cn", "alicdn.com", "w3.org", "gov.cn"];
  function isBadHost(host) {
    host = (host || "").toLowerCase();
    return BAD_DOMAINS.some(d => host === d || host.endsWith("." + d));
  }
  const BTN_WORDS = /^(开始阅读|立即阅读|免费阅读|在线阅读|点击阅读|章节目录|全部章节|最新章节|查看目录|目录|阅读|下载|txt下载|更多|详情)$/;

  // 各搜索引擎的跳转链：真实地址藏在参数里，解出来（夸克结果多是直链，这里主要给 Bing/搜狗用）
  function resolveRedirect(href) {
    if (!href) return href;
    if (/bing\.com\/ck\/a/i.test(href)) {
      try {
        const raw = new URL(href).searchParams.get("u") || "";
        if (/^a1/.test(raw)) { const d = atob(raw.slice(2).replace(/-/g, "+").replace(/_/g, "/")); if (/^https?:\/\//i.test(d)) return d; }
      } catch (e) { }
    }
    try {
      const u = new URL(href, "https://_/");
      for (const k of ["url", "u", "target", "to", "link", "dest"]) {
        let v = u.searchParams.get(k);
        if (v) { try { v = decodeURIComponent(v); } catch (e) { } if (/^https?:\/\//i.test(v)) return v; }
      }
    } catch (e) { }
    return href;
  }

  // 清洗结果标题：优先取《…》，否则砍掉"最新章节…"、结尾的 _www.域名 / 书城名
  function cleanSerpTitle(t) {
    t = cleanStr(t);
    const m = t.match(/《([^》]{2,40})》/);
    if (m) return m[1];
    t = t.split(/最新章节|免费阅读|全文阅读|在线阅读|，|,/)[0];
    t = t.replace(/[_\-\s]+(www\.|m\.|wap\.)?[a-z0-9.-]+\.(com|cc|net|la|cn|org|xyz|me)\s*$/i, "");
    t = t.replace(/[_\-\s]+(晋江文学城|格格党|[0-9A-Za-z一-龥]{1,6}书屋)\s*$/, "");
    return t.replace(/^[\s_\-|·]+|[\s_\-|·]+$/g, "").slice(0, 40);
  }

  // 书的分组键：域名 + 路径里第一个长数字段（书号），把同一本书的多个链接归并
  function bookKey(host, path) {
    const ids = (path || "").match(/\d{3,}/);
    return host.replace(/^www\./, "") + "|" + (ids ? ids[0] : (path || ""));
  }

  // 解析搜索结果页：按书分组，每本取一个干净标题 + 最短的那个链接（通常是目录页）
  // 逻辑已用夸克真实结果页在手机上验证通过
  function parseSerp(doc, engineHost, keyword) {
    const groups = new Map();
    for (const a of doc.querySelectorAll("a[href]")) {
      let href = resolveRedirect(a.getAttribute("href") || "");
      if (!/^https?:\/\//i.test(href)) continue;
      let u; try { u = new URL(href); } catch (e) { continue; }
      const host = u.hostname;
      if (engineHost && host.indexOf(engineHost) >= 0) continue;
      if (isBadHost(host)) continue;
      const title = cleanSerpTitle(a.textContent);
      const key = bookKey(host, u.pathname);
      let g = groups.get(key);
      if (!g) { g = { title: "", urls: [], host: host.replace(/^www\./, "") }; groups.set(key, g); }
      if (g.urls.indexOf(href) < 0) g.urls.push(href);
      // 只把"像书名、且跟搜索词沾边"的标题当作本组标题，字典/按钮/不相关的忽略
      if (title && !BTN_WORDS.test(title) && title.length >= 4 && relevant(title, keyword) && title.length > g.title.length)
        g.title = title;
    }
    const out = [];
    for (const g of groups.values()) {
      if (!g.title) continue;
      const url = g.urls.slice().sort((a, b) => a.length - b.length)[0];
      out.push({ title: g.title, url, domain: g.host });
    }
    return out;
  }

  async function searchViaEngine(keyword) {
    const eng = ENG();
    // 先访问首页拿会话 cookie，否则夸克等会把无 cookie 的请求当机器人、返回验证码页（原生 get 共享 CookieManager，会自动带上）
    if (eng.warmup) { try { await fetchPage(eng.warmup, 10000, DESKTOP_UA); } catch (e) { } }
    const q = eng.quote ? '"' + keyword + '" 小说' : keyword + " 小说";
    const url = eng.base + encodeURIComponent(q);
    let doc, html;
    if (eng.render && NATIVE) {
      ({ doc, html } = await fetchRendered(url, DESKTOP_UA, 22000));
    } else {
      try { ({ doc, html } = await fetchPage(url, 12000, DESKTOP_UA)); }
      catch (e) { if (NATIVE) ({ doc, html } = await fetchRendered(url, DESKTOP_UA, 22000)); else throw e; }
    }
    const results = parseSerp(doc, eng.host, keyword);
    // 没结果且页面像验证码/限流页：给明确提示，别静默返回 0
    if (!results.length && /punish|captcha|x5sec|validate|滑动|拖动|人机|verify/i.test(html || "")) {
      throw new Error(eng.name + '被限流了（需要人机验证）。过几分钟再搜，或在密钥页换个引擎，或用上面的「粘贴网址」直接下。');
    }
    return results.map(r => ({
      title: r.title, url: r.url, author: "", latest: "",
      source: { name: r.domain, base: new URL(r.url).origin, type: "biquge", engine: true }
    }));
  }

  // 结果链接可能落在简介页（有"章节目录""开始阅读"按钮），找出进一层的目录链接
  function findCatalogLink(doc, base) {
    for (const a of doc.querySelectorAll("a[href]")) {
      const t = (a.textContent || "").trim();
      if (/章节目录|全部章节|查看目录|开始阅读|^目录$/.test(t)) {
        const href = a.getAttribute("href");
        if (href && href !== "#") { try { return new URL(href, base).href; } catch (e) { } }
      }
    }
    return null;
  }

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
        doc = (await fetchSmart(url)).doc;
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

  /* ============================================================
     书籍详情与章节下载
     ============================================================ */

  async function loadWebBook(source, url) {
    const rule = RULES[source.type || "biquge"];
    if (!rule) throw new Error("不支持的源站类型");
    let { doc } = await fetchSmart(url);
    let book = rule.book(doc, url);
    // 落在简介/文章页没读到目录时，顺着"章节目录""开始阅读"再进一层
    if (book.title && !book.chapters.length) {
      const link = findCatalogLink(doc, url);
      if (link && link !== url) {
        try {
          const r2 = await fetchSmart(link);
          const b2 = rule.book(r2.doc, link);
          if (b2.chapters.length) { book = b2; url = link; }
        } catch (e) { }
      }
    }
    if (!book.title) throw new Error("没在页面上找到书名，这个站的结构可能不一样。换结果里别的站试试。");
    if (!book.chapters.length) throw new Error("找到了书，但没读到章节目录。换结果里别的站试试。");
    book.url = url;
    book.source = source;
    return book;
  }

  // 去掉正文里的翻页标记行，如 "第1/3页"
  function stripPageMark(t) {
    return String(t || "").replace(/[^\n]*第\s*\d+\s*[\/／]\s*\d+\s*页[^\n]*\n?/g, "").trim();
  }
  // 由当前页 URL 推下一页：.../ID/ -> .../ID_2/；.../ID_2/ -> .../ID_3/
  function nextPageUrl(url, page) {
    const m = url.match(/^(.*?\/)(\d+)(?:_\d+)?(\/?(?:\.html?)?)$/i);
    if (!m) return null;
    return m[1] + m[2] + "_" + page + m[3];
  }

  async function downloadChapter(source, chUrl, onPage) {
    const rule = RULES[source.type || "biquge"];
    if (!rule) throw new Error("不支持的源站类型");
    const { doc } = await fetchSmart(chUrl);   // 章节被反爬拦了也用渲染兜底
    let text = rule.chapter(doc).text || "";
    // 多页章节：正文里有"(第N/M页)"就顺着翻页拼接
    const mm = text.match(/第\s*(\d+)\s*[\/／]\s*(\d+)\s*页/);
    const total = mm ? parseInt(mm[2], 10) : 1;
    if (total > 1) {
      if (onPage) onPage(1, total);
      let parts = [stripPageMark(text)];
      for (let p = 2; p <= total && p <= 20; p++) {
        const next = nextPageUrl(chUrl, p);
        if (!next) break;
        if (onPage) onPage(p, total);
        try {
          const r = await fetchSmart(next);
          const t = stripPageMark(rule.chapter(r.doc).text || "");
          if (t) parts.push(t);
        } catch (e) { break; }
        await sleep(200 + Math.random() * 300);
      }
      text = parts.join("\n");
    } else {
      text = stripPageMark(text);
    }
    return { text };
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
  let searching = false;              // 在线搜索进行中（边搜边出）
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
      $("webBox").hidden = !(searching || webResults.length > 0 || webErr.length > 0);
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

  // 粘贴网址直接打开（最稳：绕开搜索引擎，直接抓这个网址的书）
  async function openPastedUrl() {
    let raw = $("webUrl").value.trim();
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    let origin, host;
    try { const u = new URL(raw); origin = u.origin; host = u.hostname.replace(/^www\./, ""); }
    catch (e) { setWebMsg("webNotice", "网址不对，复制完整的书籍链接再试。", "warn"); $("webNotice").hidden = false; return; }
    searchDone = true;
    openWebBook({ title: host, url: raw, source: { name: host, base: origin, type: "biquge", engine: true } });
  }
  if ($("webOpenUrl")) $("webOpenUrl").onclick = openPastedUrl;
  if ($("webUrl")) $("webUrl").onkeydown = e => { if (e.key === "Enter") openPastedUrl(); };

  // 搜索引擎选择（密钥页）
  if ($("engSel")) {
    $("engSel").value = engineId;
    $("engSel").onchange = () => {
      engineId = $("engSel").value;
      try { localStorage.setItem("sf:engineId", engineId); } catch (e) { }
    };
  }

  // 恢复保存的筛选高亮
  applyFilter();

  async function doCombinedSearch() {
    const kw = $("kw").value.trim();
    if (!kw) { $("searchMsg").textContent = "先输入书名或作者。"; return; }

    $("doSearch").disabled = true;
    $("searchMsg").textContent = "搜索中…";
    $("webInfo").hidden = true;
    $("webRun").hidden = true;

    // 结果区先显示出来，边搜边出：哪个源站先回来就先显示哪个
    searchDone = true;
    searching = true;
    webResults = [];
    webErr = [];
    renderWebResults();
    applyFilter();

    const onProgress = () => { renderWebResults(); applyFilter(); };
    let panDone = false;
    const status = () => {
      $("searchMsg").textContent = "在线站点 " + webResults.length + " 个 · 网盘 "
        + (panDone ? panCount() + " 条" : "搜索中…") + "。用上面的标签切换查看。";
    };

    // 网盘搜索：index.html 的 doSearch 会自己把结果渲染到 panBox（慢，不阻塞在线结果）
    const panP = Promise.resolve()
      .then(() => _origPanSearch && _origPanSearch())
      .catch(() => { })
      .then(() => { panDone = true; status(); applyFilter(); });
    // 在线站点搜索（渐进式）
    const webP = doWebSearchCore(kw, onProgress).catch(e => {
      webErr.push(String((e && e.message) || e));
      onProgress();
    });

    // 在线结果一好就解锁、显示计数，不等慢的网盘搜索
    await webP;
    searching = false;
    $("doSearch").disabled = false;
    status();
    renderWebResults();
    applyFilter();
  }

  /* ============================================================
     在线站点搜索（每个源站一返回就刷新，不等最慢的）
     ============================================================ */

  async function doWebSearchCore(kw, onProgress) {
    const seen = new Set();
    const add = (r) => {
      const key = r.title + "|" + r.url;
      if (seen.has(key)) return;
      seen.add(key);
      webResults.push(r);
    };

    // 主：像浏览器那样用搜索引擎找书（反爬宽松，能绕开小说站的 403）
    try {
      (await searchViaEngine(kw)).forEach(add);
      if (onProgress) onProgress();
    } catch (e) {
      webErr.push(ENG().name + "：" + ((e && e.message) || String(e)));
      if (onProgress) onProgress();
    }
    if (webResults.length) return;   // 引擎有结果就不再撞各站了

    // 备用：直接搜各启用的源站（多半会被 403/超时，所以放后面）
    const enabled = sources.filter(s => s.enabled);
    if (!enabled.length) return;
    await Promise.all(enabled.map(async (s) => {
      let rs = [];
      try { rs = await searchOne(s, kw); }
      catch (e) { webErr.push(s.name + "：" + ((e && e.message) || String(e))); }
      rs.forEach(add);
      if (onProgress) onProgress();
    }));
  }

  function renderWebResults() {
    const box = $("webList");
    box.textContent = "";
    $("webCount").textContent = webResults.length + " 个";

    if (!webResults.length) {
      box.append(el("p", "hint",
        searching ? "搜索中…" + (webErr.length ? "（" + webErr.join("；") + "）" : "")
          : webErr.length ? "没搜到。" + webErr.join("；")
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

  let webLoading = false;
  async function openWebBook(result) {
    if (webLoading) return;                 // 正在打开另一本，忽略重复点击
    webLoading = true;
    // 立刻把详情区显示出来，给出可见的"加载中"反馈并滚动过去，别让用户以为卡死
    $("webRun").hidden = true;
    $("webInfo").hidden = false;
    $("webTitle").textContent = result.title || "加载中…";
    $("webSite").textContent = result.source.name;
    $("webMeta").textContent = "";
    $("webIntro").textContent = "";
    $("webAvail").textContent = "";
    $("webChList").textContent = "";
    $("webFrom").value = $("webTo").value = "";
    $("webNotice").hidden = false;
    $("webInfo").scrollIntoView({ block: "start" });

    // 跳秒计时，让用户看到它在动、还要等多久（慢的站约十几秒）
    let sec = 0;
    const tick = () => setWebMsg("webNotice", "正在抓取《" + (result.title || "") + "》的目录…已 " + sec + " 秒" + (sec >= 6 ? "（这个站较慢，正用浏览器内核加载）" : ""));
    tick();
    const timer = setInterval(() => { sec++; tick(); }, 1000);

    try {
      webBook = await loadWebBook(result.source, result.url);
      clearInterval(timer);
      showWebBook();
    } catch (e) {
      clearInterval(timer);
      setWebMsg("webNotice", "这个站没打开：" + ((e && e.message) || e) + " 换搜索结果里别的站试试。", "warn");
      $("webTitle").textContent = result.title || "加载失败";
      $("webAvail").textContent = "";
      $("webChList").textContent = "";
    } finally {
      clearInterval(timer);
      webLoading = false;
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
            const got = await downloadChapter(r.book.source, ch.url, (p, tot) => {
              setWebMsg("webRunMsg", "正在下载：" + ch.name + "（本章第 " + p + "/" + tot + " 页）");
            });
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
