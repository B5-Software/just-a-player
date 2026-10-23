# Android

Android 使用与桌面版同一份 React、Three.js 舞台、歌词、播放列表、DSP/EQ、音源分析和视频导出界面。Activity 强制正向或反向横屏；手机和平板共用一个 universal APK。

包名为 `org.b5_software.justaplayer`，来自作者域名 `b5-software.org`（Java 包名使用下划线替代域名中的连字符）。调试包附加 `.debug`，可与正式包并存。

## 架构与输出

| 项目 | 实现 |
| --- | --- |
| APK ABI | `arm64-v8a`、`armeabi-v7a`、`x86`、`x86_64`，一个 APK，关闭 ABI 拆包 |
| 最低系统 | Android 9 / API 28，需支持 WebGL 2 的 Android System WebView |
| 系统音频 | Rust → AAudio；可使用手机扬声器、耳机、蓝牙，系统可能重采样 |
| USB 独占 | Android USB Host 授权 fd → libusb → UAC1/UAC2 时钟与等时端点，绕过 AudioFlinger，无需 root |
| DSD | Rust DSF/DFF/SACD 解码；系统输出用 DSD → PCM，USB 支持兼容 DAC 的 DoP |
| 原生 DSD | RAW_DATA 格式与已知设备规则，不从 PCM 采样率猜测；包含 Dawn Pro 2 `35d8:011d` 的 DSD_U32_BE 排列 |
| 后台 | 原生播放 Service、MediaSession、媒体通知与媒体键；离开界面停止实时 GPU 绘制 |
| 小窗 | Android 系统画中画，沿用播放器的小窗界面 |
| MIDI | 与桌面相同的 Rust 实时合成，内置 MuseScore General HQ 无损 SF2；默认 96 kHz Float32，可导入 SF2 |
| 视频 | 独立 `:video` 进程离线生成帧，系统 GPU 视频编码优先、FFmpeg 回退；AAC、Opus、FLAC、PCM、原音轨复制 |
| 工具 | 四种 ABI 均随包提供 FFmpeg / ffprobe 9.0.2 + x264，无首次运行下载 |

USB 原生 DSD 的具体档位、反馈时钟、硬件音量与拔插行为仍需 Android 手机 + OTG + DAC 真机验证。模拟器不能代表 USB 硬件验证。直通不对 DSD 位流做 PCM 音量乘法；未确认硬件音量时会拒绝衰减后的直通播放，不会自动把音量推到 100%。

MIPS / MIPS64 已被现代 NDK 移除；此处 universal 表示当前四种 NDK ABI，不包含无法实际构建的 MIPS。Windows 桌面壁纸、托盘、ASIO、手动 GPU 选择属于桌面平台能力，不在 Android 中伪装为可用。

## 触屏、小窗与 HDR

舞台和歌词使用 Pointer Capture，松手、取消或切到其他窗口后结束拖动。轻点屏幕即可唤醒隐藏控件。滑动条轻点不改变值，横向明确拖动才调整；竖向 EQ 先停留约 220 ms 再拖动，直接竖滑用于滚动卡片。列表每行提供排序把手，其他区域保留正常滚动。小窗按实际画中画视口压缩布局，并向系统提供上一首、播放 / 暂停、下一首三个 RemoteAction。

“播放时保持屏幕常亮”默认关闭，开启后仅在播放且界面可见时设置窗口常亮标志；暂停和退到后台时释放。

界面按实际窗口像素尺寸计算独立的横屏比例，避免系统 DPI 把桌面布局挤在手机上；设置中的界面大小可单独调整，GPU 仍按实际屏幕像素绘制。

HDR 默认关闭。通过 Android Display HDR 能力与驱动 EGL 扩展检查后，所有内置效果使用原生 Float16 scRGB 或 HDR10 / PQ Surface。共享的 GLSL 在原生 GPU 上直接绘制，仅传递音频与交互参数、变更的封面、频谱历史及静态文字纹理；没有逐帧像素回读、Base64 帧传输或重复场景渲染。分辨率跟随渲染精度与屏幕尺寸，帧率跟随设置，不再限制 720p / 30 FPS。附加主题与仪表也支持同一路径；界面与歌词继续使用 SDR 覆盖层。WebGL、原生 HDR 与离线视频使用同一份抗锯齿代码。首帧完成后才显示 HDR，挂起或失败时保留 SDR 舞台。模拟器验证 WebGL 与原生浮点绘制一致性及 SDR 回退；Redmi K70 国行 Android 16 的实际 HDR 亮度、驱动及性能仍需真机确认。

后台视频由前台服务 `ExportRendererService` 的独立进程托管，使用独立 WebView 数据目录与虚拟显示表面；没有实时舞台的空转循环。离线帧与实时舞台共用定义，支持时经 VideoFrame / WebCodecs 编码为 H.264，再通过文件描述符管道封装音轨；不支持时回退为 FFmpeg 原始帧编码。默认适度让出计算时间，避免导出占满前台资源。队列空闲、取消或失去响应时释放后台资源。

## 文件与弹窗

音频、歌词、列表、字体选择，保存、覆盖、删除确认、颜色与下拉选项均使用应用内玻璃卡片。文件框提供应用音乐目录、手机 Music、Downloads 和路径输入。

Android 的 USB 设备授权和读取媒体权限必须由系统批准，不能由自绘界面替代；只在用户点击相应授权按钮后请求。应用不申请所有文件管理权限。受 scoped storage 限制的歌词、字体或写入位置，可放到文件框中的“应用音乐目录”；应用不会把无权限目录显示成导入成功。

文件管理器的“打开方式”可直接打开音频（含 MIDI / NCM）。接收临时授权的 content URI 后先复制到应用音乐目录中的 `Opened/`，再追加到“外部打开”列表，避免授权到期后曲目失效；已有列表保持不变。单文件 URI 不会隐式授予同目录歌词的权限，需另外导入歌词。

## 本地构建

需要 JDK 21、Node 24、pnpm 12、Rust stable、Android SDK 35 / build-tools 35 与 NDK `26.1.10909125`。Windows 还需要 Git for Windows；FFmpeg 的 C 构建使用其中的 Bash 和 NDK Make。Linux 需要基础 C 构建工具及 GNU Make。

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
pnpm install --frozen-lockfile
# ANDROID_HOME 指向 SDK；可用 ANDROID_NDK_HOME 覆盖 NDK 位置
pnpm android:build
```

正式输出：`apps/android/app/build/outputs/apk/release/app-release.apk`。构建前通过环境变量 `ANDROID_KEYSTORE_PATH`、`ANDROID_STORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 配置自己的固定签名密钥。也可在本机用户目录的 `.just-a-player/android-signing.json` 保存这四项配置，切勿提交密钥或密码。

默认 `with-midi`；设置 `JAP_BUNDLE_MIDI=0` 后构建 `without-midi`，省去内置 HQ 音色，仍保留 SF2 导入和完整合成能力。两种正式包使用同一应用 ID 与签名，可以覆盖升级。CI 将签名材料存为仓库 Secrets，发布包关闭 WebView 调试；不具备 Secrets 的外部 PR 只构建 QA 包，不伪造正式签名。

开发测试使用 `pnpm --filter android build:debug`，产物为 `apps/android/app/build/outputs/apk/debug/app-debug.apk`；Debug 包仅用于自动化，不进入 Release 下载附件。

FFmpeg 与 x264 从固定源码和 SHA-256 构建；缓存位于 `apps/android/build/codecs/`。Rust JNI 与工具均使用 16 KiB ELF 页对齐，DST 的 C++ 运行库静态链接以避免旧 NDK 共享运行库的 4 KiB 限制。打包前逐 ABI 检查 JNI、FFmpeg 和 ffprobe，缺失任一项就失败。

`with-midi` 的 HQ 音色库在构建时下载并校验，完整打入 APK；首次启动在后台解压到应用私有目录，不需联网。它会增加约 467 MiB 的安装资源，使用 MIDI 时还需相应采样内存；多个实例共享采样数据。切换安装 `without-midi` 后清理旧的内置音色副本，自行导入的 SF2 保留。

### 模拟器测试

启动 x86_64 Android 35 模拟器并等到 ADB 在线，然后：

```sh
pnpm android:test
```

CI 使用配置 4 GiB 内存的 Android 16 / API 36 `google_apis_playstore_ps16k` 量产 `user` 镜像，关闭模拟器联网后验证实际 16 KiB 页面、离线播放与签名 Release 包，并固定测试期间的 WebView 版本。
仅在 CI 的临时模拟器中停用 Play 商店、Google Play 服务与 Assistant，避免全新镜像首次启动的安装和服务激活占满内存、使系统杀掉正在导出的 WebView。播放器不依赖这些服务，播放、GPU、五种视频音轨、触屏、系统媒体控制和正式包调试检查仍完整执行。
不要用 `google_apis` 的 `userdebug` / `eng` 镜像判断正式包是否关闭调试：
[Chromium 124 的实现](https://github.com/chromium/chromium/blob/124.0.6367.219/android_webview/glue/java/src/com/android/webview/chromium/SharedStatics.java#L79-L85)
在这些系统上强制启用 WebView 调试，并忽略应用关闭调试的调用。调试包的功能测试仍可在这类镜像运行。

测试通过真实 WebView → Java → JNI → Rust → AAudio 路径播放 WAV 与 DSD，用 APK 内置 FFmpeg 播放 DTS，并通过原生 FLAC 解码器核对 24-bit / 768 kHz 文件跳转后的每一个样本；验证 DSP、分析、缓冲、横屏、自定义弹窗、后台渲染暂停和系统媒体控制。测试还在前台继续播放的同时，排入 AAC、Opus、FLAC、PCM 与原音轨复制五个 3D 视频任务，检查完成状态并通过应用自身的存储权限读取导出文件、验证容器文件头。报告、导出文件与截图保存在 `apps/android/test-results/`。CI 配置同样构建四种 ABI 后运行模拟器测试并上传 APK，其他三种 ABI 的构建通过不等于相应真机已验证。

`node apps/android/scripts/test-layout.mjs` 仅在模拟器中切换 320 / 560 DPI，核对布局和实际绘制像素，并恢复原设置。

`node apps/android/scripts/test-touch-midi.mjs` 在主测试后执行，补充冷 / 热启动的 MIDI content URI、实际触屏拖动、滑动条误触、3D 歌词、常亮标志、SDR 回退以及真实 PiP 视口布局检查。

调试 Android CI 时可手动运行 `gh workflow run build.yml --ref main -f android_only=true`，只执行两个 APK 版本的完整验证，避免反复构建桌面矩阵。普通 push 和版本标签始终执行全部平台。

## 许可与源码

应用为 GPL-3.0-or-later。FFmpeg 与 x264 使用 GPL-2.0-or-later 兼容组件，禁用 nonfree；完整固定源码、构建脚本与许可证随 CI 产物/源码仓库提供。普通安装不需要编译环境。libusb 使用 LGPL-2.1-or-later，NDK libc++ 使用 Apache-2.0 with LLVM exceptions；字体为 OFL 1.1。
