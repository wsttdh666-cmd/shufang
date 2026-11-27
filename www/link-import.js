/* 导书：贴作品链接 → 认出平台和书 → 看书的信息和目录、选章节 → 下载 → 存进书架。
   只收网页上直接给出的文字；VIP、加密字体之类的章节如实标出来，不导。 */
(() => {
  "use strict";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

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
            : LOGIN.jjwxc ? "VIP 章节下载的是网页原样（加密字体，一部分字会显示成空白或方框），不做还原。没买的章节晋江网页不给正文，会标成“未购买”，txt 里保留章节名。"
            : "这本有 VIP 章节。登录晋江后，买过的 VIP 章节也能下（网页原样，加密字体）。"
        };
      },
      async chapter(ch){
        const {doc, html} = await page(ch.url);
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
    const m = String(input).match(/https?:\/\/[^\s<>"'「」【】《》，。！？）)]+/i);
    if (!m) throw new Error("没找到网址。请粘贴作品详情页的链接，或 App 里“分享”复制出来的那段文字。");
    let u = new URL(m[0]);
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
  const SITES = {
    fanqie: {login:false, hint:"番茄不用登录，直接粘贴作品链接或分享文字。正文是加密字体，下载的是网页原样。"},
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
    $("bkLogin").textContent = ok ? "已登录" + name : "还没登录" + name;
    $("bkLoginBtn").textContent = ok ? "重新登录" : "登录" + name;
    $("bkLoginBtn").hidden = false; $("bkLogoutBtn").hidden = !ok;
  }
  for (const b of document.querySelectorAll("[data-plat]")) b.onclick = () => {
    plat = b.dataset.plat; try { localStorage.setItem("sf:plat", plat); } catch(e){}
    drawPlat();
  };
  $("bkLoginBtn").onclick = () => {
    const site = SITES[plat];
    Capacitor.nativePromise("AppTools", "login", {url:site.page, ua:UA,
      hint:"在下面正常登录" + (plat === "qidian" ? "（会有人机验证，照常过就行）" : "") + "。登录成功后点右上角“登录好了”。登录状态会一直留在 App 里。"}).catch(() => {});
  };
  $("bkLogoutBtn").onclick = async () => {
    const site = SITES[plat];
    if ($("bkLogoutBtn").dataset.sure !== "1"){ $("bkLogoutBtn").dataset.sure = "1"; $("bkLogoutBtn").textContent = "再点一次确认"; return; }
    $("bkLogoutBtn").dataset.sure = ""; $("bkLogoutBtn").textContent = "退出登录";
    try { await Capacitor.nativePromise("AppTools", "logout", {url:site.check, domain:site.logout}); } catch(e){}
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
    const b = book, ok = b.chapters.filter(c => c.state === "可导").length;
    $("bkTitle").textContent = b.title;
    $("bkPlatform").textContent = b.platform;
    $("bkMeta").textContent = [b.author && "作者：" + b.author, b.status, b.words, "目录 " + b.chapters.length + " 章"].filter(Boolean).join(" · ");
    $("bkIntro").textContent = b.intro || "（没有简介）";
    $("bkAvail").textContent = "可导出 " + ok + " 章" + (b.encrypted ? "（加密原样）" : "") + "，导不了 " + (b.chapters.length - ok) + " 章。";
    setStatus("bkNotice", b.notice || "", b.notice ? "warn" : "");
    b.cmtOk = b.key === "jjwxc";
    for (const c of b.chapters){ c.pick = c.state === "可导"; c.cmt = false; }
    $("bkFrom").value = b.chapters[0].num; $("bkTo").value = b.chapters[b.chapters.length - 1].num;
    $("bkFrom").max = $("bkTo").max = b.chapters[b.chapters.length - 1].num;
    $("bkCmtRow").hidden = !b.cmtOk;
    $("bkCmtHint").textContent = b.cmtOk ? "段评按章选：在下面每章右边勾“段评”，或者用上面的按钮批量勾。带段评会慢不少，每一段都要单独去取。"
      : "番茄网页版没有段评（只有番茄 App 里有），所以这里不能带。";
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
    $("bkRange").textContent = "已选 " + p.length + " 章" + (book.cmtOk ? "，其中 " + n + " 章带段评" : "") + "。";
    $("bkStart").disabled = !p.length;
  }
  function setAll(fn){ if (!book) return; book.chapters.forEach(c => { if (c.state === "可导") fn(c); }); drawPicks(); }
  $("bkPickAll").onclick = () => setAll(c => { c.pick = true; });
  $("bkPickNone").onclick = () => setAll(c => { c.pick = false; c.cmt = false; });
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
    const list = picked();
    if (!list.length){ setStatus("bkMsg", "这个范围里没有能导的章节。", "warn"); return; }
    const n = +$("bkCmtN").value || 5;
    run = {book, cmtN: book.cmtOk ? n : 0, list: list.map(c => Object.assign({}, c, {cmt: book.cmtOk && c.cmt ? n : 0, st:"wait", text:"", note:"", comments:null, err:""})),
      next:0, active:false, stop:false, savedId:null};
    $("bkInfo").hidden = true; $("bkRun").hidden = false; $("bkDone").hidden = true;
    loop();
  };
  $("bkPause").onclick = () => { if (run){ run.stop = true; setStatus("bkRunMsg", "这一章下完就暂停…"); } };
  $("bkResume").onclick = () => loop();
  $("bkBack").onclick = () => { if (run && run.active) return; $("bkRun").hidden = true; if (book) $("bkInfo").hidden = false; };

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
    try { setStatus("bkRunMsg", await fileOut("save", safe(run.savedName) + ".txt", composeText(run)), "ok"); }
    catch(e){ setStatus("bkRunMsg", "没存成：" + ((e && e.message) || e), "warn"); }
  };
  $("bkMakeCard").onclick = () => { if (!run || !run.savedId) return; show("card"); $("cardBook").value = run.savedId; $("cardBook").onchange && $("cardBook").onchange(); };
  $("bkShelf").onclick = () => show("shelf");
})();
