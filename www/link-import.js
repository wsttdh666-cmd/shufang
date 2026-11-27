/* 导书：贴作品链接 → 认出平台和书 → 看书的信息和目录、选章节 → 下载 → 存进书架。
   只收网页上直接给出的文字；VIP、加密字体之类的章节如实标出来，不导。 */
(() => {
  "use strict";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const PRIVATE_USE = /[-]/;

  /* ---------------- 联网 ---------------- */
  async function get(url, {redirect = true} = {}){
    let r;
    if (NATIVE){
      try {
        r = await Capacitor.nativePromise("CapacitorHttp", "request", {
          method:"GET", url, headers:{"User-Agent":UA, "Accept":"text/html,*/*"}, responseType:"arraybuffer",
          disableRedirects:!redirect, connectTimeout:15000, readTimeout:30000
        });
      } catch(e){ throw new Error("连不上网站：" + ((e && e.message) || e)); }
      const bytes = typeof r.data === "string" ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) : new Uint8Array(0);
      const h = {}; for (const k in (r.headers || {})) h[k.toLowerCase()] = r.headers[k];
      return {status:r.status, headers:h, bytes, url:r.url || url};
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
          const vip = /onebook_vip/.test(a?.getAttribute("rel") || "") || /\[VIP\]/i.test(tds[1]?.textContent || "");
          let state = "可导", why = "";
          if (vip){ state = "不可导"; why = "VIP 章节（正文是加密字体）"; }
          else if (!/chapterid=\d+/.test(href)){ state = "不可导"; why = "章节被锁或已删除"; }
          chapters.push({num, name, note: clean(tds[2]?.textContent), state, why,
            url: state === "可导" ? "https://www.jjwxc.net/onebook.php?novelid=" + id + "&chapterid=" + num : ""});
        }
        if (!chapters.length) throw new Error("没读到目录。");
        return {
          id, url, title,
          author: q('[itemprop="author"]')?.textContent.trim() || "",
          status: q('[itemprop="updataStatus"]')?.textContent.trim() || "",
          words, intro: textOf(q("#novelintro")), chapters,
          notice: chapters.some(c => c.why.startsWith("VIP")) ? "晋江的 VIP 章节正文用了加密字体，这里只导免费章节。" : ""
        };
      },
      async chapter(ch){
        const {doc} = await page(ch.url);
        const body = doc.querySelector("#paragraph_comment_content");
        if (!body) throw new Error("页面上没有正文");
        const text = textOf(body);
        if (!text) throw new Error("正文是空的");
        if (PRIVATE_USE.test(text)) throw new Error("正文是加密字体");
        let note = "";
        const ns = doc.querySelector("#note_str");
        if (ns){ const box = doc.createElement("div"); box.innerHTML = ns.innerHTML || ns.textContent; note = textOf(box); }
        return {text, note};
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
        (p.chapterListWithVolume || []).flat().forEach((c, i) => chapters.push({
          num: parseInt(c.realChapterOrder, 10) || i + 1, name: c.title || ("第" + (i + 1) + "章"), state: "不可导",
          why: c.isChapterLock || c.needPay ? "付费章节" : "网页正文是加密字体", url: "https://fanqienovel.com/reader/" + c.itemId
        }));
        return {
          id, url, title: p.bookName, author: p.author || "", status: p.creationStatus === 0 ? "已完结" : "连载中",
          words: p.wordNumber ? wanzi(p.wordNumber) : "",
          intro: clean(p.abstract), chapters,
          notice: "番茄网页版每一章的正文都换成了加密字体，自己做的导书读不出原文，所以这本只能看信息和目录。"
        };
      }
    }
  };
  const UNSUPPORTED = [
    [/(^|\.)qidian\.com$/, "起点打开就要人机验证，这里暂时取不到页面。"],
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

  /* ---------------- 界面 ---------------- */
  let book = null, run = null;
  const ST = {wait:"·", ok:"✓", fail:"✗", skip:"—", busy:"…"};
  function setStatus(id, t, kind){ const e = $(id); e.textContent = t; e.className = "note" + (kind ? " " + kind : ""); e.hidden = !t; }

  $("bkRecognize").onclick = async () => {
    const input = $("bkInput").value.trim();
    if (!input){ setStatus("bkMsg", "先粘贴作品链接。", "warn"); return; }
    if (run && run.active){ setStatus("bkMsg", "正在下载，先暂停或等它下完。", "warn"); return; }
    $("bkRecognize").disabled = true; $("bkInfo").hidden = true; $("bkRun").hidden = true;
    setStatus("bkMsg", "正在识别…");
    try {
      const {key, id} = await recognize(input);
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
    $("bkAvail").textContent = "可导出 " + ok + " 章，导不了 " + (b.chapters.length - ok) + " 章。";
    setStatus("bkNotice", b.notice || "", b.notice ? "warn" : "");
    const first = b.chapters.find(c => c.state === "可导"), last = [...b.chapters].reverse().find(c => c.state === "可导");
    $("bkFrom").value = first ? first.num : 1; $("bkTo").value = last ? last.num : b.chapters.length;
    $("bkFrom").max = $("bkTo").max = b.chapters[b.chapters.length - 1].num;
    $("bkStart").disabled = !ok;
    renderList($("bkList"), b.chapters.map(c => [c.state === "可导" ? "·" : "—", c.num, c.name, c.state === "可导" ? "" : c.why]));
    countRange();
    $("bkAddShelf").textContent = "加入书架";
    $("bkInfo").hidden = false;
  }
  function picked(){
    const from = +$("bkFrom").value || 1, to = +$("bkTo").value || 1e9;
    return book.chapters.filter(c => c.num >= Math.min(from, to) && c.num <= Math.max(from, to) && c.state === "可导");
  }
  function countRange(){ if (book) $("bkRange").textContent = "这个范围里能导 " + picked().length + " 章。"; }
  $("bkFrom").oninput = $("bkTo").oninput = countRange;
  $("bkAll").onclick = () => { $("bkFrom").value = book.chapters[0].num; $("bkTo").value = book.chapters[book.chapters.length - 1].num; countRange(); };

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
    run = {book, from: +$("bkFrom").value, to: +$("bkTo").value, list: list.map(c => Object.assign({}, c, {st:"wait", text:"", note:"", err:""})), next:0, active:false, stop:false, savedId:null};
    $("bkInfo").hidden = true; $("bkRun").hidden = false; $("bkDone").hidden = true;
    loop();
  };
  $("bkPause").onclick = () => { if (run){ run.stop = true; setStatus("bkRunMsg", "这一章下完就暂停…"); } };
  $("bkResume").onclick = () => loop();
  $("bkBack").onclick = () => { if (run && run.active) return; $("bkRun").hidden = true; if (book) $("bkInfo").hidden = false; };

  function draw(){
    const r = run, n = r.list.length, c = {ok:0, fail:0};
    r.list.forEach(x => { if (x.st === "ok") c.ok++; else if (x.st === "fail") c.fail++; });
    $("bkRunTitle").textContent = "《" + r.book.title + "》 " + r.book.platform;
    $("bkCount").textContent = "已下载 " + c.ok + " / " + n + " 章" + (c.fail ? " · 失败 " + c.fail + " 章" : "");
    $("bkBar").style.width = Math.round(100 * (c.ok + c.fail) / n) + "%";
    renderList($("bkRunList"), r.list.map(x => [ST[x.st], x.num, x.name, x.st === "fail" ? x.err : ""]), Math.min(r.next, n - 1));
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
        setStatus("bkRunMsg", "正在下载：" + ch.name);
        let tries = 0;
        for (;;){
          try {
            const got = await plat.chapter(ch);
            ch.text = got.text; ch.note = got.note || ""; ch.st = "ok"; streak = 0;
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
    for (const c of r.list){
      if (c.st !== "ok") { parts.push(c.name + "\n\n（这一章没有导出：" + (c.err || "未下载") + "）"); continue; }
      parts.push(c.name + "\n\n" + c.text + (c.note ? "\n\n作者有话说：\n" + c.note : ""));
    }
    const lo = Math.min(...r.list.map(c => c.num)), hi = Math.max(...r.list.map(c => c.num));
    const skipped = b.chapters.filter(c => c.state !== "可导" && c.num >= lo && c.num <= hi);
    if (skipped.length) parts.push("——\n以下 " + skipped.length + " 章没有导出：\n" + skipped.map(c => c.num + " " + c.name + "（" + c.why + "）").join("\n"));
    return parts.join("\n\n\n") + "\n";
  }
  async function finish(){
    const r = run, ok = r.list.filter(c => c.st === "ok").length;
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
