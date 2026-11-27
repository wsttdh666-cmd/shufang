/* 只读取作品公开页面里实际列出的目录链接和文字。 */
(() => {
  "use strict";
  const sites = {
    "jjwxc.net": { name: "晋江", directory: 'tr[itemprop="chapter"]', title: 'h1[itemprop="name"]', body: "#paragraph_comment_content" },
    "fanqienovel.com": { name: "番茄", directory: ".page-directory-content .chapter-item", title: ".info-name h1", body: ".muye-reader-content" },
    "qidian.com": { name: "起点", directory: ".volume-wrap li, .volume li, .catalog-content-wrap li", title: ".book-info h1 em, h1", body: ".read-content" },
    "ciweimao.com": { name: "刺猬猫", directory: ".book-chapter-list li", title: ".book-catalog h3, .book-info h1, .book-info h3, h1", body: "#J_BookRead" }
  };
  function bookUrl(value) {
    const match = value.match(/https?:\/\/[^\s<>"「」【】《》，。！？）)]+/i);
    if (!match) throw new Error("请粘贴作品详情页或目录页的网址。");
    const u = new URL(match[0]);
    const domain = u.hostname.replace(/^(www|m|wap)\./, "");
    if (!Object.prototype.hasOwnProperty.call(sites, domain) || u.username || u.password || u.port) throw new Error("链接导书目前可识别晋江、起点、番茄和刺猬猫的作品网址。");
    let id, path;
    if (domain === "jjwxc.net") {
      id = u.pathname === "/onebook.php" ? u.searchParams.get("novelid") : u.pathname.match(/^\/book2?\/(\d+)\/?$/)?.[1];
      if (id && /^\d+$/.test(id)) path = "/onebook.php?novelid=" + id;
    } else {
      const pattern = domain === "fanqienovel.com" ? /^\/page\/(\d+)\/?$/ : /^\/(?:book|chapter-list)\/(\d+)(?:\/(?:catalog|book_detail)?)?\/?$/;
      id = u.pathname.match(pattern)?.[1];
      if (id) path = domain === "fanqienovel.com" ? "/page/" + id : domain === "ciweimao.com" ? "/chapter-list/" + id + "/" : "/book/" + id + "/catalog/";
    }
    if (!path) throw new Error("这个网址里没有可识别的作品编号，请从作品详情页复制链接。");
    return { ...sites[domain], domain, id, url: "https://" + (domain === "fanqienovel.com" ? "" : "www.") + domain + path };
  }

  async function readPage(url) {
    let status, bytes;
    if (NATIVE) {
      const r = await Capacitor.nativePromise("CapacitorHttp", "request", {
        method: "GET", url, responseType: "arraybuffer", disableRedirects: true, connectTimeout: 12000, readTimeout: 20000
      });
      status = r.status;
      if (status === 200 && typeof r.data === "string") bytes = Uint8Array.from(atob(r.data), ch => ch.charCodeAt(0));
    } else {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        const r = await fetch(url, { credentials: "omit", redirect: "error", signal: controller.signal });
        status = r.status;
        if (status === 200) bytes = new Uint8Array(await r.arrayBuffer());
      } finally { clearTimeout(timer); }
    }
    if ([202, 401, 403, 429].includes(status)) throw new Error("网站要求验证、登录或暂缓访问（HTTP " + status + "）");
    if (status !== 200 || !bytes) throw new Error("网站未返回公开页面（HTTP " + status + "）");
    // template 内的外站标签保持惰性，不执行脚本，也不加载图片、字体或框架。
    const template = document.createElement("template");
    template.innerHTML = decode(bytes);
    return template.content;
  }

  function chapterUrl(site, href) {
    if (!href) return "";
    let u;
    try { u = new URL(href, site.url); } catch { return ""; }
    if (!["http:", "https:"].includes(u.protocol) || u.port || u.username || u.password) return "";
    if (u.hostname.replace(/^www\./, "") !== site.domain) return "";
    if (site.domain === "jjwxc.net") {
      const chapter = u.searchParams.get("chapterid");
      if (u.pathname !== "/onebook.php" || u.searchParams.get("novelid") !== site.id || !/^\d+$/.test(chapter || "")) return "";
      return site.url + "&chapterid=" + chapter;
    }
    const pattern = site.domain === "fanqienovel.com" ? /^\/reader\/\d+\/?$/ : site.domain === "ciweimao.com" ? /^\/chapter\/\d+\/?$/ : new RegExp("^/chapter/" + site.id + "/[0-9]+/?$");
    return pattern.test(u.pathname) ? new URL(u.pathname, site.url).href : "";
  }

  function catalog(doc, site) {
    const items = [], seen = new Set();
    for (const row of doc.querySelectorAll(site.directory)) {
      const a = row.querySelector('a[itemprop="url"], a[href*="chapterid="], a[href*="/reader/"], a[href*="/chapter/"]');
      const label = a || row.querySelector('[itemprop="headline"], [itemprop="chapterName"], td:nth-child(2)');
      const name = label?.textContent.trim();
      if (!name) continue;
      const url = chapterUrl(site, a?.getAttribute("href"));
      if (url && seen.has(url)) continue;
      seen.add(url);
      const locked = !url || !!row.querySelector('.icon-lock, .iconfont-lock, [class*="vip" i], [title*="VIP" i], [alt*="VIP" i], [src*="/vip" i]') || /\bVIP\b|锁定章节|付费章节/i.test(label.textContent);
      items.push({name, url, state: locked ? "目录标记受限" : "待导入"});
    }
    if (!items.length) throw new Error("没有读到公开目录，网站可能要求验证，或目录需要在网页里加载。");
    const title = doc.querySelector('meta[property="og:novel:book_name"]')?.content || doc.querySelector(site.title)?.textContent.trim() || "作品 " + site.id;
    return {title, items};
  }

  function chapterText(doc, site) {
    const body = doc.querySelector(site.body);
    if (!body) throw new Error("网页未提供可导出的正文");
    if (doc.querySelector(".vip-limit-wrap, .subscribe-wrap, .read-limit, .paywall") ||
        /购买本章|订阅本章|订阅后(?:可|继续)阅读|仅供试读|试读结束|本章为VIP章节|打开.{0,6}APP.{0,6}继续阅读/i.test(body.textContent))
      throw new Error("需要订阅或仅有试读");
    body.querySelectorAll("script, style, noscript, template, button, [hidden], [aria-hidden=true], .watermark, [style*='display:none' i], [style*='display: none' i]").forEach(n => n.remove());
    body.querySelectorAll("br").forEach(n => n.replaceWith("\n"));
    body.querySelectorAll("p, div").forEach(n => n.append("\n"));
    const text = body.textContent.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join("\n\n");
    if (!text) throw new Error("网页没有直接提供文字");
    if (/[\uE000-\uF8FF\uFFFD]/u.test(text)) throw new Error("正文含专用字体编码或乱码");
    return text;
  }

  let job, busy = false, pause = false;
  const status = $("linkStatus");
  function controls() {
    $("linkStart").disabled = busy;
    $("bookLink").disabled = busy;
    $("linkPause").hidden = !busy || !job;
    $("linkSave").hidden = busy || !job?.count || !!job.saved;
    $("linkDownload").hidden = busy || !job?.saved;
    $("linkDetails").hidden = !job;
    $("linkStart").textContent = job && !job.finished && job.input === $("bookLink").value.trim() ? "继续导入" : "解析并导入";
  }
  function report() {
    if (job && $("linkDetails").open) $("linkChapters").textContent = job.items.map((x,i) => (i+1) + ". " + x.name + " · " + x.state).join("\n");
  }
  function resultName() {
    return job.title + (job.count < job.items.length ? "（已导入 " + job.count + " 章）" : "");
  }
  async function saveBook() {
    const text = [job.title, ...job.items.filter(x => x.text).map(x => x.name + "\n\n" + x.text)].join("\n\n");
    await bookAdd(resultName(), text, job.key);
    job.saved = true;
    await loadBooks();
  }

  $("bookLink").oninput = controls;
  $("linkDetails").ontoggle = report;
  $("linkPause").onclick = () => { pause = true; status.textContent = "正在收尾，当前章节读完后暂停。"; };
  $("linkStart").onclick = async () => {
    if (busy) return;
    busy = true; pause = false;
    const input = $("bookLink").value.trim();
    try {
      if (job && job.input !== input) {
        if (job.count && !job.saved) await saveBook();
        job = null;
        $("linkChapters").textContent = "";
      }
      const site = bookUrl(input);
      if (!job || job.input !== input || job.finished) {
        controls();
        status.textContent = "正在读取" + site.name + "的公开目录…";
        const data = catalog(await readPage(site.url), site);
        job = {...data, input, next:0, count:0, key:"link-" + Date.now().toString(36) + Math.random().toString(36).slice(2), saved:false, finished:false};
      }
      controls();
      let failures = 0;
      while (job.next < job.items.length && !pause) {
        const item = job.items[job.next];
        if (item.state === "目录标记受限") { job.next++; continue; }
        status.textContent = job.title + " · " + (job.next+1) + "/" + job.items.length + " · " + item.name;
        try {
          item.text = chapterText(await readPage(item.url), site);
          item.state = "已读取"; job.count++; job.next++; job.saved = false; failures = 0;
        } catch (e) {
          item.state = e.message || "连接失败";
          if (!/^(网页未提供|网页没有|需要订阅|正文含)/.test(item.state)) {
            throw new Error(item.name + "：" + item.state + "。已暂停，可稍后继续。");
          }
          job.next++;
          if (++failures >= 2 && job.next < job.items.length) {
            status.textContent = "连续两章无法导入，已暂停：" + item.state + "。可查看章节详情或继续后续章节。";
            report(); return;
          }
        }
        report();
        if (!pause && job.next < job.items.length) await new Promise(r => setTimeout(r, 450));
      }
      job.finished = job.next === job.items.length;
      if (job.finished && job.count && !job.saved) await saveBook();
      const summary = "已读取 " + job.count + " 章，" + (job.next-job.count) + " 章未收录。";
      status.textContent = job.finished ? summary + (job.saved ? "已存入书架。" : "展开章节可查看原因。") : "已暂停，" + summary;
    } catch (e) {
      status.textContent = e.message || "没有连上作品网站，请稍后再试。";
    } finally { busy = false; report(); controls(); }
  };
  $("linkSave").onclick = async () => {
    if (busy || !job?.count) return;
    busy = true; controls();
    try { await saveBook(); status.textContent = "已将 " + job.count + " 章存入书架。"; }
    catch (e) { status.textContent = "书架保存失败：" + e.message; }
    finally { busy = false; controls(); }
  };
  $("linkDownload").onclick = async () => {
    if (busy || !job?.saved) return;
    busy = true; controls();
    try { status.textContent = await fileOut("save", safe(resultName()) + ".txt", await bookText(job.key)); }
    catch (e) { status.textContent = "文件保存失败：" + e.message; }
    finally { busy = false; controls(); }
  };
})();
