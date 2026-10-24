# 原生轻量模式（0.1.3）

设置顶部打开「轻量模式」，原生窗口右上角「完整模式」返回视觉舞台。
界面由 Rust / egui 编译并直接绘制，不包含 HTML、CSS、JavaScript 页面或 WebView。
桌面切换后退出 Electron；Android 销毁完整界面的 WebView，冷启动轻量模式不会初始化 WebView；鸿蒙不创建 ArkWeb 页面。
移动系统可能缓存此前完整模式使用过的系统运行库，原生界面不会通过这些运行库绘制。

| 平台 | 原生界面 | 音频 |
| --- | --- | --- |
| Windows x64 / ARM64 | egui + 原生窗口 / OpenGL | Rust WASAPI / ASIO |
| macOS Intel / Apple Silicon | egui + 原生窗口 / OpenGL | Rust CoreAudio |
| Linux x64 / ARM64 | egui + 原生窗口 / OpenGL（X11 / Wayland） | Rust ALSA |
| Android ARM32 / ARM64 / x86 / x86_64 | 相同 Rust UI，缓存式软件光栅化，Android 原生 View 呈现 | 原有 AAudio / USB 服务 |
| HarmonyOS ARM64 / x86_64 预览 | 相同 Rust UI，缓存式软件光栅化，ArkUI PixelMap 呈现 | 原有 OHAudio / USB 适配 |

五种仪表独立开关、默认全关：频谱、示波器、VU、频谱图、相位示波器。
全部关闭时停止可视化取样、重采样及 FFT；暂停、隐藏、最小化和画中画时停止仪表分析。
无仪表时界面按需刷新，播放进度约每 200 ms 更新；仪表启用时最多约 30 fps。
移动端使用有缓存的 Rust 软件光栅化，不把桌面 OpenGL 窗口嵌入系统 WebView。

原生界面提供播放列表、搜索、导入文件和目录、封面、内嵌 / 同名逐字歌词、歌词字号、应用音量、缓冲重置、
输出设备和 DSD 模式、设备格式表、信号链、DSP / EQ、预置和质量评分。
复用已配置的 SF2 音色库；导入音色库可在完整模式完成。
两种安装包都包含原生轻量模式，with-midi / without-midi 只区分是否附带大型音色库。

切换保留本次会话的歌曲、进度、音量、输出、DSP 和队列，关闭列表记忆时不会把队列当作永久列表保存。
桌面切换会重新打开音频会话；移动端复用同一个 Rust 音频引擎。
Windows / macOS / Linux 保留系统媒体控制，Android 保留媒体通知和系统控制；鸿蒙 AVSession 仍属待适配项。

VU 显示音源 RMS（DSP 之后、应用主音量之前），0 VU = −18 dBFS，扩展量程 −30 至 +18 VU；
显示约 300 ms 达到稳态 99%，峰值保持另行显示。此数字仪表不是模拟 VU 表的计量认证实现。
ASIO −1000 表示驱动报告硬件不可用；Dawn Pro 2 自制 ASIO 若依赖 libusbK，不能仅有 usbaudio2 绑定。
不会通过静默切换系统混音输出来冒充 ASIO / Bit-Perfect。

轻量模式专注 2D 播放与仪表，使用 3D、HDR 舞台、壁纸、视频导出或完整托盘控制时切回完整模式。
鸿蒙沿用原有预览限制；USB DAC / DSD 的硬件验证与平台原生能力分开记录。
macOS / Linux 的运行验证由对应 CI runner 完成，本机 Windows 不能替代实际平台验证。

```sh
pnpm light:build                     # Rust 原生 Debug 程序
pnpm light:release                   # Rust 原生 Release 程序
pnpm test:light                      # 原生指针 / 滑条 / 仪表 / 歌词与 VU 响应
node apps/lightweight/test-smoke.mjs  # 原生窗口及 GPU 帧截图；Linux 使用 xvfb-run
node apps/lightweight/test-native.mjs # 原生播放、队列、仪表和暂停
```

原生界面仅内嵌 OFL 的 Noto Sans SC / Latin 字体，许可证位于 crates/jap-light/fonts/OFL.txt。
构建需要 Rust 1.92 或更新版本；不再依赖 WebView2 或 WebKitGTK。
