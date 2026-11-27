/* 晋江字体还原：VIP 正文把常用字换成私用区(U+E000–F8FF)码位，再用每次都换的字体
   把这些码位画成真字。这里下载那个字体，把每个码位的字形和一批常用字的字形做位图比对，
   还原成真字。只用于你登录后、买过、能打开的章节。按字体 URL 缓存，整本书复用。 */
window.JJFont = (() => {
  "use strict";
  const N = (window.JJ_N|0) || 40;    // 归一化方形位图边长
  const WORDS = (N*N + 31) >> 5;
  const SYS_FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
  const isPUA = c => (c >= 0xE000 && c <= 0xF8FF);

  let candSig = null, candChars = null;
  const fontCache = new Map();

  const cv = document.createElement("canvas"); cv.width = cv.height = 64;
  const cx = cv.getContext("2d", {willReadFrequently: true});
  const out = document.createElement("canvas"); out.width = out.height = N;
  const ox = out.getContext("2d", {willReadFrequently: true});
  // 画字 → 墨迹外框裁剪 → 方形拉伸到 N×N → 二值位签名。空字形返回 null。
  function signature(ch, family){
    cx.clearRect(0,0,64,64);
    cx.fillStyle="#000"; cx.textBaseline="alphabetic"; cx.textAlign="left";
    cx.font = "52px " + family;
    cx.fillText(ch, 6, 54);
    const d = cx.getImageData(0,0,64,64).data;
    let x0=64,y0=64,x1=-1,y1=-1;
    for (let y=0;y<64;y++) for (let x=0;x<64;x++){
      if (d[(y*64+x)*4+3] > 64){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
    }
    if (x1<x0 || y1<y0) return null;
    ox.clearRect(0,0,N,N);
    ox.drawImage(cv, x0, y0, x1-x0+1, y1-y0+1, 0, 0, N, N);
    const p = ox.getImageData(0,0,N,N).data;
    const sig = new Uint32Array(WORDS);
    for (let i=0;i<N*N;i++){ if (p[i*4+3] > 80) sig[i>>5] |= (1 << (i & 31)); }
    return sig;
  }
  function popcount(v){ v=v-((v>>>1)&0x55555555); v=(v&0x33333333)+((v>>>2)&0x33333333); return (((v+(v>>>4))&0x0f0f0f0f)*0x01010101)>>>24; }
  function hamming(a,b){ let s=0; for(let i=0;i<WORDS;i++) s+=popcount(a[i]^b[i]); return s; }
  function ensureCandidates(){
    if (candSig) return;
    const chars = window.JJ_CANDIDATES || "";
    candChars=[]; candSig=[];
    for (const ch of chars){ const sg=signature(ch,SYS_FONT); if(sg){ candChars.push(ch); candSig.push(sg); } }
  }
  function matchAll(puaChars, family){
    ensureCandidates();
    const map = {};
    const THRESH = N*N*0.33;
    for (const ch of puaChars){
      const sg = signature(ch, family);
      if (!sg) continue;
      let best=1e9, bi=-1;
      for (let i=0;i<candSig.length;i++){ const dd=hamming(sg,candSig[i]); if(dd<best){best=dd;bi=i;} }
      if (bi>=0 && best<=THRESH) map[ch]=candChars[bi];
    }
    return map;
  }

  // 从渲染后的 HTML 里找晋江字体的 URL
  function fontUrlFromHtml(html){
    const m = String(html).match(/url\(\s*['"]?([^'")]*jjwxcfont[^'")]*\.(?:woff2|woff|ttf|otf))/i)
           || String(html).match(/url\(\s*['"]?([^'")]+\.(?:woff2|woff|ttf|otf))[^)]*\)\s*;?[^}]*jjwxc/i);
    if (!m) return null;
    let u = m[1];
    if (u.startsWith("//")) u = "https:" + u;
    else if (u.startsWith("/")) u = "https://www.jjwxc.net" + u;
    return u;
  }

  // 下载字体字节：复用导入页的 get()（AppTools 原生 HTTP）
  async function fetchFont(url){
    if (typeof get === "function"){
      const r = await get(url);
      if (r.status !== 200) throw new Error("字体下载失败 HTTP " + r.status);
      return r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("字体下载失败 HTTP " + res.status);
    return await res.arrayBuffer();
  }

  // 对外：根据渲染后的 HTML 拿一个解码器（整本书会命中缓存）
  async function forHtml(html){
    const url = fontUrlFromHtml(html);
    if (!url) return null;                    // 这章没用加密字体
    if (fontCache.has(url)) return fontCache.get(url);
    const buf = await fetchFont(url);
    const family = "jjdec_" + Math.random().toString(36).slice(2, 8);
    const face = new FontFace(family, buf);
    await face.load();
    document.fonts.add(face);
    const known = {};                         // 已解出的 码位->真字，整本累积
    const decoder = {
      url, family,
      decode(text){
        if (!text) return text;
        // 收集这段里还没解过的私用区码位
        const todo = [];
        for (const ch of text){
          const c = ch.codePointAt(0);
          if (isPUA(c) && !(ch in known)) todo.push(ch);
        }
        if (todo.length){
          const got = matchAll([...new Set(todo)], family);
          Object.assign(known, got);
          for (const ch of todo) if (!(ch in known)) known[ch] = ch;   // 没匹配上的记下来别反复试
        }
        let outstr = "";
        for (const ch of text){
          const c = ch.codePointAt(0);
          outstr += (isPUA(c) && known[ch] && known[ch] !== ch) ? known[ch] : ch;
        }
        return outstr;
      },
      // 这段文字里私用区字符解出了多少，用于提示
      stats(text){
        let pua = 0, ok = 0;
        for (const ch of text){ if (isPUA(ch.codePointAt(0))){ pua++; if (known[ch] && known[ch] !== ch) ok++; } }
        return {pua, ok};
      }
    };
    fontCache.set(url, decoder);
    return decoder;
  }

  return {forHtml, isPUA};
})();
