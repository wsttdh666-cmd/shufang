package app.shufang.hub;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.view.WindowManager;
import android.webkit.JsResult;
import org.json.JSONArray;
import android.widget.Toast;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

// 站内浏览器：你在里面正常登录网站、打开书的页面，App 在页面里运行开源的「小说下载器」脚本，
// 脚本导出的 txt 直接收进书架，别的格式（epub 等）存到手机的「下载/书房」。
public class ScriptActivity extends Activity {
    private static final String TIP_READY = "登录后打开书的详情页（有目录的那一页），这里会出现“导出这本书”按钮。";
    private static final String TIP_BOOK = "这一页可以导出：点下面的“导出这本书”。导出的 txt 会自动进书架。";

    private static final Pattern SECURE = Pattern.compile("(^|\\.)(jjwxc\\.(net|com)|qidian\\.com|fanqienovel\\.com|ciweimao\\.com|yuewen\\.com)$");

    private WebView web;
    private TextView status;
    private Button uaButton, exportButton;
    private boolean exporting = false, polling = false;
    private LinearLayout panel;
    private TextView summary, chapters, errors;
    private ScrollView chapterScroll;
    private String lastItems = "";
    private final ScriptStore store = new ScriptStore();
    private volatile boolean ready = false;
    private boolean registered = false, legacy = false, desktop = true, preparing = false;
    private String shim = "", payload = "", mobileUa = "", desktopUa = "";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final Map<Integer, byte[]> bodies = new ConcurrentHashMap<>();
    private final Map<Integer, Incoming> incoming = new ConcurrentHashMap<>();
    private final AtomicInteger fileSeq = new AtomicInteger();

    private static class Incoming {
        String name, mime;
        File tmp;
        OutputStream out;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private Button button(String text, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(12), 0, dp(12), 0);
        b.setOnClickListener(onClick);
        return b;
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(2), dp(6), dp(2));
        bar.addView(button("后退", v -> { if (web.canGoBack()) web.goBack(); }));
        bar.addView(button("刷新", v -> web.reload()));
        uaButton = button("换成手机版", v -> switchUa());
        bar.addView(uaButton);
        View gap = new View(this);
        bar.addView(gap, new LinearLayout.LayoutParams(0, 1, 1f));
        bar.addView(button("完成", v -> finish()));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        status = new TextView(this);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setTextColor(Color.rgb(60, 66, 80));
        status.setBackgroundColor(Color.rgb(238, 240, 244));
        status.setPadding(dp(12), dp(8), dp(12), dp(8));
        status.setText("正在准备…");
        status.setOnClickListener(v -> { if (!ready && !preparing) prepare(); });
        root.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        exportButton = button("导出这本书", v -> startExport());
        exportButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        exportButton.setVisibility(View.GONE);
        LinearLayout.LayoutParams exportLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        exportLp.setMargins(dp(8), dp(4), dp(8), dp(4));
        root.addView(exportButton, exportLp);

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.rgb(246, 247, 250));
        panel.setPadding(dp(12), dp(6), dp(12), dp(6));
        panel.setVisibility(View.GONE);
        summary = new TextView(this);
        summary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        summary.setTextColor(Color.rgb(28, 34, 48));
        summary.setTypeface(null, android.graphics.Typeface.BOLD);
        panel.addView(summary);
        chapterScroll = new ScrollView(this);
        chapters = new TextView(this);
        chapters.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        chapters.setTextColor(Color.rgb(60, 66, 80));
        chapters.setLineSpacing(0, 1.15f);
        chapterScroll.addView(chapters);
        panel.addView(chapterScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(170)));
        errors = new TextView(this);
        errors.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        errors.setTextColor(Color.rgb(179, 38, 30));
        errors.setVisibility(View.GONE);
        errors.setTextIsSelectable(true);
        panel.addView(errors);
        root.addView(panel, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        // 新系统里内容会画到状态栏和导航条下面，这里把它们让出来；键盘弹出时也让出来
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        mobileUa = s.getUserAgentString();
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(mobileUa);
        desktopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + (m.find() ? m.group(1) : "130.0.0.0") + " Safari/537.36";
        // 脚本的规则大多是按电脑版网页写的，所以默认用电脑版；页面可以双指放大
        s.setUserAgentString(desktopUa);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "ShufangBridge");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                result.confirm();
                status.setText("网页提示：" + message);
                errors.setVisibility(View.VISIBLE);
                errors.setText("网页提示：" + message + "\n" + errors.getText());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                // 这些站都支持加密连接，碰到 http 链接就换成 https 再打开
                String host = uri.getHost() == null ? "" : uri.getHost();
                if (scheme.equals("http") && request.isForMainFrame() && SECURE.matcher(host).find()) {
                    view.loadUrl(uri.buildUpon().scheme("https").build().toString());
                    return true;
                }
                if (scheme.equals("http") || scheme.equals("https")) return false;
                // 微信、QQ 登录这类会跳到别的 App
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    // 手机上没有对应的 App，就留在原页面
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                bodies.clear();
                exporting = false;
                lastItems = "";
                panel.setVisibility(View.GONE);
                // 老版本的系统浏览器内核不支持"页面一开始就运行"，只能在这里尽早塞进去
                if (legacy && ready && store.matches(url)) view.evaluateJavascript(payload, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                tip(url);
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                tip(url);
            }
        });

        try (InputStream in = getResources().openRawResource(R.raw.shim)) {
            shim = new String(ScriptStore.readAll(in), StandardCharsets.UTF_8);
        } catch (Exception e) {
            shim = "";
        }
        String url = getIntent().getStringExtra("url");
        web.loadUrl(url == null || url.isEmpty() ? "https://www.qidian.com/" : url);
        prepare();
    }

    private void tip(String url) {
        if (!ready) return;
        boolean book = store.matches(url);
        exportButton.setVisibility(book ? View.VISIBLE : View.GONE);
        if (!exporting) status.setText(book ? TIP_BOOK : TIP_READY);
        if (book && !polling) {
            polling = true;
            main.postDelayed(this::pollProgress, 1500);
        }
    }

    // evaluateJavascript 返回的是带引号的 JSON 字符串，这里还原成普通文字
    private static String plain(String value) {
        try {
            Object v = new org.json.JSONTokener(value).nextValue();
            return v == null || v == JSONObject.NULL ? "" : String.valueOf(v);
        } catch (Exception e) {
            return "";
        }
    }

    // 替你点脚本自己的开始按钮；脚本没启动的话，把原因写在提示行里
    private void startExport() {
        web.evaluateJavascript("window.__sfStart ? window.__sfStart() : 'no|页面里的导出代码没有运行'", value -> {
            String r = plain(value);
            if (r.equals("ok")) {
                exporting = true;
                status.setText("已开始导出，先在读目录，稍等…");
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (!polling) {
                    polling = true;
                    main.postDelayed(this::pollProgress, 1500);
                }
            } else if (r.equals("jump")) {
                status.setText("这一页不是目录页，正在跳到目录页。到了以后再点一次“导出这本书”。");
            } else {
                status.setText("导出脚本没有在这一页启动。先点“刷新”再试；还不行就把这行字截图发出来：" + (r.startsWith("no|") ? r.substring(3) : r));
            }
        });
    }

    private void switchUa() {
        desktop = !desktop;
        web.getSettings().setUserAgentString(desktop ? desktopUa : mobileUa);
        uaButton.setText(desktop ? "换成手机版" : "换成电脑版");
        web.reload();
    }

    // 每 1.5 秒读一次脚本里的书和各章状态，显示到面板上
    private void pollProgress() {
        if (isDestroyed()) return;
        web.evaluateJavascript("window.__sfState ? window.__sfState() : ''", value -> {
            try {
                String raw = plain(value);
                if (!raw.isEmpty()) showState(new JSONObject(raw));
            } catch (Exception e) {
                // 这一次没读到，下次再读
            }
            if (polling && !isDestroyed()) main.postDelayed(this::pollProgress, 1500);
        });
    }

    private void showState(JSONObject st) throws Exception {
        int total = st.optInt("total");
        boolean running = st.optBoolean("downloading");
        JSONObject c = st.optJSONObject("count");
        int done = c == null ? 0 : c.optInt("完成"), fail = c == null ? 0 : c.optInt("失败"),
            busy = c == null ? 0 : c.optInt("下载中"), wait = c == null ? 0 : c.optInt("等待");
        JSONArray logs = st.optJSONArray("logs");
        if (total == 0 && !running && (logs == null || logs.length() == 0)) return;
        panel.setVisibility(View.VISIBLE);
        if (running) exporting = true;

        String title = st.optString("title");
        if (total == 0) {
            summary.setText(running ? "正在读取目录…" : "还没有读到目录");
        } else {
            summary.setText((title.isEmpty() ? "" : "《" + title + "》 ") + "目录共 " + total + " 章\n已下载 " + done
                + " 章 · 下载中 " + busy + " · 失败 " + fail + " · 等待 " + wait);
        }
        if (exporting) {
            String phase = st.optString("phase");
            status.setText(running ? "导出中，别离开这一页" + (phase.isEmpty() ? "" : "　" + phase)
                : total > 0 && done + fail >= total ? "下载结束，正在打包成 txt…" : "导出停下了，看下面的报错");
        }

        // 逐章列表：只在有变化时重画，避免滚动位置乱跳
        JSONArray items = st.optJSONArray("items");
        String key = items == null ? "" : items.toString();
        if (!key.equals(lastItems)) {
            lastItems = key;
            StringBuilder sb = new StringBuilder();
            int firstBusy = -1;
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONArray it = items.getJSONArray(i);
                String s = it.optString(2);
                String mark = s.equals("完成") ? "✓" : s.equals("失败") ? "✗" : s.equals("下载中") ? "…" : s.equals("中止") ? "■" : "·";
                if (firstBusy < 0 && (s.equals("下载中") || s.equals("等待"))) firstBusy = i;
                sb.append(mark).append(' ').append(it.optInt(0)).append("  ").append(it.optString(1));
                if (it.optInt(3) == 1) sb.append("  [VIP]");
                if (!s.equals("完成")) sb.append("  ").append(s);
                sb.append('\n');
            }
            chapters.setText(sb.toString());
            // 自动滚到正在下载的那一章附近
            if (firstBusy >= 0) {
                final int line = Math.max(0, firstBusy - 2);
                chapters.post(() -> {
                    if (chapters.getLayout() != null) chapterScroll.scrollTo(0, chapters.getLayout().getLineTop(Math.min(line, chapters.getLineCount() - 1)));
                });
            }
        }

        if (logs != null && logs.length() > 0) {
            StringBuilder e = new StringBuilder("最近的报错（可长按复制发给我）：");
            for (int i = logs.length() - 1; i >= 0 && i >= logs.length() - 4; i--) e.append('\n').append(logs.getString(i));
            errors.setText(e.toString());
            errors.setVisibility(View.VISIBLE);
        }
    }

    // 下载脚本和它的组件（第一次要下十几兆），好了以后挂到浏览器上并刷新当前页
    private void prepare() {
        preparing = true;
        status.setText("正在准备导出工具…");
        new Thread(() -> {
            try {
                store.prepare(this, text -> main.post(() -> status.setText(text)));
                // 规则、垫片、各个组件、脚本本身，按这个顺序拼成一整段。
                // 分开交给浏览器的话它不保证先后，脚本会抢在组件前面跑，一启动就找不到组件。
                String appVer;
                try {
                    appVer = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                } catch (Exception e) {
                    appVer = "?";
                }
                String mode = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ? "开头注入" : "旧方式";
                StringBuilder sb = new StringBuilder("window.__sfApp='第" + appVer + "版/" + mode + "';\n").append(store.rulesJs()).append('\n').append(shim);
                for (String part : store.parts) sb.append('\n').append(part);
                final String built = sb.toString();
                store.parts.clear();
                main.post(() -> {
                    payload = built;
                    preparing = false;
                    if (isFinishing() || isDestroyed()) return;
                    if (!registered) {
                        registered = true;
                        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                            WebViewCompat.addDocumentStartJavaScript(web, payload, Collections.singleton("*"));
                        } else {
                            legacy = true;
                        }
                    }
                    ready = true;
                    status.setText(TIP_READY);
                    web.reload();
                });
            } catch (Exception e) {
                String why = String.valueOf(e.getMessage());
                main.post(() -> {
                    preparing = false;
                    status.setText(why + "。点这一行重试。没准备好之前只能浏览，不能导出。");
                });
            }
        }).start();
    }

    private void toast(String text) {
        main.post(() -> Toast.makeText(this, text, Toast.LENGTH_LONG).show());
    }

    // 页面里的脚本通过这些方法找 App 办事。它们不在主线程上运行。
    private class Bridge {
        @JavascriptInterface
        public boolean matches(String url) {
            return ready && store.matches(url);
        }

        @JavascriptInterface
        public String scriptVersion() {
            return store.version;
        }

        @JavascriptInterface
        public String values() {
            return getSharedPreferences("gm", MODE_PRIVATE).getString("values", "{}");
        }

        @JavascriptInterface
        public void setValues(String json) {
            getSharedPreferences("gm", MODE_PRIVATE).edit().putString("values", json).apply();
        }

        @JavascriptInterface
        public void note(String text) {
            toast(text);
        }

        // 替脚本发一个跨站请求，带上你在这个浏览器里的登录状态
        @JavascriptInterface
        public void xhr(int id, String json) {
            pool.execute(() -> {
                JSONObject meta = new JSONObject();
                HttpURLConnection c = null;
                try {
                    JSONObject req = new JSONObject(json);
                    String url = req.getString("url");
                    String method = req.optString("method", "GET");
                    int timeout = req.optInt("timeout", 0);
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method);
                    c.setConnectTimeout(timeout > 0 ? timeout : 30000);
                    c.setReadTimeout(timeout > 0 ? timeout : 90000);
                    c.setInstanceFollowRedirects(true);
                    boolean hasUa = false;
                    String cookie = req.optString("cookie", "");
                    JSONObject headers = req.optJSONObject("headers");
                    if (headers != null) {
                        for (Iterator<String> it = headers.keys(); it.hasNext();) {
                            String k = it.next(), lower = k.toLowerCase();
                            if (lower.equals("host") || lower.equals("content-length") || lower.equals("accept-encoding")) continue;
                            if (lower.equals("cookie")) {
                                cookie = cookie.isEmpty() ? headers.optString(k) : cookie + "; " + headers.optString(k);
                                continue;
                            }
                            if (lower.equals("user-agent")) hasUa = true;
                            c.setRequestProperty(k, headers.optString(k));
                        }
                    }
                    if (!hasUa) c.setRequestProperty("User-Agent", desktop ? desktopUa : mobileUa);
                    if (!req.optBoolean("anonymous", false)) {
                        String own = CookieManager.getInstance().getCookie(url);
                        if (own != null && !own.isEmpty()) cookie = cookie.isEmpty() ? own : own + "; " + cookie;
                    }
                    if (!cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                    if (!req.isNull("data") && !method.equals("GET") && !method.equals("HEAD")) {
                        c.setDoOutput(true);
                        try (OutputStream out = c.getOutputStream()) {
                            out.write(req.getString("data").getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    int code = c.getResponseCode();
                    byte[] body = new byte[0];
                    try (InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream()) {
                        if (in != null) body = ScriptStore.readAll(in);
                    }
                    String finalUrl = c.getURL().toString();
                    StringBuilder raw = new StringBuilder();
                    for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                        if (h.getKey() == null) continue;
                        for (String v : h.getValue()) {
                            raw.append(h.getKey().toLowerCase()).append(": ").append(v).append("\r\n");
                            if (h.getKey().equalsIgnoreCase("Set-Cookie")) CookieManager.getInstance().setCookie(finalUrl, v);
                        }
                    }
                    bodies.put(id, body);
                    meta.put("status", code);
                    meta.put("statusText", c.getResponseMessage() == null ? "" : c.getResponseMessage());
                    meta.put("headers", raw.toString());
                    meta.put("contentType", c.getContentType() == null ? "" : c.getContentType());
                    meta.put("finalUrl", finalUrl);
                } catch (Exception e) {
                    try {
                        meta = new JSONObject();
                        meta.put("error", String.valueOf(e));
                        meta.put("timeout", e instanceof SocketTimeoutException);
                    } catch (Exception ignored) {
                        // 写不进去就让页面那边当成普通失败
                    }
                } finally {
                    if (c != null) c.disconnect();
                }
                final String js = "window.__sfXhrDone&&__sfXhrDone(" + id + "," + meta + ")";
                main.post(() -> {
                    if (!isDestroyed()) web.evaluateJavascript(js, null);
                });
            });
        }

        @JavascriptInterface
        public String xhrBody(int id) {
            byte[] body = bodies.remove(id);
            return body == null ? "" : Base64.encodeToString(body, Base64.NO_WRAP);
        }

        // 接收脚本导出的文件：先开头，再一段一段送，最后收尾
        @JavascriptInterface
        public int fileBegin(String name, String mime) {
            int id = fileSeq.incrementAndGet();
            try {
                File dir = new File(getCacheDir(), "incoming");
                dir.mkdirs();
                Incoming f = new Incoming();
                f.name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_");
                if (f.name.isEmpty()) f.name = "未命名";
                f.mime = mime;
                f.tmp = new File(dir, "f" + id);
                f.out = new FileOutputStream(f.tmp);
                incoming.put(id, f);
            } catch (Exception e) {
                toast("文件没接住：" + e.getMessage());
            }
            return id;
        }

        @JavascriptInterface
        public void fileChunk(int id, String b64) {
            Incoming f = incoming.get(id);
            if (f == null) return;
            try {
                f.out.write(Base64.decode(b64, Base64.DEFAULT));
            } catch (Exception e) {
                incoming.remove(id);
                toast("文件没接住：" + e.getMessage());
            }
        }

        @JavascriptInterface
        public void fileEnd(int id) {
            Incoming f = incoming.remove(id);
            if (f == null) return;
            try {
                f.out.close();
                if (f.name.toLowerCase().endsWith(".txt")) {
                    // txt 放进"收件箱"，回到主页面时会被收进书架
                    File inbox = new File(getFilesDir(), "inbox");
                    inbox.mkdirs();
                    File dst = new File(inbox, f.name);
                    for (int n = 2; dst.exists(); n++) dst = new File(inbox, f.name.substring(0, f.name.length() - 4) + "_" + n + ".txt");
                    try (InputStream in = new FileInputStream(f.tmp); OutputStream out = new FileOutputStream(dst)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                    toast("已收进书架：" + f.name);
                    main.post(() -> {
                        exporting = false;
                        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        status.setText("导出完成，《" + f.name.substring(0, f.name.length() - 4) + "》已收进书架。点“完成”回去看。");
                    });
                } else {
                    String lower = f.name.toLowerCase();
                    String mime = lower.endsWith(".epub") ? "application/epub+zip" : lower.endsWith(".zip") ? "application/zip" : "application/octet-stream";
                    String where;
                    try (InputStream in = new FileInputStream(f.tmp)) {
                        where = AppToolsPlugin.saveToDownloads(ScriptActivity.this, f.name, mime, in);
                    }
                    toast("已存到 " + where);
                }
            } catch (Exception e) {
                toast("文件没存成：" + e.getMessage());
            } finally {
                f.tmp.delete();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // 离开这个页面时马上把登录状态写到手机里；不然系统是隔一阵才写，App 被划掉就可能丢
    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        polling = false;
        CookieManager.getInstance().flush();
        pool.shutdownNow();
        web.destroy();
        super.onDestroy();
    }
}
