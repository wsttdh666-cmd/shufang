package app.shufang.hub;

import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSArray;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

// 网页那边够不着的几件事：装新版本、把文件存到手机里、把文件发给别的 App、用浏览器打开链接
@CapacitorPlugin(name = "AppTools")
public class AppToolsPlugin extends Plugin {
    // 交给系统下载器：切到别的 App 也接着下，通知栏有进度；同一版本已在下或已下完就直接接上
    @PluginMethod
    public void install(PluginCall call) {
        DownloadManager dm = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        SharedPreferences prefs = getContext().getSharedPreferences("update", Context.MODE_PRIVATE);
        File apk = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "update.apk");
        String ver = call.getString("ver", "");
        long id = prefs.getLong("id", -1);
        long[] q = id >= 0 && ver.equals(prefs.getString("ver", "")) ? query(dm, id) : null;
        if (q == null || q[0] == DownloadManager.STATUS_FAILED || (q[0] == DownloadManager.STATUS_SUCCESSFUL && !apk.exists())) {
            if (id >= 0) dm.remove(id);
            apk.delete();
            id = dm.enqueue(new DownloadManager.Request(Uri.parse(call.getString("url")))
                .setTitle("书房 新版本")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, "update.apk"));
            prefs.edit().putLong("id", id).putString("ver", ver).apply();
        }
        final long task = id;
        Handler h = new Handler(Looper.getMainLooper());
        h.post(new Runnable() {
            @Override
            public void run() {
                long[] s = query(dm, task);
                if (s == null || s[0] == DownloadManager.STATUS_FAILED) {
                    call.reject("下载失败");
                    return;
                }
                notifyListeners("progress", new JSObject().put("done", s[1]).put("total", s[2]));
                // 下完了但人在别的 App 里，等回到我们这边再弹安装
                if (s[0] != DownloadManager.STATUS_SUCCESSFUL || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
                    h.postDelayed(this, 500);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                getContext().startActivity(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve();
            }
        });
    }

    private static long[] query(DownloadManager dm, long id) {
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return null;
            return new long[] {
                c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
                c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
                c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
            };
        }
    }

    // 文件内容：文字用 text，图片这类用 base64
    private static byte[] bytes(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 != null) return Base64.decode(b64, Base64.DEFAULT);
        return call.getString("text", "").getBytes(StandardCharsets.UTF_8);
    }

    // 存到手机的「下载/书房」文件夹；老系统存不进去，就存到 App 自己的文件夹
    @PluginMethod
    public void save(PluginCall call) {
        try {
            String where = saveToDownloads(getContext(), call.getString("name", "未命名"), call.getString("mime", "application/octet-stream"), new ByteArrayInputStream(bytes(call)));
            call.resolve(new JSObject().put("where", where));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // 返回存到了哪里（给人看的说法）
    static String saveToDownloads(Context ctx, String name, String mime, InputStream in) throws Exception {
        OutputStream out;
        String where;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/书房");
            Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("系统没让存");
            out = ctx.getContentResolver().openOutputStream(uri);
            where = "下载/书房/" + name;
        } else {
            File file = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
            out = new FileOutputStream(file);
            where = file.getAbsolutePath();
        }
        if (out == null) throw new Exception("系统没让存");
        try (OutputStream o = out) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
        return where;
    }

    // 打开登录用的浏览器
    @PluginMethod
    public void login(PluginCall call) {
        getActivity().startActivity(new Intent(getContext(), LoginActivity.class)
            .putExtra("url", call.getString("url", ""))
            .putExtra("ua", call.getString("ua", ""))
            .putExtra("hint", call.getString("hint", "")));
        call.resolve();
    }

    // 某个网站现在存着哪些 Cookie（只给名字，不给内容），页面靠它判断登没登录
    @PluginMethod
    public void cookieNames(PluginCall call) {
        String all = CookieManager.getInstance().getCookie(call.getString("url", ""));
        JSArray names = new JSArray();
        if (all != null) {
            for (String part : all.split(";")) {
                int eq = part.indexOf('=');
                String name = (eq > 0 ? part.substring(0, eq) : part).trim();
                if (!name.isEmpty()) names.put(name);
            }
        }
        call.resolve(new JSObject().put("names", names));
    }

    // 退出登录：把这个网站存着的 Cookie 全部作废
    @PluginMethod
    public void logout(PluginCall call) {
        String url = call.getString("url", "");
        String domain = call.getString("domain", "");
        CookieManager cm = CookieManager.getInstance();
        String all = cm.getCookie(url);
        if (all != null) {
            for (String part : all.split(";")) {
                int eq = part.indexOf('=');
                String name = (eq > 0 ? part.substring(0, eq) : part).trim();
                if (name.isEmpty()) continue;
                String dead = name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
                cm.setCookie(url, dead);
                if (!domain.isEmpty()) cm.setCookie(url, dead + "; Domain=" + domain);
            }
        }
        cm.flush();
        call.resolve();
    }

    // 取一个网页：带上你在登录浏览器里留下的登录状态，网站发回的新 Cookie 也存回去。
    // 跳转自己一步步跟（每一步都带上对应网站的 Cookie），最多跟 5 次。
    @PluginMethod
    public void get(PluginCall call) {
        final String start = call.getString("url", "");
        final boolean follow = call.getBoolean("redirect", true);
        String ua0 = call.getString("ua", "");
        if (ua0 == null || ua0.isEmpty()) {
            try { ua0 = android.webkit.WebSettings.getDefaultUserAgent(getContext()); } catch (Throwable ignore) {}
        }
        final String ua = ua0 == null ? "" : ua0;
        new Thread(() -> {
            CookieManager cm = CookieManager.getInstance();
            String url = start;
            try {
                for (int hop = 0; hop < 6; hop++) {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    try {
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(15000);
                        c.setReadTimeout(30000);
                        if (!ua.isEmpty()) c.setRequestProperty("User-Agent", ua);
                        c.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
                        c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
                        String cookie = cm.getCookie(url);
                        if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
                        int code = c.getResponseCode();
                        Map<String, List<String>> fields = c.getHeaderFields();
                        for (Map.Entry<String, List<String>> h : fields.entrySet()) {
                            if (h.getKey() != null && h.getKey().equalsIgnoreCase("Set-Cookie")) {
                                for (String v : h.getValue()) cm.setCookie(url, v);
                            }
                        }
                        String location = c.getHeaderField("Location");
                        if (code >= 300 && code < 400 && location != null) {
                            String next = new URL(new URL(url), location).toString();
                            if (follow) {
                                url = next;
                                continue;
                            }
                            call.resolve(new JSObject().put("status", code).put("url", url).put("location", next).put("data", ""));
                            return;
                        }
                        byte[] body;
                        try (InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream()) {
                            body = in == null ? new byte[0] : readAll(in);
                        }
                        cm.flush();
                        call.resolve(new JSObject().put("status", code).put("url", url).put("location", "")
                            .put("data", Base64.encodeToString(body, Base64.NO_WRAP)));
                        return;
                    } finally {
                        c.disconnect();
                    }
                }
                call.reject("跳转太多次了");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    // 发给别的 App（网盘、文件管理、酒馆等）
    @PluginMethod
    public void share(PluginCall call) {
        try {
            File file = new File(getContext().getCacheDir(), call.getString("name", "未命名"));
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(bytes(call));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType(call.getString("mime", "application/octet-stream"))
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, "发送到"));
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url"))));
            call.resolve();
        } catch (Exception e) {
            call.reject("手机上没有能打开这个链接的 App");
        }
    }

    // VIP 章节：用全屏 WebView 打开页面，等 JS 渲染完正文后自动提取并关闭。
    // 隐藏 WebView 拿不到正文（晋江 JS 检查可见性），所以用可见的，用户会短暂看到页面。
    @PluginMethod
    public void getRendered(PluginCall call) {
        final String url = call.getString("url", "");
        final String ua = call.getString("ua", "");
        final int timeout = call.getInt("timeout", 30000);
        new Handler(Looper.getMainLooper()).post(() -> {
            android.view.ViewGroup root = (android.view.ViewGroup) getActivity().getWindow().getDecorView();

            // 半透明遮罩 + 提示文字
            android.widget.FrameLayout wrap = new android.widget.FrameLayout(getContext());
            wrap.setBackgroundColor(0xE0FFFFFF);  // 白色半透明背景

            android.widget.TextView hint = new android.widget.TextView(getContext());
            hint.setText("正在加载 VIP 正文…");
            hint.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
            hint.setTextColor(0xFF5F6878);
            hint.setGravity(android.view.Gravity.CENTER);
            android.widget.FrameLayout.LayoutParams hintLp = new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
            hintLp.gravity = android.view.Gravity.CENTER;
            wrap.addView(hint, hintLp);

            // WebView 全屏但在提示文字后面（用户看到的是提示）
            final WebView wv = new WebView(getContext());
            wrap.addView(wv, 0, new android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));

            root.addView(wrap, new android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT));

            WebSettings s = wv.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            s.setDatabaseEnabled(true);
            if (ua != null && !ua.isEmpty()) s.setUserAgentString(ua);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);

            final boolean[] done = {false};
            final Handler h = new Handler(Looper.getMainLooper());

            Runnable cleanup = () -> {
                try { root.removeView(wrap); } catch (Exception ignore) {}
                try { wv.stopLoading(); wv.destroy(); } catch (Exception ignore) {}
            };

            // 超时：不再直接失败，而是把当前整页 HTML 带回去（base64），
            // 让上层能诊断为什么没抓到正文、并从页面里取到字体。标记 timedout。
            h.postDelayed(() -> {
                if (!done[0]) {
                    done[0] = true;
                    wv.evaluateJavascript(
                        "(function(){try{return btoa(unescape(encodeURIComponent(document.documentElement.outerHTML)))}catch(e){return ''}})()",
                        b64 -> {
                            cleanup.run();
                            String data = b64 == null ? "" : b64;
                            if (data.startsWith("\"") && data.endsWith("\"")) data = data.substring(1, data.length() - 1);
                            call.resolve(new JSObject().put("status", 200).put("timedout", true).put("data", data).put("url", ""));
                        });
                }
            }, timeout);

            wv.setWebChromeClient(new WebChromeClient());
            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String pageUrl) {
                    if (done[0]) return;
                    h.postDelayed(() -> pollVip(wv, call, done, h, 0, cleanup, hint), 2000);
                }
            });
            wv.loadUrl(url);
        });
    }

    private void pollVip(WebView wv, PluginCall call, boolean[] done, Handler h, int attempt, Runnable cleanup, android.widget.TextView hint) {
        if (done[0]) return;
        String js = "(function(){" +
            "var nt=document.querySelector('.noveltext');" +
            "if(!nt)return JSON.stringify({s:'no_el'});" +
            "var t=(nt.textContent||'').replace(/\\s/g,'');" +
            "if(t.length<30)return JSON.stringify({s:'short',l:t.length});" +
            "if(t.indexOf('\\u52a0\\u8f7d\\u4e2d')>=0||t.indexOf('\\u52a0\\u8f7d\\u5931\\u8d25')>=0)return JSON.stringify({s:'loading'});" +
            "if((t.indexOf('\\u8d2d\\u4e70')>=0||t.indexOf('\\u8ba2\\u9605')>=0)&&t.length<200)return JSON.stringify({s:'unbought'});" +
            "return JSON.stringify({s:'ok',html:document.documentElement.outerHTML});" +
            "})()";
        wv.evaluateJavascript(js, value -> {
            if (done[0]) return;
            try {
                if (value == null || value.equals("null")) throw new Exception("null");
                String json = value;
                if (json.startsWith("\"") && json.endsWith("\"")) {
                    json = json.substring(1, json.length() - 1)
                        .replace("\\\"", "\"")
                        .replace("\\n", "\n")
                        .replace("\\t", "\t")
                        .replace("\\u003c", "<")
                        .replace("\\u003e", ">")
                        .replace("\\u0026", "&")
                        .replace("\\\\", "\\");
                }
                org.json.JSONObject obj = new org.json.JSONObject(json);
                String status = obj.optString("s", "");
                if (status.equals("ok")) {
                    done[0] = true;
                    String html = obj.optString("html", "");
                    cleanup.run();
                    call.resolve(new JSObject()
                        .put("status", 200)
                        .put("data", Base64.encodeToString(html.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP))
                        .put("url", ""));
                } else if (status.equals("unbought")) {
                    done[0] = true;
                    cleanup.run();
                    call.resolve(new JSObject().put("status", 200).put("unbought", true).put("data", ""));
                } else if (attempt < 35) {
                    final int a = attempt;
                    new Handler(Looper.getMainLooper()).post(() -> {
                        try { hint.setText("正在加载 VIP 正文…（" + (a+1) + "）"); } catch(Exception ignore){}
                    });
                    h.postDelayed(() -> pollVip(wv, call, done, h, attempt + 1, cleanup, hint), 800);
                } else {
                    done[0] = true;
                    cleanup.run();
                    call.reject("等了很久，页面里没有出现正文");
                }
            } catch (Exception e) {
                if (attempt < 35) {
                    h.postDelayed(() -> pollVip(wv, call, done, h, attempt + 1, cleanup, hint), 800);
                } else {
                    done[0] = true;
                    cleanup.run();
                    call.reject("提取失败：" + e.getMessage());
                }
            }
        });
    }

}
