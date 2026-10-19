## Just A Player 0.1.1

安装即可使用扩展解码与视频导出，无需另装 FFmpeg 或配置 PATH。

- 六个平台安装包内置 FFmpeg / ffprobe 9.0.2 及完整运行库，离线也能使用。
- Rust 扩展解码、后台视频编码和音轨封装都优先使用安装目录中的工具，避免调用系统上的不同版本。
- CI 清空系统 PATH，实际验证 DTS 播放，以及 H.264 视频配 AAC、Opus、FLAC、PCM 和原始音轨复制；源码运行和打包后的应用分别验证。
- 发布页提供 FFmpeg 完整对应源码、依赖与构建脚本；安装目录附带许可证、构建配置和版本清单。

Windows ARM64 播放器及音频引擎为原生 ARM64；随附 FFmpeg / ffprobe 为 x64，由 Windows 11 ARM 兼容层运行。其他五个平台的工具与安装包架构一致。硬件视频编码仍取决于 GPU 与驱动，可自动回退 CPU。

保留 v0.1.0 的 HiFi 输出、沉浸式可视化、3D 歌词、曲库与播放记忆等功能。DAC 独占格式与原生 DSD 仍需要设备和驱动支持。

社区构建未使用商业签名证书或 Apple 公证。校验文件为 `SHA256SUMS.txt`；`tas-ffmpeg-9.0.2-corresponding-source.tar.xz` 是第三方源码，普通用户无需下载。

作者：**B5-Software** · 应用：**GPL-3.0-or-later** · FFmpeg 构建：**GPL-2.0-or-later**。
