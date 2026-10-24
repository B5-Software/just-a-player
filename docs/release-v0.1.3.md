# Just A Player 0.1.3

新增真正的原生轻量模式，继续沿用同一个 Rust HiFi 音频引擎。轻量界面由 Rust / egui 直接绘制，默认关闭所有可视化。

- **原生界面**：Windows、macOS、Linux 使用独立原生窗口，切换后退出 Electron；Android 使用原生 View，鸿蒙预览使用 ArkUI PixelMap，不加载 HTML 或 WebView 页面。移动端切换复用音频引擎，保留当前歌曲、进度、音量、输出、DSP 与本次会话队列。
- **可选专业仪表**：频谱、示波器、频谱瀑布、立体声矢量和 VU 各自独立开关。暂停、隐藏和最小化停止分析；歌词支持逐字时间戳和字号调整，所有内置界面字体使用 OFL 许可。
- **VU 修正**：直接读取音源 RMS，避免重复平滑。0 VU = −18 dBFS，量程扩展至 +18 VU，约 300 ms 达到稳态的 99%，避免正常响度音乐长期满偏。
- **触控与布局**：原生滑动条需要明确横向拖动，轻点不会改变音量；小窗保留可见的播放控制；修复完整界面输出格式表滚动时表头与内容重叠。
- **ASIO 诊断**：将驱动返回码转换为具体提示。−1000 表示硬件不可用；依赖 libusbK 的自制 Dawn Pro 2 ASIO 驱动需要对应 USB 绑定，仅有系统 usbaudio2 绑定无法启动该驱动。

两种音色版本均包含原生轻量模式：`without-midi` 不附带大型 SF2，仍可导入自己的音色；`with-midi` 内置 MuseScore General HQ。桌面覆盖 Windows / macOS / Linux 的 x64 与 ARM64；Android 是四 ABI universal、固定密钥签名的 **Release APK**。

3D、HDR 舞台、桌面壁纸、视频导出和完整托盘功能仍通过完整模式使用。鸿蒙保持实验性预览，原生 AVSession 控制仍待适配；USB 独占和 DSD 能力取决于实际设备及驱动，模拟器验证不代替 DAC 真机验证。

随包附带 FFmpeg / ffprobe、对应源码、第三方许可和 SHA256SUMS。应用采用 GPL-3.0-or-later，作者 B5-Software。
