package app.shufang.hub;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * 导书时的前台服务：通知栏常驻「正在下载 第 x / y 章」。
 * 有它在，系统就知道书房在干正事，切到别的应用时不会把书房冻结或杀掉；
 * 另外拿一个 CPU 唤醒锁，息屏后下载也不停。下载结束时换成一条可划掉的「已完成」通知。
 *
 * 真正的下载逻辑还在网页层（link-import.js），这里只负责「保活 + 显示进度」。
 */
public class DownloadService extends Service {
    private static final String CHANNEL = "shufang_download";
    private static final String CHANNEL_DONE = "shufang_download_done";
    static final int NID = 4201;
    static final int NID_DONE = 4202;

    static volatile boolean running = false;
    private static volatile boolean starting = false;
    private static volatile String title = "书房";
    private static PowerManager.WakeLock wakeLock;

    // ---------- 给插件调用的静态入口 ----------

    static void start(Context c, String t) {
        title = (t == null || t.isEmpty()) ? "书房" : t;
        ensureChannels(c);
        try { nm(c).cancel(NID_DONE); } catch (Exception ignore) {}
        Intent i = new Intent(c, DownloadService.class);
        starting = true;
        try { ContextCompat.startForegroundService(c, i); }
        catch (Exception e) { starting = false; }   // 起不来就算了，前台照样能下
    }

    static void update(Context c, String text, int done, int total) {
        if (!running) return;
        try { nm(c).notify(NID, build(c, text, done, total)); } catch (Exception ignore) {}
    }

    static void stop(Context c, String doneText) {
        // 服务刚被要求启动、还没真正跑起来就要停：等它起来再停，
        // 否则部分系统会报「前台服务没及时 startForeground」
        if (starting && !running) {
            new android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed(() -> { starting = false; stop(c, doneText); }, 1500);
            return;
        }
        running = false;
        try { c.stopService(new Intent(c, DownloadService.class)); } catch (Exception ignore) {}
        if (doneText != null && !doneText.isEmpty()) {
            ensureChannels(c);
            Notification n = new NotificationCompat.Builder(c, CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText(doneText)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(doneText))
                .setContentIntent(openApp(c))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build();
            try { nm(c).notify(NID_DONE, n); } catch (Exception ignore) {}
        }
    }

    // ---------- Service 生命周期 ----------

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        starting = false;
        running = true;
        Notification n = build(this, "准备下载…", 0, 0);
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        try {
            ServiceCompat.startForeground(this, NID, n, type);
        } catch (Exception e) {
            // 极少数系统不让起前台服务：放弃保活，下载照样在前台能跑
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWake();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWake();
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE); } catch (Exception ignore) {}
        super.onDestroy();
    }

    // Android 15+ 给 dataSync 前台服务设了每天 6 小时上限，到点必须自己停，否则会崩
    @Override
    public void onTimeout(int startId, int fgsType) {
        running = false;
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务里划掉了书房：网页层已经没了，服务也没必要留着
        running = false;
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---------- 工具 ----------

    private static NotificationManager nm(Context c) {
        return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager m = nm(c);
        if (m.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "导书下载进度", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("下载章节时显示进度，让书房在后台也能接着下");
            ch.setShowBadge(false);
            m.createNotificationChannel(ch);
        }
        if (m.getNotificationChannel(CHANNEL_DONE) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_DONE, "导书下载完成", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("下载结束时提醒一下结果");
            m.createNotificationChannel(ch);
        }
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static Notification build(Context c, String text, int done, int total) {
        ensureChannels(c);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text == null ? "" : text)
            .setContentIntent(openApp(c))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (total > 0) b.setProgress(total, Math.min(done, total), false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    private void acquireWake() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shufang:download");
                wakeLock.setReferenceCounted(false);
            }
            // 兜底 3 小时自动放开，防止哪里漏了 stop 一直耗电
            wakeLock.acquire(3 * 60 * 60 * 1000L);
        } catch (Exception ignore) {}
    }

    private static void releaseWake() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignore) {}
    }
}
