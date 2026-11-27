# jniLibs/*/libtomato.so —— 番茄下载引擎

`libtomato.so` **不是普通的动态库**，而是一个完整的命令行可执行程序，被重命名成 `lib*.so`
塞进 `jniLibs`，好让安装时被解压到 App 的 `nativeLibraryDir` 并可执行。导书的番茄下载走它。

## 它是什么

- 上游项目：<https://github.com/zhongbai2333/Tomato-Novel-Downloader>（MIT，纯 Rust）
- 用的产物：Release 里的 `TomatoNovelDownloader-Android_arm64-<版本>`
- 当前内置版本：**v2.5.0**，arm64
  - sha256: `3175c0b6b0d0784a146518c19ce3aa9709a1e04efb7245b7d0d3ca29de0743c9`
- 番茄正文的请求签名（X-Argus/X-Ladon 等）和解密都在这个二进制里，App 这边只当本地服务调它。

## App 怎么用它

- `TomatoEnginePlugin.java` 用 `ProcessBuilder` 启动：
  `libtomato.so --server --data-dir <app files>/tomato`，环境变量 `TOMATO_WEB_ADDR=127.0.0.1:18423`。
- 引擎在 `127.0.0.1:18423` 提供 `/api/...`；`www/link-import.js` 的番茄平台通过 CapacitorHttp 调它
  （`/api/preview/<book_id>`、`POST /api/jobs`、轮询 `/api/jobs`、`/api/library`、`/download/<rel>`）。
- 能跑起来的前提：`AndroidManifest.xml` 里 `android:extractNativeLibs="true"`，
  且 `app/build.gradle` 里 `packagingOptions { jniLibs { useLegacyPackaging = true } }`——
  否则 .so 只在 APK 里内存映射、不会落成可执行文件。

## 怎么更新引擎（番茄改了接口 / 要升级时）

```sh
VER=2.5.1   # 换成最新 tag
curl -L -o android/app/src/main/jniLibs/arm64-v8a/libtomato.so \
  "https://github.com/zhongbai2333/Tomato-Novel-Downloader/releases/download/v$VER/TomatoNovelDownloader-Android_arm64-v$VER"
```

确认一下还是 aarch64 ELF：`file .../libtomato.so` 应显示 `ELF 64-bit ... ARM aarch64`。
然后照常推 main，CI 会重新打包发版。

## 32 位手机

当前只打了 arm64。要支持老的 32 位机，把 `armeabi-v7a/libtomato.so` 放上 `Android_arm32` 产物即可；
没放时，这类手机上番茄会自动退回网页模式（正文是加密字体），App 其余功能不受影响。
