/* 导书：贴作品链接 → 认出平台和书 → 看书的信息和目录、选章节 → 下载 → 存进书架。
   只收网页上直接给出的文字；VIP、加密字体之类的章节如实标出来，不导。 */
(() => {
  "use strict";
  // 用 app 自己真实的浏览器标识（安卓 WebView），登录和下载统一用它，跟手机上正常浏览器一致。
  const UA = navigator.userAgent;

  /* ---------------- 联网 ---------------- */
  async function get(url, {redirect = true} = {}){
    let r;
    if (NATIVE){
      try { r = await Capacitor.nativePromise("AppTools", "get", {url, redirect, ua:UA}); }
      catch(e){ throw new Error("连不上网站：" + ((e && e.message) || e)); }
      const bytes = r.data ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) : new Uint8Array(0);
      return {status:r.status, headers:{location:r.location || ""}, bytes, url:r.url || url};
    }
    const res = await fetch(url, {redirect: redirect ? "follow" : "manual"});
    return {status:res.status, headers:{location:res.headers.get("location") || ""}, bytes:new Uint8Array(await res.arrayBuffer()), url:res.url};
  }
  async function page(url){
    const r = await get(url);
    if ([202, 403, 429].includes(r.status)) throw new Error("网站要求人机验证或暂时不让访问（HTTP " + r.status + "）");
    if (r.status !== 200) throw new Error("网站没有返回页面（HTTP " + r.status + "）");
    const html = decode(r.bytes);
    return {html, doc: new DOMParser().parseFromString(html, "text/html")};
  }
  // VIP 章节：用隐藏 WebView 渲染页面（等 JS 加载完正文），拿到完整 HTML 后解析
  async function vipPage(url){
    if (!NATIVE) throw new Error("VIP 章节只能在 App 里下载");
    let r;
    try { r = await Capacitor.nativePromise("AppTools", "getRendered", {url, ua:UA, timeout:25000}); }
    catch(e){ throw new Error("VIP 正文加载失败：" + ((e && e.message) || e)); }
    if (r.unbought) return {html:"", doc:null, unbought:true};
    if (!r.data) throw new Error("VIP 页面没有返回内容");
    const html = decode(Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
    return {html, doc: new DOMParser().parseFromString(html, "text/html")};
  }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wanzi = n => n >= 10000 ? (n / 10000).toFixed(1) + " 万字" : n + " 字";
  const clean = s => String(s || "").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  function textOf(node){
    if (!node) return "";
    const c = node.cloneNode(true);
    c.querySelectorAll("script, style, noscript").forEach(n => n.remove());
    c.querySelectorAll("br").forEach(n => n.replaceWith("\n"));
    c.querySelectorAll("p, div, li").forEach(n => n.append("\n"));
    return clean(c.textContent.split("\n").map(s => s.trim()).join("\n"));
  }

  /* ---------------- 番茄下载引擎（本地服务） ----------------
     官方 Rust 二进制随 APK 以 libtomato.so 分发，由原生插件 TomatoEngine 起成
     127.0.0.1:18423 的本地服务。番茄正文的签名/解密都在它里面，这里只管调它的 /api。 */
  const ENGINE = {base: "http://127.0.0.1:18423", ready: false, configured: false};

  // 调引擎的 JSON 接口：走 CapacitorHttp（原生 HTTP，免 CORS），返回 {status, data}
  async function engineJson(path, {method = "GET", json, timeout = 60000} = {}){
    const headers = json !== undefined ? {"Content-Type": "application/json"} : {};
    const r = await Capacitor.nativePromise("CapacitorHttp", "request",
      {url: ENGINE.base + path, method, headers, data: json, connectTimeout: 8000, readTimeout: timeout});
    let data = r.data;
    if (typeof data === "string"){ try { data = JSON.parse(data); } catch(e){} }
    return {status: r.status, data};
  }

  // 确保引擎跑起来并就绪：起进程 → 轮询 /api/status 直到有版本号 → 配一次输出格式
  async function engineEnsure(){
    if (!NATIVE) throw new Error("番茄下载引擎只能在 App 里用");
    if (ENGINE.ready) return;
    try { await Capacitor.nativePromise("TomatoEngine", "start", {}); }
    catch(e){ throw new Error("番茄引擎启动失败：" + ((e && e.message) || e)); }
    // 首次启动要解压/初始化，给它点时间
    const deadline = Date.now() + 45000;
    let lastErr = "";
    while (Date.now() < deadline){
      try {
        const r = await engineJson("/api/status", {timeout: 5000});
        if (r.status === 200 && r.data && (r.data.version || r.data.prewarm !== undefined || r.data.prewarm_in_progress !== undefined)){
          ENGINE.ready = true;
          break;
        }
        lastErr = "HTTP " + r.status;
      } catch(e){ lastErr = String((e && e.message) || e); }
      await sleep(1000);
    }
    if (!ENGINE.ready) throw new Error("番茄引擎没能就绪（" + lastErr + "）。可以退出重进 App 再试。");
    if (!ENGINE.configured){
      // 设成直接出 txt，别在下载后弹"选格式"把任务卡住
      try { await engineJson("/api/config", {method: "POST", json: {novel_format: "txt"}}); } catch(e){}
      ENGINE.configured = true;
    }
  }

  // 下载产出的 txt 落在引擎 data-dir 下（通常是 书名/书名.txt）。
  // 列 /api/library（条目有 kind/rel_path/name/ext/modified_ms）找这本书对应的 .txt，返回 rel_path。
  async function engineListDir(rel){
    const qs = rel ? "?path=" + encodeURIComponent(rel) : "";
    const r = await engineJson("/api/library" + qs);
    return (r.data && r.data.items) || [];
  }
  function isTxt(it){ return (it.kind || "file") === "file" && (/txt/i.test(it.ext || "") || /\.txt$/i.test(it.name || it.rel_path || "")); }
  function newest(list){ return list.slice().sort((a,b) => (b.modified_ms||0) - (a.modified_ms||0))[0] || null; }

  async function engineFindFile(book){
    const norm = (s) => String(s || "").replace(/\s+/g, "");
    const title = norm(book.title);
    const roots = await engineListDir("");
    // 1) 根目录下匹配书名的 .txt；否则记下最新的 .txt 作兜底
    const rootTxt = roots.filter(isTxt);
    const hitRoot = rootTxt.find(it => norm(it.name).indexOf(title) >= 0);
    if (hitRoot) return hitRoot.rel_path;
    // 2) 进匹配书名的子目录找 .txt（取最新）
    const dirs = roots.filter(it => it.kind === "dir");
    const hitDir = dirs.find(d => norm(d.name).indexOf(title) >= 0 || title.indexOf(norm(d.name)) >= 0);
    if (hitDir){
      const sub = (await engineListDir(hitDir.rel_path)).filter(isTxt);
      const f = newest(sub);
      if (f) return f.rel_path;
    }
    // 3) 根目录任意最新 .txt
    if (rootTxt.length) return newest(rootTxt).rel_path;
    // 4) 扫所有子目录里最新的 .txt
    let cands = [];
    for (const d of dirs){
      const sub = (await engineListDir(d.rel_path)).filter(isTxt);
      cands = cands.concat(sub);
    }
    const f = newest(cands);
    return f ? f.rel_path : null;
  }

  // 取产出文件的正文：用 AppTools.get 取字节再按编码解码（引擎导出的是 UTF-8）
  async function engineReadFile(rel){
    const url = ENGINE.base + "/download/" + String(rel).split("/").map(encodeURIComponent).join("/");
    const r = await get(url);
    if (r.status !== 200) throw new Error("取下载文件失败（HTTP " + r.status + "）");
    return decode(r.bytes);
  }

  /* ---------------- 各平台 ---------------- */
  const PLATFORMS = {
    jjwxc: {
      name:"晋江",
      match(u){
        if (!/(^|\.)jjwxc\.(net|com)$/.test(u.hostname)) return null;
        const id = u.searchParams.get("novelid") || (u.pathname.match(/\/book2\/(\d+)/) || [])[1];
        return id && /^\d+$/.test(id) ? id : null;
      },
      async load(id){
        const url = "https://www.jjwxc.net/onebook.php?novelid=" + id;
        const {doc} = await page(url);
        const q = s => doc.querySelector(s);
        const title = (q('[itemprop="articleSection"]') || q('h1[itemprop="name"]'))?.textContent.trim();
        if (!title) throw new Error("没在页面上找到书名，这本书可能被锁或者网址不对。");
        const wn = parseInt(([...doc.querySelectorAll('[itemprop="wordCount"]')].map(n => n.textContent.trim()).find(t => /字/.test(t)) || "").replace(/\D/g, ""), 10);
        const words = wn ? wanzi(wn) : "";
        const chapters = [];
        for (const row of doc.querySelectorAll('tr[itemprop~="chapter"]')){
          const tds = row.querySelectorAll("td");
          const num = parseInt(tds[0]?.textContent, 10);
          const a = tds[1]?.querySelector("a");
          const name = clean((a || tds[1])?.textContent).replace(/\s+/g, " ");
          if (!num || !name) continue;
          const href = a?.getAttribute("href") || "";
          const vip = /onebook_vip/.test((a?.getAttribute("rel") || "") + href) || /\[VIP\]/i.test(tds[1]?.textContent || "");
          let state = "可导", why = "";
          if (vip && !LOGIN.jjwxc){ state = "不可导"; why = "VIP 章节，登录晋江后才能下"; }
          else if (!vip && !/chapterid=\d+/.test(href)){ state = "不可导"; why = "章节被锁或已删除"; }
          chapters.push({num, name, note: clean(tds[2]?.textContent), state, why, vip,
            url: state !== "可导" ? "" : vip ? "https://my.jjwxc.net/onebook_vip.php?novelid=" + id + "&chapterid=" + num
              : "https://www.jjwxc.net/onebook.php?novelid=" + id + "&chapterid=" + num});
        }
        if (!chapters.length) throw new Error("没读到目录。");
        return {
          id, url, title,
          author: q('[itemprop="author"]')?.textContent.trim() || "",
          status: q('[itemprop="updataStatus"]')?.textContent.trim() || "",
          words, intro: textOf(q("#novelintro")), chapters,
          encrypted: LOGIN.jjwxc && chapters.some(c => c.vip),
          notice: !chapters.some(c => c.vip) ? ""
            : LOGIN.jjwxc ? "VIP 章节会用渲染模式下载（每章稍慢）。正文是加密字体，部分字显示为空白或方框。没买的章节会标成“未购买”。"
            : "这本有 VIP 章节。登录晋江后，买过的 VIP 章节也能下（加密字体原样）。"
        };
      },
      async chapter(ch){
        // VIP 章节用隐藏 WebView 渲染，等 JS 加载完正文
        if (ch.vip && NATIVE) {
          const vr = await vipPage(ch.url);
          if (vr.unbought) return {text:"", note:"", unbought:true};
          const {doc, html} = vr;
          let body = doc.querySelector("#paragraph_comment_content");
          if (!body) {
            const box = doc.querySelector(".noveltext");
            if (box) {
              body = box.cloneNode(true);
              body.querySelectorAll("[id^=favorite], #report_box, .float_favorite, #mongolia_layer, h2, script, style, div[align=center], [style*='display:none' i], [style*='display: none' i], .readsmall, #note_danmu_wrapper").forEach(n => n.remove());
            }
          }
          if (!body) throw new Error("页面渲染后仍找不到正文");
          const text = textOf(body);
          if (!text) throw new Error("渲染后正文是空的");
          let note = "";
          const ns = doc.querySelector("#note_str");
          if (ns){ const box = doc.createElement("div"); box.innerHTML = ns.innerHTML || ns.textContent; note = textOf(box); }
          const comments = ch.cmt > 0 ? await jjComments(ch, note) : null;
          return {text, note, comments};
        }
        // 非 VIP 章节或非 App 环境，用原来的静态 HTTP
        const {doc, html} = await page(ch.url);
        if (/浏览器标识异常/.test(html)) throw new Error("晋江拦了这次请求（浏览器标识异常）。重新登录晋江、且下载时别同时开官方晋江 App");
        if (/vip内容加载失败|vip内容加载中/.test(html)) throw new Error("这章 VIP 正文晋江只在网页里用脚本动态加载，静态抓不到（返回的是“加载失败”占位），没法导出");
        let body = doc.querySelector("#paragraph_comment_content");
        if (!body && ch.vip){
          if (/login\.php|请先登录|您还没有登录/.test(html) && !doc.querySelector(".noveltext")) throw new Error("登录过期了，重新登录晋江");
          const box = doc.querySelector(".noveltext");
          if (!box || /购买|订阅本章|余额不足/.test(box.textContent) && box.textContent.length < 400) return {text:"", note:"", unbought:true};
          body = box.cloneNode(true);
          body.querySelectorAll("[id^=favorite], #report_box, .float_favorite, #mongolia_layer, h2, script, style, div[align=center], [style*='display:none' i], [style*='display: none' i], .readsmall, #note_danmu_wrapper").forEach(n => n.remove());
        }
        if (!body) throw new Error("页面上没有正文");
        const text = textOf(body);
        if (!text) throw new Error("正文是空的");
        let note = "";
        const ns = doc.querySelector("#note_str");
        if (ns){ const box = doc.createElement("div"); box.innerHTML = ns.innerHTML || ns.textContent; note = textOf(box); }
        const comments = ch.cmt > 0 ? await jjComments(ch, note) : null;
        return {text, note, comments};
      }
    },
    fanqie: {
      name:"番茄",
      match(u){
        if (/(^|\.)fanqienovel\.com$/.test(u.hostname)) return (u.pathname.match(/^\/page\/(\d+)/) || [])[1] || null;
        if (/(^|\.)changdunovel\.com$/.test(u.hostname)) return u.searchParams.get("book_id") || null;
        return null;
      },
      async load(id){
        // App 里：目录和每章标题从番茄网页取；正文用内置引擎下载（干净文字）。
        // 浏览器预览里没有引擎，退回纯网页解析（加密字体）。
        if (NATIVE){
          let engineErr = "";
          try { await engineEnsure(); }
          catch(e){ engineErr = (e && e.message) || String(e); }
          const b = await this.loadWeb(id);   // 书名、作者、简介（页面里有时不带目录）
          // 目录：页面没带就问番茄的目录接口；再不行用引擎报的总章数补"第N章"
          if (!b.chapters.length){
            try { b.chapters = await this.catalog(id); } catch(e){}
          }
          if (!b.chapters.length && !engineErr){
            try {
              const r = await engineJson("/api/preview/" + encodeURIComponent(id));
              const n = parseInt(r.data && r.data.chapter_count, 10) || 0;
              for (let i = 1; i <= n; i++) b.chapters.push({num:i, name:"第" + i + "章", state:"可导", why:"", url:""});
              if (n) b.noTitles = true;
            } catch(e){}
          }
          if (!b.chapters.length) throw new Error("没读到这本书的目录，过一会儿再试。");
          if (!engineErr){
            // 引擎按顺序号下载，统一用 1..N 编号
            b.chapters.forEach((c, i) => { c.num = i + 1; });
            b.engine = true;
            b.encrypted = false;
            // 引擎走官方接口，网页标记的付费章节也一并尝试下
            for (const c of b.chapters){ c.state = "可导"; c.why = ""; }
            b.chapter_count = b.chapters.length;
            b.notice = b.noTitles
              ? "用内置番茄引擎下载，正文是干净文字。这次没取到每章的标题，只能按章节序号选；番茄按选中范围的首尾章整段下载。"
              : "用内置番茄引擎下载，正文是干净文字。下面是每一章的标题，勾选要下的章——番茄按选中范围的首尾章整段下载。";
          } else {
            b.notice = "番茄引擎没能用（" + engineErr + "），退回网页原样：正文是加密字体，约一半字会显示成空白或方框。";
          }
          return b;
        }
        return this.loadWeb(id);
      },
      // 番茄网页的目录接口：返回每章的标题和 itemId
      async catalog(id){
        const r = await get("https://fanqienovel.com/api/reader/directory/detail?bookId=" + encodeURIComponent(id));
        if (r.status !== 200) throw new Error("目录接口 HTTP " + r.status);
        const j = JSON.parse(new TextDecoder("utf-8").decode(r.bytes));
        const d = (j && j.data) || {};
        let rows = [];
        const vols = d.chapterListWithVolume || d.chapter_list_with_volume;
        if (Array.isArray(vols)) rows = vols.flat();
        else if (Array.isArray(d.chapterList)) rows = d.chapterList;
        else if (Array.isArray(d.item_data_list)) rows = d.item_data_list;
        const out = [];
        rows.forEach((c, i) => {
          if (!c) return;
          const itemId = c.itemId || c.item_id || "";
          out.push({num: i + 1, name: String(c.title || c.chapter_title || ("第" + (i + 1) + "章")).trim(),
            state: "可导", why: "", url: itemId ? "https://fanqienovel.com/reader/" + itemId : ""});
        });
        // 只有 id 列表、没有标题时，至少把章数补出来
        if (!out.length && Array.isArray(d.allItemIds)){
          d.allItemIds.forEach((itemId, i) => out.push({num: i + 1, name: "第" + (i + 1) + "章", state: "可导", why: "", url: "https://fanqienovel.com/reader/" + itemId}));
        }
        return out;
      },
      // 网页兜底：和以前一样，解析 __INITIAL_STATE__，正文是加密字体
      async loadWeb(id){
        const url = "https://fanqienovel.com/page/" + id;
        const {html} = await page(url);
        const st = initialState(html), p = st && st.page;
        if (!p || !p.bookName) throw new Error("没在页面上找到这本书的信息。");
        const chapters = [];
        (p.chapterListWithVolume || []).flat().forEach((c, i) => {
          const locked = !!(c.isChapterLock || c.needPay);
          chapters.push({num: parseInt(c.realChapterOrder, 10) || i + 1, name: c.title || ("第" + (i + 1) + "章"),
            state: locked ? "不可导" : "可导", why: locked ? "付费章节" : "", url: "https://fanqienovel.com/reader/" + c.itemId});
        });
        return {
          id, url, title: p.bookName, author: p.author || "", status: p.creationStatus === 0 ? "已完结" : "连载中",
          words: p.wordNumber ? wanzi(p.wordNumber) : "",
          intro: clean(p.abstract), chapters,
          encrypted: true,
          notice: "番茄网页版的正文是加密字体。下载的是网页原样，约一半的字在 txt 里会显示成空白或方框，不做还原。"
        };
      },
      async chapter(ch){
        const {html} = await page(ch.url);
        const st = initialState(html);
        const data = st && st.reader && st.reader.chapterData;
        if (!data || !data.content) throw new Error("页面上没有正文");
        const box = document.createElement("div");
        box.innerHTML = data.content;
        box.querySelectorAll("script, style").forEach(n => n.remove());
        const text = [...box.querySelectorAll("p")].map(p => p.textContent.trim()).filter(Boolean).join("\n") || textOf(box);
        if (!text) throw new Error("正文是空的");
        return {text, note: ""};
      }
    }
  };
  // 晋江段评：先问每段有几条，再按需要取每段的前几条（晋江网页自己就是这么取的）
  async function getJson(url){
    const r = await get(url);
    if (r.status !== 200) throw new Error("段评取不到（HTTP " + r.status + "）");
    let j; try { j = JSON.parse(new TextDecoder("utf-8").decode(r.bytes)); } catch(e){ throw new Error("段评返回的格式不对"); }
    if (String(j.code) !== "200") throw new Error("段评取不到：" + (j.message || j.code));
    return j.data;
  }
  async function jjComments(ch, note){
    const [novel, chapter] = [ch.url.match(/novelid=(\d+)/)[1], ch.num];
    const base = "https://www.jjwxc.net/app.jjwxc/Pc/comment/";
    let counts;
    try { counts = await getJson(base + "getNovelParagraphCommentNum?novelid=" + novel + "&chapterid=" + chapter); }
    catch(e){ return {error: e.message}; }
    const out = {};
    for (const it of (Array.isArray(counts) ? counts : [])){
      const pid = String(it.paragraph_id), total = parseInt(it.comment_total, 10) || 0;
      if (!total || (pid === "-2" && !note)) continue;
      const want = Math.min(total, ch.cmt), list = [];
      for (let off = 0; off < want; off += 50){
        try {
          const d = await getJson(base + "getCommentList?novelId=" + novel + "&chapterId=" + chapter + "&paragraph_id=" + pid + "&offset=" + off + "&limit=" + Math.min(50, want - off));
          const got = (d && d.commentList) || [];
          for (const c of got) list.push({who: String(c.commentAuthor || "").trim(), ip: String(c.ip_pos || "").trim(),
            body: clean(String(c.commentBody || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")), replies: parseInt(c.replyTotal, 10) || 0});
          if (got.length < Math.min(50, want - off)) break;
        } catch(e){ break; }
        await sleep(250);
      }
      if (list.length) out[pid] = {total, list};
      await sleep(250);
    }
    return {map: out};
  }
  function withComments(text, cm){
    if (!cm || !cm.map) return text;
    let i = 0;
    return text.split("\n").map(line => {
      if (!line.trim()) return line;
      const c = cm.map[String(++i)];
      return c ? line + "\n" + formatComments(c) : line;
    }).join("\n");
  }
  function formatComments(c){
    return "　　【段评 共 " + c.total + " 条" + (c.list.length < c.total ? "，这里收了 " + c.list.length + " 条" : "") + "】\n" +
      c.list.map(x => "　　· " + (x.who || "匿名") + (x.ip ? "（" + x.ip + "）" : "") + "：" + x.body.replace(/\n+/g, " ") + (x.replies ? "（" + x.replies + " 条回复）" : "")).join("\n");
  }

  const UNSUPPORTED = [
    [/(^|\.)qidian\.com$/, "起点的识别和下载还在做：先在上面选“起点”登录一次，下一版接上。"],
    [/(^|\.)ciweimao\.com$/, "刺猬猫的正文是加密的，这里导不了。"]
  ];
  function initialState(html){
    const i = html.indexOf("window.__INITIAL_STATE__=");
    if (i < 0) return null;
    // 从第一个 { 开始数括号，找到对应的 }，字符串里的括号不算
    let s = html.indexOf("{", i), depth = 0, inStr = false, esc = false, end = -1;
    for (let k = s; k < html.length; k++){
      const ch = html[k];
      if (inStr){ if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0){ end = k + 1; break; }
    }
    if (end < 0) return null;
    try { return JSON.parse(html.slice(s, end).replace(/([:\[,])undefined(?=[,}\]])/g, "$1null")); } catch(e){ return null; }
  }

  // 从贴进来的文字里找出网址，认出平台和书号；番茄分享短链要先问一下它跳到哪
  async function recognize(input){
    const raw = String(input).trim();
    const STOP = "[^\\s<>\"'「」【】《》，。！？）)]+";
    let m = raw.match(new RegExp("https?:\\/\\/" + STOP, "i"));
    let urlStr = m ? m[0]
      : (raw.match(new RegExp("((?:[\\w-]+\\.)+(?:com|net|cn|org))\\/" + STOP, "i")) || [])[0];
    if (urlStr && !/^https?:\/\//i.test(urlStr)) urlStr = "https://" + urlStr;
    if (!urlStr) throw new Error("没找到网址。请粘贴作品详情页的链接，或 App 里“分享”复制出来的那段文字。");
    let u = new URL(urlStr);
    if (/(^|\.)changdunovel\.com$/.test(u.hostname) && /^\/t\//.test(u.pathname)){
      const r = await get(u.href, {redirect:false});
      const loc = r.headers.location;
      if (!loc) throw new Error("这个分享短链打不开了（HTTP " + r.status + "）。");
      u = new URL(loc, u.href);
    }
    for (const [re, msg] of UNSUPPORTED) if (re.test(u.hostname)) throw new Error(msg);
    for (const key in PLATFORMS){
      const id = PLATFORMS[key].match(u);
      if (id) return {key, id};
    }
    throw new Error("认不出这个网址。目前能识别晋江、番茄的作品链接。");
  }

  /* ---------------- 平台选择和登录 ---------------- */
  const LOGIN = {jjwxc:false, qidian:false};
  let jjNickCache = null; // 晋江登录昵称，登录/退出时清掉重取
  async function jjNick(){
    if (jjNickCache !== null) return jjNickCache;
    try {
      const r = await Capacitor.nativePromise("AppTools", "get", {url:"https://www.jjwxc.net/"});
      const b = Uint8Array.from(atob(r.data || ""), c => c.charCodeAt(0));
      const html = new TextDecoder("gb18030").decode(b);
      const m = html.match(/欢迎您[，,]\s*([^<（(]{1,30}?)\s*[（(]\s*客户号/);
      jjNickCache = m ? m[1].trim() : "";
    } catch(e){ jjNickCache = ""; }
    return jjNickCache;
  }
  const SITES = {
    fanqie: {login:false, hint:"番茄不用登录，直接粘贴作品链接或分享文字。用内置引擎下载，正文是干净文字（首次会初始化几秒）。"},
    jjwxc: {login:true, check:"https://www.jjwxc.net/", logout:".jjwxc.net", mark:/^(readerid|token|bbstoken)$/i,
      page:"https://my.jjwxc.net/login.php", hint:"免费章节不用登录也能下。登录后，买过的 VIP 章节也能下（网页原样，加密字体）。"},
    qidian: {login:true, check:"https://www.qidian.com/", logout:".qidian.com", mark:/^(ywguid|ywkey)$/i,
      page:"https://passport.qidian.com/", hint:"起点打开就要人机验证。先登录一次（在登录页里正常过验证），识别和下载下一版接上。"}
  };
  let plat = "fanqie";
  try { plat = localStorage.getItem("sf:plat") || "fanqie"; } catch(e){}
  async function checkLogin(key){
    const site = SITES[key];
    if (!site.login || !NATIVE) return false;
    try { const r = await Capacitor.nativePromise("AppTools", "cookieNames", {url:site.check}); LOGIN[key] = (r.names || []).some(n => site.mark.test(n)); }
    catch(e){ LOGIN[key] = false; }
    return LOGIN[key];
  }
  async function drawPlat(){
    for (const b of document.querySelectorAll("[data-plat]")) b.setAttribute("aria-checked", b.dataset.plat === plat);
    const site = SITES[plat], name = {fanqie:"番茄", jjwxc:"晋江", qidian:"起点"}[plat];
    $("bkPlatHint").textContent = site.hint;
    $("bkInput").placeholder = {fanqie:"番茄作品链接，或 App 里“分享”复制的文字", jjwxc:"晋江作品链接，比如 jjwxc.net/onebook.php?novelid=…", qidian:"起点作品链接"}[plat];
    if (!site.login){ $("bkLogin").textContent = "不需要登录"; $("bkLoginBtn").hidden = $("bkLogoutBtn").hidden = true; return; }
    if (!NATIVE){ $("bkLogin").textContent = "登录只能在 App 里用"; $("bkLoginBtn").hidden = $("bkLogoutBtn").hidden = true; return; }
    const ok = await checkLogin(plat);
    let label = ok ? "已登录" + name : "还没登录" + name;
    if (ok && plat === "jjwxc"){ const nk = await jjNick(); if (nk) label = "已登录晋江：" + nk; }
    $("bkLogin").textContent = label;
    $("bkLoginBtn").textContent = ok ? "重新登录" : "登录" + name;
    $("bkLoginBtn").hidden = false; $("bkLogoutBtn").hidden = !ok;
  }
  for (const b of document.querySelectorAll("[data-plat]")) b.onclick = () => {
    plat = b.dataset.plat; try { localStorage.setItem("sf:plat", plat); } catch(e){}
    drawPlat();
  };
  $("bkLoginBtn").onclick = () => {
    const site = SITES[plat];
    jjNickCache = null;
    Capacitor.nativePromise("AppTools", "login", {url:site.page, ua:UA,
      hint:"在下面正常登录" + (plat === "qidian" ? "（会有人机验证，照常过就行）" : "") + "。登录成功后点右上角“登录好了”。登录状态会一直留在 App 里。"}).catch(() => {});
  };
  $("bkLogoutBtn").onclick = async () => {
    const site = SITES[plat];
    if ($("bkLogoutBtn").dataset.sure !== "1"){ $("bkLogoutBtn").dataset.sure = "1"; $("bkLogoutBtn").textContent = "再点一次确认"; return; }
    $("bkLogoutBtn").dataset.sure = ""; $("bkLogoutBtn").textContent = "退出登录";
    try { await Capacitor.nativePromise("AppTools", "logout", {url:site.check, domain:site.logout}); } catch(e){}
    jjNickCache = null;
    drawPlat();
  };
  // 从登录页回来时刷新登录状态
  document.addEventListener("visibilitychange", () => { if (!document.hidden) drawPlat(); });
  drawPlat();

  /* ---------------- 界面 ---------------- */
  let book = null, run = null;
  const ST = {wait:"·", ok:"✓", fail:"✗", skip:"—", busy:"…", nobuy:"○"};
  function setStatus(id, t, kind){ const e = $(id); e.textContent = t; e.className = "note" + (kind ? " " + kind : ""); e.hidden = !t; }

  $("bkRecognize").onclick = async () => {
    const input = $("bkInput").value.trim();
    if (!input){ setStatus("bkMsg", "先粘贴作品链接。", "warn"); return; }
    if (run && run.active){ setStatus("bkMsg", "正在下载，先暂停或等它下完。", "warn"); return; }
    $("bkRecognize").disabled = true; $("bkInfo").hidden = true; $("bkRun").hidden = true;
    setStatus("bkMsg", "正在识别…");
    try {
      const {key, id} = await recognize(input);
      if (key !== plat){ plat = key; try { localStorage.setItem("sf:plat", plat); } catch(e){} }
      await drawPlat();
      setStatus("bkMsg", "认出来了：" + PLATFORMS[key].name + "，正在读取书的信息和目录…");
      book = await PLATFORMS[key].load(id);
      book.key = key; book.platform = PLATFORMS[key].name;
      showBook();
      setStatus("bkMsg", "");
    } catch(e){ setStatus("bkMsg", (e && e.message) || String(e), "warn"); }
    $("bkRecognize").disabled = false;
  };
  $("bkInput").onkeydown = e => { if (e.key === "Enter") $("bkRecognize").click(); };

  function showBook(){
    const b = book;
    const eng = !!b.engine;
    const ok = b.chapters.filter(c => c.state === "可导").length;
    $("bkTitle").textContent = b.title;
    $("bkPlatform").textContent = b.platform;
    $("bkMeta").textContent = [b.author && "作者：" + b.author, b.status, b.words, "目录 " + b.chapters.length + " 章"].filter(Boolean).join(" · ");
    $("bkIntro").textContent = b.intro || "（没有简介）";
    $("bkAvail").textContent = eng
      ? "共 " + b.chapters.length + " 章，正文是干净文字。勾选要下的章，番茄按选中范围的首尾章整段下。"
      : "可导出 " + ok + " 章" + (b.encrypted ? "（加密原样）" : "") + "，导不了 " + (b.chapters.length - ok) + " 章。";
    setStatus("bkNotice", b.notice || "", b.notice ? "warn" : "");
    b.cmtOk = b.key === "jjwxc";
    for (const c of b.chapters){ c.pick = c.state === "可导"; c.cmt = false; }
    const firstNum = b.chapters[0] ? b.chapters[0].num : 1;
    const lastNum = b.chapters[b.chapters.length - 1] ? b.chapters[b.chapters.length - 1].num : firstNum;
    $("bkFrom").value = firstNum; $("bkTo").value = lastNum;
    $("bkFrom").max = $("bkTo").max = lastNum;
    $("bkCmtRow").hidden = !b.cmtOk;
    $("bkCmtHint").textContent = b.cmtOk ? "段评按章选：在下面每章右边勾“段评”，或者用上面的按钮批量勾。带段评会慢不少，每一段都要单独去取。"
      : "番茄用内置引擎下载，没有逐章段评。";
    $("bkAddShelf").textContent = "加入书架";
    drawPicks();
    $("bkInfo").hidden = false;
  }
  function drawPicks(){
    const b = book, box = $("bkList");
    box.textContent = "";
    const frag = document.createDocumentFragment();
    b.chapters.forEach((c, i) => {
      const can = c.state === "可导";
      const row = el("label", "ck" + (can ? "" : " off") + (b.cmtOk && can ? "" : " nocmt"));
      const pk = el("input"); pk.type = "checkbox"; pk.checked = !!c.pick; pk.disabled = !can; pk.dataset.i = i; pk.dataset.k = "pick";
      pk.setAttribute("aria-label", "下载 " + c.name);
      const nm = el("span", "nm", c.num + "  " + c.name + (can ? "" : "  （" + c.why + "）"));
      const cm = el("span", "cm"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!c.cmt; cb.disabled = !can; cb.dataset.i = i; cb.dataset.k = "cmt";
      cb.setAttribute("aria-label", "带段评 " + c.name);
      cm.append(cb, document.createTextNode("段评"));
      cm.onclick = e => e.stopPropagation();       // 点段评那一块，不要连带勾了“下载”
      row.append(pk, nm, cm);
      frag.append(row);
    });
    box.append(frag);
    countRange();
  }
  $("bkList").addEventListener("change", e => {
    const t = e.target; if (!t.dataset || t.dataset.i === undefined || !book) return;
    const c = book.chapters[+t.dataset.i];
    if (t.dataset.k === "pick"){ c.pick = t.checked; if (!c.pick && c.cmt){ c.cmt = false; drawPicks(); return; } }
    else { c.cmt = t.checked; if (c.cmt && !c.pick){ c.pick = true; drawPicks(); return; } }
    countRange();
  });
  function picked(){ return book.chapters.filter(c => c.pick && c.state === "可导"); }
  function countRange(){
    if (!book) return;
    const p = picked(), n = p.filter(c => c.cmt).length;
    let txt = "已选 " + p.length + " 章" + (book.cmtOk ? "，其中 " + n + " 章带段评" : "") + "。";
    if (book.engine && p.length){
      const nums = p.map(c => c.num), lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
      if (hi > lo) txt += "番茄按范围下，实际会下第 " + lo + "–" + hi + " 章。";
    }
    $("bkRange").textContent = txt;
    $("bkStart").disabled = !p.length;
  }
  function setAll(fn){ if (!book) return; book.chapters.forEach(c => { if (c.state === "可导") fn(c); }); drawPicks(); }
  $("bkPickAll").onclick = $("bkPickAll2").onclick = () => setAll(c => { c.pick = true; });
  $("bkPickNone").onclick = $("bkPickNone2").onclick = () => setAll(c => { c.pick = false; c.cmt = false; });
  $("bkPickRange").onclick = () => {
    const f = +$("bkFrom").value || 1, t = +$("bkTo").value || 1e9, lo = Math.min(f, t), hi = Math.max(f, t);
    setAll(c => { c.pick = c.num >= lo && c.num <= hi; if (!c.pick) c.cmt = false; });
  };
  $("bkCmtOn").onclick = () => setAll(c => { if (c.pick) c.cmt = true; });
  $("bkCmtOff").onclick = () => setAll(c => { c.cmt = false; });

  function renderList(box, rows, focus){
    box.textContent = "";
    const frag = document.createDocumentFragment();
    let target = null;
    rows.forEach((r, i) => {
      const line = el("div", "ch" + (r[0] === "✗" ? " bad" : r[0] === "—" ? " off" : ""));
      line.textContent = r[0] + " " + r[1] + "  " + r[2] + (r[3] ? "  （" + r[3] + "）" : "");
      if (i === focus) target = line;
      frag.append(line);
    });
    box.append(frag);
    if (target) box.scrollTop = Math.max(0, target.offsetTop - box.offsetTop - 60);
  }

  // 加入书架：把书的信息和目录存进书架（不含正文）。同一本书再点一次是更新，不会重复
  $("bkAddShelf").onclick = async () => {
    if (!book) return;
    const b = book;
    const lines = [b.title, "作者：" + (b.author || "未知") + "　来源：" + b.platform + "　" + b.url,
      [b.status, b.words, "目录 " + b.chapters.length + " 章"].filter(Boolean).join(" · ")];
    if (b.intro) lines.push("简介：\n" + b.intro);
    lines.push("目录：\n" + b.chapters.map(c => c.num + " " + c.name + (c.state === "可导" ? "" : "（" + c.why + "）")).join("\n"));
    try {
      await bookAdd(b.title, lines.join("\n\n") + "\n", "shelf-" + b.key + "-" + b.id,
        {kind:"catalog", platform:b.platform, url:b.url, author:b.author, chapters:b.chapters.length});
      setStatus("bkMsg", "已加入书架：《" + b.title + "》。以后在书架点“打开导书”就能回到这里。", "ok");
      $("bkAddShelf").textContent = "已在书架";
      try { await loadBooks(); } catch(e){}
    } catch(e){ setStatus("bkMsg", "没加进去：" + ((e && e.message) || e), "warn"); }
  };

  $("bkStart").onclick = () => {
    if (book && book.engine){
      const sel = picked();
      if (!sel.length){ setStatus("bkMsg", "先勾选要下载的章节。", "warn"); return; }
      startEngineDownload(sel);
      return;
    }
    const list = picked();
    if (!list.length){ setStatus("bkMsg", "这个范围里没有能导的章节。", "warn"); return; }
    const n = +$("bkCmtN").value || 5;
    run = {book, cmtN: book.cmtOk ? n : 0, list: list.map(c => Object.assign({}, c, {cmt: book.cmtOk && c.cmt ? n : 0, st:"wait", text:"", note:"", comments:null, err:""})),
      next:0, active:false, stop:false, savedId:null};
    $("bkInfo").hidden = true; $("bkRun").hidden = false; $("bkDone").hidden = true;
    loop();
  };
  $("bkPause").onclick = () => { if (run && run.engine){ run.stop = true; setStatus("bkRunMsg", "正在取消…"); return; } if (run){ run.stop = true; setStatus("bkRunMsg", "这一章下完就暂停…"); } };
  $("bkResume").onclick = () => { if (run && run.engine) return; loop(); };
  $("bkBack").onclick = () => { if (run && run.active) return; $("bkRun").hidden = true; if (book) $("bkInfo").hidden = false; };

  /* ---------------- 番茄：引擎任务式下载 ---------------- */
  async function startEngineDownload(sel){
    const b = book;
    const total = b.chapters.length || 0;
    // 番茄引擎按章节序号范围下载：取选中章里的最小/最大序号
    const nums = sel.map(c => c.num).filter(n => n > 0);
    let lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
    if (!isFinite(lo)) lo = 1;
    if (!isFinite(hi)) hi = total || 1;
    const whole = (lo <= (b.chapters[0] ? b.chapters[0].num : 1)) && (hi >= (b.chapters[b.chapters.length-1] ? b.chapters[b.chapters.length-1].num : hi));
    const payload = {id: String(b.id), book_id: String(b.id)};
    if (!whole){ payload.range_start = lo; payload.range_end = hi; }

    run = {engine:true, book:b, active:true, stop:false, jobId:null, savedId:null, savedName:null, startedAt: Date.now()};
    $("bkInfo").hidden = true; $("bkRun").hidden = false; $("bkDone").hidden = true;
    $("bkRunTitle").textContent = "《" + b.title + "》 番茄" + (whole ? "（整本）" : "（" + lo + "–" + hi + " 章）");
    $("bkRunList").textContent = "";
    $("bkPause").hidden = false; $("bkPause").textContent = "停止"; $("bkResume").hidden = true; $("bkBack").hidden = true;
    $("bkCount").textContent = "正在提交下载任务…";
    $("bkBar").style.width = "3%";
    setStatus("bkRunMsg", "正在让引擎开始下载…（首次会初始化，稍等）");
    try {
      const r = await engineJson("/api/jobs", {method:"POST", json: payload, timeout: 30000});
      if (r.status >= 400) throw new Error("建任务失败（HTTP " + r.status + "）");
      if (r.data && (r.data.id || r.data.job_id)) run.jobId = String(r.data.id || r.data.job_id);
      await pollEngineJob();
    } catch(e){
      run.active = false;
      $("bkPause").hidden = true;
      setStatus("bkRunMsg", "下载失败：" + ((e && e.message) || e), "warn");
      $("bkBack").hidden = false;
    }
  }

  async function pollEngineJob(){
    const b = book, bid = String(b.id);
    const deadline = Date.now() + 1000 * 60 * 40;   // 最多等 40 分钟
    while (Date.now() < deadline){
      if (run.stop){
        if (run.jobId){ try { await engineJson("/api/jobs/" + encodeURIComponent(run.jobId) + "/cancel", {method:"POST", timeout:8000}); } catch(e){} }
        run.active = false; $("bkPause").hidden = true;
        setStatus("bkRunMsg", "已取消。", "warn"); $("bkBack").hidden = false; return;
      }
      let job = null;
      try {
        const r = await engineJson("/api/jobs", {timeout: 10000});
        const items = (r.data && r.data.items) || (Array.isArray(r.data) ? r.data : []);
        const mine = items.filter(j => String(j.book_id) === bid || (run.jobId && String(j.id) === run.jobId));
        job = (run.jobId && mine.find(j => String(j.id) === run.jobId)) || mine[mine.length - 1] || null;
        if (job && !run.jobId) run.jobId = String(job.id);
      } catch(e){}
      if (job){
        // 待配置：引擎在等选书名/格式，自动替用户选（书名取第一个候选，格式选 txt）
        const bno = job.book_name_options || [], fmo = job.format_options || [];
        if (fmo.length){
          const pick = (fmo.find(o => /txt/i.test(o.value)) || fmo[0]).value;
          try { await engineJson("/api/jobs/" + encodeURIComponent(job.id) + "/format", {method:"POST", json:{value:pick}, timeout:10000}); } catch(e){}
          setStatus("bkRunMsg", "引擎在确认输出格式…"); await sleep(800); continue;
        }
        if (bno.length){
          const pick = bno[0].value;
          try { await engineJson("/api/jobs/" + encodeURIComponent(job.id) + "/book_name", {method:"POST", json:{value:pick}, timeout:10000}); } catch(e){}
          setStatus("bkRunMsg", "引擎在确认书名…"); await sleep(800); continue;
        }
        const st = String(job.state || "").toLowerCase();
        const saved = job.progress ? (job.progress.saved_chapters || 0) : 0;
        const total = job.progress ? (job.progress.chapter_total || 0) : 0;
        const pct = total > 0 ? Math.min(99, Math.round(100 * saved / total)) : 12;
        $("bkBar").style.width = pct + "%";
        $("bkCount").textContent = total ? ("正文保存 " + saved + " / " + total) : ("状态：" + (st || "进行中"));
        if (st === "done" || st === "success" || st === "finished" || st === "completed"){
          run.partial = total > 0 && saved < total ? (total - saved) : 0;
          $("bkBar").style.width = "99%"; $("bkPause").hidden = true;
          setStatus("bkRunMsg", "下载完成，正在取回正文…");
          await engineImport(job); return;
        }
        if (st === "failed" || st === "error"){
          run.active = false; $("bkPause").hidden = true;
          setStatus("bkRunMsg", "引擎下载失败：" + (job.error || st) + "（可以点停止后回去重试）", "warn");
          $("bkBack").hidden = false; return;
        }
        if (st === "canceled" || st === "cancelled"){
          run.active = false; $("bkPause").hidden = true;
          setStatus("bkRunMsg", "任务已取消。", "warn"); $("bkBack").hidden = false; return;
        }
        setStatus("bkRunMsg", st === "queued" ? "排队中…" : "正在下载…" + (total ? "（" + saved + "/" + total + "）" : ""));
      } else {
        setStatus("bkRunMsg", "正在下载…");
      }
      await sleep(1500);
    }
    run.active = false; $("bkPause").hidden = true;
    setStatus("bkRunMsg", "等太久了，先停了。可以回去重试。", "warn"); $("bkBack").hidden = false;
  }

  async function engineImport(job){
    const b = book;
    try {
      let text = "";
      // 主路径：让原生插件直接在 App 私有目录里找最新的 .txt 读回来（不依赖引擎的文件接口）
      try {
        const nr = await Capacitor.nativePromise("TomatoEngine", "readBook", {title: b.title, sinceMs: run.startedAt || 0});
        if (nr && nr.found && nr.base64) text = decode(Uint8Array.from(atob(nr.base64), c => c.charCodeAt(0)));
      } catch(e){}
      // 兜底：走引擎自己的文件接口
      if (!text){
        const rel = await engineFindFile(b);
        if (rel) text = await engineReadFile(rel);
      }
      if (!text || !text.trim()) throw new Error("下载完成了，但没取到正文文件（引擎日志在 files/tomato/engine.log）");
      const partial = run.partial || 0;
      const name = b.title + (partial ? "（缺 " + partial + " 章）" : "");
      run.savedName = name;
      run.savedId = await bookAdd(name, text, undefined, {platform:"番茄", url:b.url, author:b.author});
      run.active = false;
      $("bkBar").style.width = "100%";
      $("bkCount").textContent = "已存进书架：" + name;
      setStatus("bkRunMsg", "下载完成，已存进书架：" + name + (partial ? "（有 " + partial + " 章没下成）" : ""), "ok");
      $("bkDone").hidden = false; $("bkBack").hidden = false;
      try { await loadBooks(); } catch(e){}
    } catch(e){
      run.active = false;
      setStatus("bkRunMsg", "导入失败：" + ((e && e.message) || e), "warn");
      $("bkBack").hidden = false;
    }
  }

  function draw(){
    const r = run, n = r.list.length, c = {ok:0, fail:0, nobuy:0};
    r.list.forEach(x => { if (x.st in c) c[x.st]++; });
    $("bkRunTitle").textContent = "《" + r.book.title + "》 " + r.book.platform;
    $("bkCount").textContent = "已下载 " + c.ok + " / " + n + " 章" + (c.nobuy ? " · 未购买 " + c.nobuy + " 章" : "") + (c.fail ? " · 失败 " + c.fail + " 章" : "");
    $("bkBar").style.width = Math.round(100 * (c.ok + c.fail + c.nobuy) / n) + "%";
    renderList($("bkRunList"), r.list.map(x => [ST[x.st], x.num, x.name + (x.cmt ? "　[段评]" : ""), x.st === "fail" ? x.err : x.st === "nobuy" ? "未购买，晋江网页不给正文" : ""]), Math.min(r.next, n - 1));
    $("bkPause").hidden = !r.active;
    $("bkResume").hidden = r.active || r.next >= n;
    $("bkBack").hidden = r.active;
  }

  async function loop(){
    const r = run;
    if (!r || r.active) return;
    r.active = true; r.stop = false;
    const plat = PLATFORMS[r.book.key];
    let streak = 0;
    setStatus("bkRunMsg", "");
    draw();
    try {
      while (r.next < r.list.length){
        if (r.stop){ setStatus("bkRunMsg", "已暂停。点“继续”接着下。"); break; }
        const ch = r.list[r.next];
        ch.st = "busy"; draw();
        setStatus("bkRunMsg", "正在下载：" + ch.name + (ch.cmt ? "（连段评一起，会慢一点）" : ""));
        let tries = 0;
        for (;;){
          try {
            const got = await plat.chapter(ch);
            ch.text = got.text; ch.note = got.note || ""; ch.comments = got.comments || null; ch.st = got.unbought ? "nobuy" : "ok"; streak = 0;
            break;
          } catch(e){
            const msg = (e && e.message) || String(e);
            // 网络问题多试两次；正文本身有问题就直接记失败
            if (/连不上|HTTP 5|没有返回/.test(msg) && tries < 2){ tries++; await sleep(2500 * tries); continue; }
            ch.st = "fail"; ch.err = msg; streak++;
            break;
          }
        }
        r.next++;
        draw();
        if (streak >= 3){ setStatus("bkRunMsg", "连着 3 章没下成，先暂停了：" + ch.err + "。可以过一会儿点“继续”。", "warn"); break; }
        if (r.next < r.list.length) await sleep(700 + Math.random() * 700);   // 慢一点，别给网站添负担
      }
    } finally {
      r.active = false;
    }
    if (r.next >= r.list.length) await finish();
    draw();
  }

  function composeText(r){
    const b = r.book, parts = [b.title, "作者：" + (b.author || "未知") + "　来源：" + b.platform + "　" + b.url];
    if (b.intro) parts.push("简介：\n" + b.intro);
    if (r.list.some(c => c.cmt)) parts.push("【段评】带段评的章节，每段最多收 " + r.cmtN + " 条，按晋江网页的顺序。段评跟在对应段落下面，以“【段评】”开头。");
    if (b.encrypted){
      const all = r.list.filter(c => c.st === "ok").map(c => c.text).join("");
      const pua = (all.match(/[\uE000-\uF8FF]/g) || []).length;
      parts.push("【说明】这本书的正文是从" + b.platform + "网页原样保存的。网页把部分字换成了加密字体的专用编码，在普通字体里显示成空白或方框。" +
        "本文件共 " + all.length + " 字，其中加密字符 " + pua + " 个（" + (all.length ? Math.round(100 * pua / all.length) : 0) + "%），没有做还原。");
    }
    for (const c of r.list){
      if (c.st === "nobuy") { parts.push(c.name + "\n\n（这一章没买，晋江网页不给正文）"); continue; }
      if (c.st !== "ok") { parts.push(c.name + "\n\n（这一章没有导出：" + (c.err || "未下载") + "）"); continue; }
      const cm = c.comments, say = cm && cm.map && cm.map["-2"];
      parts.push(c.name + "\n\n" + withComments(c.text, cm) + (c.note ? "\n\n作者有话说：\n" + c.note + (say ? "\n" + formatComments(say) : "") : "")
        + (cm && cm.error ? "\n\n（这一章的段评没取到：" + cm.error + "）" : ""));
    }
    const lo = Math.min(...r.list.map(c => c.num)), hi = Math.max(...r.list.map(c => c.num));
    const skipped = b.chapters.filter(c => c.state !== "可导" && c.num >= lo && c.num <= hi);
    if (skipped.length) parts.push("——\n以下 " + skipped.length + " 章没有导出：\n" + skipped.map(c => c.num + " " + c.name + "（" + c.why + "）").join("\n"));
    return parts.join("\n\n\n") + "\n";
  }
  async function finish(){
    const r = run, ok = r.list.filter(c => c.st === "ok").length;
    if (!ok && r.list.some(c => c.st === "nobuy")){ setStatus("bkRunMsg", "选的章节都没买，没有可存的正文。", "warn"); return; }
    if (!ok){ setStatus("bkRunMsg", "一章都没下成，没有存进书架。", "warn"); return; }
    const name = r.book.title + (ok < r.book.chapters.length ? "（" + ok + " 章）" : "");
    r.savedId = await bookAdd(name, composeText(r), undefined, {platform:r.book.platform, url:r.book.url, author:r.book.author});
    r.savedName = name;
    setStatus("bkRunMsg", "下载完成，已存进书架：" + name, "ok");
    $("bkDone").hidden = false;
    try { await loadBooks(); } catch(e){}
  }
  $("bkSaveTxt").onclick = async () => {
    if (!run || !run.savedId) return;
    try {
      // 引擎模式没有逐章 list，直接取已存进书架的正文
      const text = run.engine ? await bookText(run.savedId) : composeText(run);
      setStatus("bkRunMsg", await fileOut("save", safe(run.savedName) + ".txt", text), "ok");
    } catch(e){ setStatus("bkRunMsg", "没存成：" + ((e && e.message) || e), "warn"); }
  };
  $("bkMakeCard").onclick = () => { if (!run || !run.savedId) return; show("card"); $("cardBook").value = run.savedId; $("cardBook").onchange && $("cardBook").onchange(); };
  $("bkShelf").onclick = () => show("shelf");
})();
