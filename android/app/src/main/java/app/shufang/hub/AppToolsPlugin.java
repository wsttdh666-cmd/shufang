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
}
