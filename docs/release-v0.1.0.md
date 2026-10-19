## Just A Player 0.1.0

HiFi，也好看。B5-Software 的首个开源版本。

- 原生音频输出：Windows WASAPI/ASIO、macOS CoreAudio/Hog、Linux ALSA 硬件直出与共享输出。
- 沉浸式 3D 可视化、专业 2D 仪表、可拖动旋转的 3D 歌词、封面取色与玻璃界面。
- DSP、EQ、音源分析、应用内音量、DSD/DoP、NCM 直接播放，以及后台视频导出队列。
- 列表名称与待播放封面、逐列表曲目/进度/随机顺序记忆、带测试歌词的新手指导。
- Windows 桌面壁纸、系统媒体控制与自绘托盘；小窗与后台播放。

下载对应系统和架构的安装包；SHA256SUMS.txt 提供校验值。Windows 提供 x64 与 ARM64，Linux 提供 x64/ARM64 的 AppImage 与 deb，macOS 分 Intel 与 Apple Silicon。

社区构建未使用商业签名证书或 Apple 公证。APE/DTS 等扩展解码与视频导出需要系统可用的 FFmpeg 和 ffprobe；基础无损播放与可视化不依赖它们。

DSD 与独占格式取决于实际 DAC 和驱动，不支持时会明确报错。macOS/Linux 由各自原生 CI 编译与空设备测试，特定 DAC 仍需对应硬件验证。

作者：**B5-Software** · **GPL-3.0-or-later**。
