package app.shufang.hub;

import android.content.Context;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// 负责把开源的「小说下载器」脚本和它依赖的库下载到手机上存好，并判断某个网址是不是脚本支持的页面。
// 脚本不打进安装包：每次从它的官方地址取，它更新了规则我们也跟着用上新的。
public class ScriptStore {
    public interface Progress { void step(String text); }

    private static final String[] SCRIPT_URLS = {
        "https://github.com/404-novel-project/novel-downloader/raw/gh-pages/bundle.user.js",
        "https://raw.githubusercontent.com/404-novel-project/novel-downloader/gh-pages/bundle.user.js",
    };
    // 脚本当作全局变量来用的库名；库加载完后明确挂到 window 上，不依赖它们自己怎么声明
    private static final String[] GLOBALS = {"CryptoJS", "fflate", "nunjucks", "Vue", "eSearchOCR", "ort", "csstree", "cv", "mdui"};
    private static final long FRESH_MS = 12L * 60 * 60 * 1000;

    public String version = "";
    public final List<String> parts = new ArrayList<>();   // 依次注入页面的代码段：依赖库……最后是脚本本身
    private final List<Pattern> match = new ArrayList<>();
    private final List<Pattern> exclude = new ArrayList<>();
    private final List<String> matchSrc = new ArrayList<>();
    private final List<String> excludeSrc = new ArrayList<>();

    // 写进页面的一小段：告诉页面里的代码哪些网址算书页、脚本是哪一版
    public String rulesJs() {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("m", new org.json.JSONArray(matchSrc));
            o.put("x", new org.json.JSONArray(excludeSrc));
            o.put("v", version);
            return "window.__sfRules=" + o + ";";
        } catch (Exception e) {
            return "window.__sfRules={m:[],x:[],v:''};";
        }
    }

    public boolean matches(String url) {
        if (url == null) return false;
        int hash = url.indexOf('#');
        if (hash >= 0) url = url.substring(0, hash);
        for (Pattern p : exclude) if (p.matcher(url).matches()) return false;
        for (Pattern p : match) if (p.matcher(url).matches()) return true;
        return false;
    }

    // 联网准备；网络不通时用上次存下的。全都没有就抛错。
    public void prepare(Context ctx, Progress progress) throws Exception {
        File dir = new File(ctx.getFilesDir(), "userscript");
        dir.mkdirs();
        File scriptFile = new File(dir, "bundle.user.js");
        if (!scriptFile.exists() || System.currentTimeMillis() - scriptFile.lastModified() > FRESH_MS) {
            progress.step("正在获取导出脚本…");
            Exception last = null;
            for (String u : SCRIPT_URLS) {
                try {
                    byte[] data = download(u);
                    if (!new String(data, 0, Math.min(data.length, 400), StandardCharsets.UTF_8).contains("==UserScript==")) throw new Exception("内容不对");
                    write(scriptFile, data);
                    last = null;
                    break;
                } catch (Exception e) {
                    last = e;
                }
            }
            if (last != null && !scriptFile.exists()) throw new Exception("导出脚本没下载下来（连不上 GitHub）：" + last.getMessage());
        }
        String script = new String(read(scriptFile), StandardCharsets.UTF_8);
        int end = script.indexOf("==/UserScript==");
        if (end < 0) throw new Exception("导出脚本的格式不对");
        String head = script.substring(0, end);

        List<String> requires = new ArrayList<>();
        match.clear();
        exclude.clear();
        matchSrc.clear();
        excludeSrc.clear();
        Matcher m = Pattern.compile("(?m)^//\\s*@(\\S+)\\s+(.+?)\\s*$").matcher(head);
        while (m.find()) {
            String key = m.group(1), value = m.group(2);
            if ("require".equals(key)) requires.add(value);
            else if ("version".equals(key)) version = value;
            else if ("match".equals(key) || "include".equals(key)) add(match, matchSrc, value);
            else if ("exclude".equals(key) || "exclude-match".equals(key)) add(exclude, excludeSrc, value);
        }

        StringBuilder tail = new StringBuilder();
        for (String g : GLOBALS) tail.append(";try{if(typeof ").append(g).append("!=='undefined'&&!window.").append(g).append(")window.").append(g).append("=").append(g).append("}catch(e){}");

        parts.clear();
        for (int i = 0; i < requires.size(); i++) {
            String spec = requires.get(i);
            int hash = spec.indexOf('#');
            String url = hash >= 0 ? spec.substring(0, hash) : spec;
            String sri = hash >= 0 ? spec.substring(hash + 1) : "";
            File f = new File(dir, "lib-" + hex(MessageDigest.getInstance("SHA-1").digest(spec.getBytes(StandardCharsets.UTF_8))) + ".js");
            if (!f.exists()) {
                progress.step("正在下载导出要用的组件 " + (i + 1) + " / " + requires.size() + "（只有第一次要下，其中一个比较大）");
                byte[] data;
                try {
                    data = download(url);
                } catch (Exception e) {
                    throw new Exception("组件没下载下来（连不上 unpkg.com）：" + e.getMessage());
                }
                // 脚本作者给每个库都写了校验码，对不上就不用
                if (sri.startsWith("sha512-")) {
                    String got = Base64.encodeToString(MessageDigest.getInstance("SHA-512").digest(data), Base64.NO_WRAP);
                    if (!got.equals(sri.substring(7))) throw new Exception("组件校验没通过，为了安全没有使用：" + url);
                }
                write(f, data);
            }
            parts.add("if(window.__sfRun){try{\n" + new String(read(f), StandardCharsets.UTF_8) + "\n" + tail
                + "\n}catch(e){if(!window.__sfErr)window.__sfErr='组件出错 " + (i + 1) + "：'+e}}");
        }
        parts.add("if(window.__sfRun){(function(GM_info,GM_xmlhttpRequest,GM_setValue,GM_getValue,GM_deleteValue,GM,unsafeWindow){\n"
            + script
            + "\n}).call(window,__sfGM.info,__sfGM.xhr,__sfGM.setValue,__sfGM.getValue,__sfGM.deleteValue,__sfGM.GM,window);}");
    }

    private static void add(List<Pattern> list, List<String> sources, String rule) {
        try {
            if (rule.length() > 2 && rule.startsWith("/") && rule.endsWith("/")) {
                String src = "^.*(?:" + rule.substring(1, rule.length() - 1) + ").*$";
                list.add(Pattern.compile(src));
                sources.add(src);
                return;
            }
            // *://www.example.com/book/* 这种写法转成正则
            StringBuilder re = new StringBuilder("^");
            int sep = rule.indexOf("://");
            String rest = rule;
            if (sep >= 0) {
                String scheme = rule.substring(0, sep);
                re.append("*".equals(scheme) ? "https?" : glob(scheme)).append("://");
                rest = rule.substring(sep + 3);
                int slash = rest.indexOf('/');
                String host = slash >= 0 ? rest.substring(0, slash) : rest;
                rest = slash >= 0 ? rest.substring(slash) : "/";
                if ("*".equals(host)) re.append("[^/]+");
                else if (host.startsWith("*.")) re.append("(?:[^/]+\\.)?").append(glob(host.substring(2)));
                else re.append(glob(host));
            }
            re.append(glob(rest)).append("$");
            list.add(Pattern.compile(re.toString()));
            sources.add(re.toString());
        } catch (Exception e) {
            // 个别写法认不出来就跳过
        }
    }

    // 把 * 当成"任意内容"，其余字符照原样匹配
    private static String glob(String s) {
        StringBuilder out = new StringBuilder();
        String[] pieces = s.split("\\*", -1);
        for (int i = 0; i < pieces.length; i++) {
            if (i > 0) out.append(".*");
            // 逐个字符转义，这样 Java 和页面里的 JavaScript 都能用同一条规则
            for (char ch : pieces[i].toCharArray()) {
                if ("\\^$.|?*+()[]{}/".indexOf(ch) >= 0) out.append('\\');
                out.append(ch);
            }
        }
        return out.toString();
    }

    static byte[] download(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(120000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 shufang");
        try {
            int code = c.getResponseCode();
            // 网址换了协议时系统不会自己跟过去，这里手动跟一次
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                String next = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                return download(next);
            }
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = c.getInputStream()) {
                return readAll(in);
            }
        } finally {
            c.disconnect();
        }
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static byte[] read(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            return readAll(in);
        }
    }

    // 先写到临时文件再改名：下载到一半断了，不会留下半个坏文件
    private static void write(File f, byte[] data) throws Exception {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        }
        if (!tmp.renameTo(f)) throw new Exception("文件存不进去");
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
