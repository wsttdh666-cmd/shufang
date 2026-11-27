// 书房在站内浏览器里最先运行的一小段：给「小说下载器」脚本准备它要的几样东西，并把它导出的文件接进 App。
// ShufangBridge 是 App 提供的原生接口（见 ScriptActivity.java）。
(function () {
  if (window.__sf || window.top !== window || typeof ShufangBridge === "undefined") return;
  var B = ShufangBridge;
  window.__sf = 1;
  // 只有脚本支持的页面（书的详情页）才真正运行脚本和它的依赖库
  window.__sfRun = false;
  try { window.__sfRun = !!B.matches(location.href.split("#")[0]); } catch (e) {}
  if (!window.__sfRun) return;

  // ---- 脚本自己的设置（GM_setValue 那一套）
  var store = {};
  try { store = JSON.parse(B.values() || "{}") || {}; } catch (e) {}
  function flush() { try { B.setValues(JSON.stringify(store)); } catch (e) {} }
  function getValue(k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; }
  function setValue(k, v) { store[k] = v; flush(); }
  function deleteValue(k) { delete store[k]; flush(); }

  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function charsetOf(s) { var m = /charset\s*=\s*["']?([\w-]+)/i.exec(s || ""); return m ? m[1] : ""; }
  function decode(bytes, charset) {
    try { return new TextDecoder(charset || "utf-8").decode(bytes); } catch (e) { return new TextDecoder("utf-8").decode(bytes); }
  }

  // ---- 跨站请求（GM_xmlhttpRequest）：交给 App 去发，带着你在这个浏览器里的登录状态
  var seq = 0, pending = {};
  function bodyOf(d, headers) {
    var x = d.data;
    if (x == null) return null;
    if (typeof x === "string") return x;
    var has = Object.keys(headers).some(function (k) { return k.toLowerCase() === "content-type"; });
    if (typeof URLSearchParams !== "undefined" && x instanceof URLSearchParams) {
      if (!has) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      return x.toString();
    }
    if (typeof FormData !== "undefined" && x instanceof FormData) {
      var p = new URLSearchParams();
      x.forEach(function (v, k) { if (typeof v === "string") p.append(k, v); });
      if (!has) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      return p.toString();
    }
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }
  function xhr(d) {
    var id = ++seq, headers = {};
    for (var k in (d.headers || {})) headers[k] = String(d.headers[k]);
    pending[id] = d;
    var req = {
      url: new URL(d.url, location.href).href, method: (d.method || "GET").toUpperCase(), headers: headers,
      data: bodyOf(d, headers), timeout: d.timeout || 0, anonymous: !!d.anonymous, cookie: d.cookie || "", referer: location.href
    };
    try { B.xhr(id, JSON.stringify(req)); }
    catch (e) { delete pending[id]; if (d.onerror) setTimeout(function () { d.onerror({ error: String(e) }); }, 0); }
    return { abort: function () { delete pending[id]; } };
  }
  // App 发完请求后回调这里；正文单独去取，避免一次塞太长的字符串
  window.__sfXhrDone = function (id, meta) {
    var d = pending[id]; delete pending[id];
    var b64 = ""; try { b64 = B.xhrBody(id) || ""; } catch (e) {}
    if (!d) return;
    if (meta.error) {
      var fail = { error: meta.error, status: 0, statusText: "", finalUrl: meta.finalUrl || d.url, context: d.context };
      var cb = (meta.timeout && d.ontimeout) || d.onerror;
      if (cb) cb(fail);
      return;
    }
    var bytes = b64ToBytes(b64), type = meta.contentType || "", rt = (d.responseType || "").toLowerCase();
    var r = { status: meta.status, statusText: meta.statusText || "", readyState: 4, responseHeaders: meta.headers || "", finalUrl: meta.finalUrl || d.url, context: d.context };
    var text = null;
    function asText() { if (text === null) text = decode(bytes, charsetOf(d.overrideMimeType) || charsetOf(type)); return text; }
    try {
      if (rt === "arraybuffer") r.response = bytes.buffer;
      else if (rt === "blob") r.response = new Blob([bytes], { type: (d.overrideMimeType || type || "application/octet-stream").split(";")[0] });
      else if (rt === "json") { r.responseText = asText(); try { r.response = JSON.parse(r.responseText); } catch (e) { r.response = null; } }
      else if (rt === "document") { r.responseText = asText(); r.response = new DOMParser().parseFromString(r.responseText, "text/html"); r.responseXML = r.response; }
      else { r.responseText = asText(); r.response = r.responseText; }
    } catch (e) { if (d.onerror) d.onerror({ error: String(e), status: meta.status, finalUrl: r.finalUrl, context: d.context }); return; }
    if (d.onreadystatechange) { try { d.onreadystatechange(r); } catch (e) {} }
    if (d.onload) d.onload(r);
    if (d.onloadend) { try { d.onloadend(r); } catch (e) {} }
  };

  var info = { scriptHandler: "Shufang", version: "1.0", script: { name: "小说下载器", version: String(B.scriptVersion() || "") } };
  window.__sfGM = {
    info: info, xhr: xhr, getValue: getValue, setValue: setValue, deleteValue: deleteValue,
    GM: {
      info: info, xmlHttpRequest: xhr,
      getValue: function (k, d) { return Promise.resolve(getValue(k, d)); },
      setValue: function (k, v) { setValue(k, v); return Promise.resolve(); },
      deleteValue: function (k) { deleteValue(k); return Promise.resolve(); }
    }
  };

  // ---- 接住脚本导出的文件：它是用「点一个带 download 的链接」来保存的，这里改成交给 App
  var blobs = {};
  var rawCreate = URL.createObjectURL, rawRevoke = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var u = rawCreate.call(URL, obj);
    if (obj instanceof Blob) blobs[u] = obj;
    return u;
  };
  URL.revokeObjectURL = function (u) {
    // 脚本会在稍后回收地址；文件还在往 App 里送的时候先留着
    setTimeout(function () { delete blobs[u]; }, 120000);
    return rawRevoke.call(URL, u);
  };
  function send(name, blob) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var bytes = new Uint8Array(fr.result), id = B.fileBegin(String(name || "未命名"), blob.type || ""), step = 262144;
        for (var i = 0; i < bytes.length; i += step) {
          var part = bytes.subarray(i, i + step), s = "";
          for (var j = 0; j < part.length; j += 32768) s += String.fromCharCode.apply(null, part.subarray(j, j + 32768));
          B.fileChunk(id, btoa(s));
        }
        B.fileEnd(id);
      } catch (e) { try { B.note("文件没接住：" + e); } catch (e2) {} }
    };
    fr.onerror = function () { try { B.note("文件读不出来"); } catch (e) {} };
    fr.readAsArrayBuffer(blob);
  }
  function capture(a) {
    if (!a || !a.hasAttribute || !a.hasAttribute("download")) return false;
    var blob = blobs[a.href];
    if (!blob) return false;
    send(a.download, blob);
    return true;
  }
  var rawClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (capture(this)) return; return rawClick.apply(this, arguments); };
  var rawDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    if (ev && ev.type === "click" && this instanceof HTMLAnchorElement && capture(this)) return true;
    return rawDispatch.apply(this, arguments);
  };
  // 真的被手指点到的下载链接（脚本界面里也可能有）
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[download]") : null;
    if (a && capture(a)) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
})();
