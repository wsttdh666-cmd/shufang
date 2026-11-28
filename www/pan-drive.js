/* pan-drive.js: 夸克 / UC 网盘「一键转存 → 下载 → 入书架」
   登录一次（WebView，cookie 长期保存在 CookieManager），之后转存不用再登录。
   依赖全局：NATIVE, decode, bookAdd, loadBooks。接口形态已在真机验证。*/
(() => {
  "use strict";
  if (typeof NATIVE === "undefined" || !NATIVE) return;   // 只在 App 里可用
  const UA = navigator.userAgent;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 各网盘的接口配置（夸克已验证；UC 同一家、接口几乎相同，可能需按实测微调）
  const PROVIDERS = {
    quark: {
      name: "夸克网盘", api: "https://drive-pc.quark.cn/1/clouddrive",
      param: "pr=ucpro&fr=pc&uc_param_str=", referer: "https://pan.quark.cn/",
      loginUrl: "https://pan.quark.cn/", shareRe: /pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/
    },
    uc: {
      name: "UC网盘", api: "https://pc-api.uc.cn/1/clouddrive",
      param: "pr=UCBrowser&fr=pc&uc_param_str=", referer: "https://drive.uc.cn/",
      loginUrl: "https://drive.uc.cn/", shareRe: /drive\.uc\.cn\/s\/([0-9a-zA-Z]+)/
    }
  };

  function provOf(url) {
    for (const k in PROVIDERS) if (PROVIDERS[k].shareRe.test(String(url || ""))) return PROVIDERS[k];
    return null;
  }
  // 供 index.html 的 renderPan 判断要不要显示"转存入书架"按钮
  window.panCanSave = url => !!provOf(url);

  // 调网盘 JSON 接口：走原生 get（带 CookieManager 登录态、支持 POST）
  async function api(prov, method, path, qs, body) {
    const url = prov.api + path + "?" + prov.param + (qs ? "&" + qs : "");
    let r;
    try {
      r = await Capacitor.nativePromise("AppTools", "get", {
        url, redirect: true, ua: UA, method, referer: prov.referer,
        data: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) { throw new Error("连不上网盘：" + ((e && e.message) || e)); }
    const bytes = r.data ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) : new Uint8Array(0);
    let j; try { j = JSON.parse(new TextDecoder("utf-8").decode(bytes)); }
    catch (e) { throw new Error("网盘返回异常（HTTP " + r.status + "）"); }
    return j;
  }

  async function loggedIn(prov) {
    try { const j = await api(prov, "GET", "/member", "", undefined); return j && j.code === 0; }
    catch (e) { return false; }
  }

  const pwdId = (prov, url) => { const m = String(url).match(prov.shareRe); return m ? m[1] : null; };

  async function shareToken(prov, pid, passcode) {
    const j = await api(prov, "POST", "/share/sharepage/token", "", { pwd_id: pid, passcode: passcode || "" });
    if (j.code !== 0 || !j.data || !j.data.stoken) throw new Error("分享失效或需提取码（" + (j.message || j.code) + "）");
    return j.data.stoken;
  }

  async function shareList(prov, pid, stoken) {
    const j = await api(prov, "GET", "/share/sharepage/detail",
      "pwd_id=" + pid + "&stoken=" + encodeURIComponent(stoken) + "&pdir_fid=0&force=0&_page=1&_size=200&_fetch_banner=0&_fetch_share=0&_fetch_total=1&_sort=file_type:asc,updated_at:desc", undefined);
    if (j.code !== 0 || !j.data) throw new Error("读不到分享内容（" + (j.message || j.code) + "）");
    return j.data.list || [];
  }

  async function saveToDrive(prov, pid, stoken, files) {
    const j = await api(prov, "POST", "/share/sharepage/save", "", {
      fid_list: files.map(f => f.fid), fid_token_list: files.map(f => f.share_fid_token),
      to_pdir_fid: "0", pwd_id: pid, stoken: stoken, pdir_fid: "0", pdir_save_all: false, exclude_fids: [], scene: "link"
    });
    if (j.code !== 0 || !j.data || !j.data.task_id) throw new Error("转存失败（" + (j.message || j.code) + "）");
    return j.data.task_id;
  }

  async function pollTask(prov, taskId) {
    for (let i = 0; i < 40; i++) {
      const j = await api(prov, "GET", "/task", "task_id=" + taskId + "&retry_index=" + i, undefined);
      if (j.code === 0 && j.data && j.data.status === 2)
        return (j.data.save_as && j.data.save_as.save_as_top_fids) || [];
      await sleep(800);
    }
    throw new Error("转存等太久了");
  }

  async function downloadUrl(prov, fid) {
    const j = await api(prov, "POST", "/file/download", "", { fids: [fid] });
    if (j.code !== 0 || !j.data || !j.data[0] || !j.data[0].download_url) throw new Error("取下载地址失败（" + (j.message || j.code) + "）");
    return j.data[0].download_url;
  }

  async function fetchTxt(prov, url) {
    const r = await Capacitor.nativePromise("AppTools", "get", { url, redirect: true, ua: UA, referer: prov.referer });
    if (r.status !== 200) throw new Error("下载失败（HTTP " + r.status + "）");
    const bytes = r.data ? Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) : new Uint8Array(0);
    return decode(bytes);   // 全局 decode：自动识别 utf-8/gbk
  }

  function cleanName(note) {
    return String(note || "")
      .replace(/\.txt$/i, "")
      .replace(/[\[【][^\]】]*[\]】]/g, "")
      .replace(/作者[:：].*$/, "")
      .replace(/《|》/g, "")
      .replace(/\s+/g, " ").trim().slice(0, 40) || "网盘下载";
  }

  // 全局：转存一个网盘分享到书架。it = {url, password, note}；btn 用来显示进度
  window.panSave = async (it, btn) => {
    const prov = provOf(it.url);
    if (!prov) { btn.textContent = "不支持这个网盘"; return; }
    const orig = btn.dataset.orig || btn.textContent;
    btn.dataset.orig = orig;
    btn.disabled = true;
    try {
      if (!(await loggedIn(prov))) {
        btn.textContent = "需登录…";
        try {
          await Capacitor.nativePromise("AppTools", "login", {
            url: prov.loginUrl, ua: UA,
            hint: "登录" + prov.name + "。登录成功后点右上角“登录好了”。登录一次，以后转存不用再登录。"
          });
        } catch (e) { }
        if (!(await loggedIn(prov))) { btn.textContent = "没登录成功，再点一次"; btn.disabled = false; return; }
      }
      btn.textContent = "读取分享…";
      const pid = pwdId(prov, it.url);
      if (!pid) throw new Error("分享链接不对");
      const stoken = await shareToken(prov, pid, it.password);
      const list = await shareList(prov, pid, stoken);
      const files = list.filter(f => !f.dir);
      const txts = files.filter(f => /\.(txt|epub)$/i.test(f.file_name));
      const pick = txts.length ? txts : files;
      if (!pick.length) throw new Error("分享里没有文件（可能是文件夹，暂不支持）");

      btn.textContent = "转存中…";
      const taskId = await saveToDrive(prov, pid, stoken, pick);
      const saved = await pollTask(prov, taskId);
      const fids = saved.length ? saved : pick.map(f => f.fid);

      let all = "";
      for (let i = 0; i < fids.length; i++) {
        btn.textContent = fids.length > 1 ? "下载中 " + (i + 1) + "/" + fids.length : "下载中…";
        const url = await downloadUrl(prov, fids[i]);
        const t = await fetchTxt(prov, url);
        if (t && t.trim()) all += (all ? "\n\n\n" : "") + t;
      }
      if (!all.trim()) throw new Error("下载到的内容是空的");

      btn.textContent = "入书架…";
      await bookAdd(cleanName(it.note), all, undefined, { platform: prov.name });
      btn.textContent = "✓ 已入书架";
      try { await loadBooks(); } catch (e) { }
    } catch (e) {
      btn.textContent = "失败：" + (((e && e.message) || String(e)).slice(0, 24));
      btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 4500);
    }
  };
})();
