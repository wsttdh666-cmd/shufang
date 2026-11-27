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
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

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
            String name = call.getString("name", "未命名");
            byte[] data = bytes(call);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, call.getString("mime", "application/octet-stream"));
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/书房");
                Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("系统没让存");
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                    out.write(data);
                }
                call.resolve(new JSObject().put("where", "下载/书房/" + name));
                return;
            }
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File file = new File(dir, name);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(data);
            }
            call.resolve(new JSObject().put("where", file.getAbsolutePath()));
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
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
