package app.shufang.hub;

import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

// 番茄下载引擎：把官方 Android 二进制（随 APK 以 libtomato.so 分发）当本地服务跑起来。
// 它在 127.0.0.1:18423 提供 /api/... 接口，导书那边的番茄线全程走这个本地服务。
// 难的部分（请求签名、正文接口、解密）都在这个二进制里，这里只负责起停和看它活没活。
@CapacitorPlugin(name = "TomatoEngine")
public class TomatoEnginePlugin extends Plugin {
    private static final String TAG = "TomatoEngine";
    // 和二进制内置默认一致；JS 那边也用这个地址
    private static final String ADDR = "127.0.0.1:18423";
    // 二进制以 jniLibs/<abi>/libtomato.so 随包，安装后会被解压到 nativeLibraryDir
    private static final String LIB_NAME = "libtomato.so";

    private static Process proc;          // 全局单例，避免重复起
    private static Thread logPump;

    // 二进制在手机上的真实路径（已解压、可执行）
    private String binaryPath() {
        return getContext().getApplicationInfo().nativeLibraryDir + File.separator + LIB_NAME;
    }

    // 引擎的工作目录：下载的书、封面、配置都落在这里，App 自己的私有目录
    private File dataDir() {
        File d = new File(getContext().getFilesDir(), "tomato");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private boolean alive() {
        return proc != null && proc.isAlive();
    }

    // 起引擎。已经在跑就直接返回；二进制不存在（比如 CPU 架构不匹配，没打进对应 abi）就明确报错。
    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (alive()) {
                call.resolve(info(true, "already"));
                return;
            }
            File bin = new File(binaryPath());
            if (!bin.exists()) {
                call.reject("引擎二进制没找到（这台手机的 CPU 架构可能没打进安装包）：" + bin.getAbsolutePath());
                return;
            }
            // nativeLibraryDir 里的文件安装时就带可执行位；保险起见再设一次
            try { bin.setExecutable(true, false); } catch (Throwable ignore) {}

            File dir = dataDir();
            File log = new File(dir, "engine.log");

            ProcessBuilder pb = new ProcessBuilder(
                bin.getAbsolutePath(), "--server", "--data-dir", dir.getAbsolutePath());
            pb.directory(dir);
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
            // 绑定地址 + 给 Rust 程序一个可写的 HOME / 临时目录
            pb.environment().put("TOMATO_WEB_ADDR", ADDR);
            pb.environment().put("HOME", dir.getAbsolutePath());
            pb.environment().put("TMPDIR", getContext().getCacheDir().getAbsolutePath());

            proc = pb.start();
            Log.i(TAG, "engine started, pid-ish=" + proc + " addr=" + ADDR);

            // 引擎退出时记一笔（日志已重定向到文件，这里只是看护进程对象）
            final Process p = proc;
            logPump = new Thread(() -> {
                try { int code = p.waitFor(); Log.i(TAG, "engine exited code=" + code); }
                catch (InterruptedException ignore) {}
            });
            logPump.setDaemon(true);
            logPump.start();

            // 这里只负责把进程拉起来；是否就绪由 JS 轮询 http://127.0.0.1:18423/api/status 判断
            call.resolve(info(true, "started"));
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            call.reject("引擎启动失败：" + String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(info(alive(), alive() ? "running" : "stopped"));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        killEngine();
        call.resolve(info(false, "stopped"));
    }

    private JSObject info(boolean running, String state) {
        return new JSObject()
            .put("running", running)
            .put("addr", ADDR)
            .put("base", "http://" + ADDR)
            .put("state", state)
            .put("dataDir", dataDir().getAbsolutePath());
    }

    private static void killEngine() {
        try { if (proc != null) proc.destroy(); } catch (Throwable ignore) {}
        proc = null;
    }

    // App 退出时别把引擎留成孤儿进程
    @Override
    protected void handleOnDestroy() {
        killEngine();
        super.handleOnDestroy();
    }
}
