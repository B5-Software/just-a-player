# Just A Player 0.1.6

这次加入在线电台和中英文界面，重点修复完整／原生模式切换、网易云队列同步及文件选择体验。

- **连续播放**：桌面完整界面与 Rust 原生界面共用一个后台音频会话。切换时不暂停、不重新打开音源或 DAC，网易云接管也保持连接。原生界面仍由 Rust 绘制；共享音频宿主使用无界面 Node 进程加载 Rust 内核，存在额外内存开销。独立运行 Rust 程序仍可使用进程内音频引擎。
- **原生界面**：跟随完整界面的强调色和深浅主题，补充图标，播放列表可折叠展开；修复窗口恢复白屏和 Windows 系统媒体控制缺少封面。
- **网易云队列**：同步客户端真实播放列表，可直接点歌、控制循环与随机模式。自动切歌只由客户端负责，避免双方推进队列；增加下一首预读、短暂控制故障重试和连接恢复，修复暂停恢复、漏接下一首及封面重复刷新。
- **在线电台**：完整与原生界面均可添加、收藏 HTTP／HTTPS 音频流，支持 M3U／PLS 地址、ICY 元数据、缓冲及有界重连。直播流不提供文件跳转或完整音源评分；HLS 暂不支持。
- **中英文**：默认跟随系统，可手动切换；未支持的系统语言使用英文。完整界面、原生界面和托盘共用语言设置，歌曲名称、文件名和歌词保持原文。README 提供中文与英文版本。
- **界面修复**：修复卡片首次打开时的位置闪烁，合并格式信息为一行，保留一个音质状态入口；重新整理 Windows 盘符、路径及文件过滤逻辑，Android 文件选择器适配横屏和较矮窗口。

本地已通过 Rust 全量测试、Clippy、TypeScript 检查、Windows 界面往返切换、原生后台／托盘／系统封面、网易云实际客户端队列及自然切歌测试。Android 四 ABI 完成本地 Release 构建，模拟器验证多种横屏比例。各发布安装包由对应平台 CI 构建并验证。

Windows／macOS／Linux 提供 x64 和 ARM64；Android 为 ARM64、ARM32、x86、x86_64 的固定密钥签名 Universal Release APK。所有安装格式均提供 **with-midi／without-midi**；后者省去内置大型音色库，保留 MIDI 合成和 SF2 导入。鸿蒙仍为预览适配，不包含在稳定版安装包矩阵中。

附带 FFmpeg／ffprobe、对应源码、第三方许可与 SHA-256 校验。许可证 GPL-3.0-or-later，作者 B5-Software。

## English

- Add streaming HTTP/HTTPS radio to both interfaces, including saved stations, M3U/PLS resolution, ICY metadata and bounded reconnection. HLS is not supported yet.
- Keep the same audio session when switching between the full and native interfaces, including a live NetEase connection. The native UI uses Rust; desktop continuity retains a headless Node host for the Rust engine, with additional memory overhead.
- Bring native appearance in line with the full interface, add icons and collapsible playlists, and fix window restoration and Windows media artwork.
- Synchronize the real NetEase queue and repeat/shuffle controls. Let the client advance its own queue, preserve next-track packets, retry transient failures and avoid reloading unchanged artwork.
- Add English and Simplified Chinese with system-language selection, English fallback, manual switching and a bilingual README. Preserve original metadata and lyrics.
- Fix first-open panel positioning, simplify format badges, improve Windows drive/path handling and fit the Android file browser to short landscape windows.

Every supported installer has **with-midi** and **without-midi** variants. Android packages are signed Universal **Release** APKs with four ABIs. The smaller variant retains MIDI synthesis and SF2 import. HarmonyOS remains a preview outside the stable installer matrix. Includes FFmpeg/ffprobe, corresponding source, third-party licenses and SHA-256 checksums. GPL-3.0-or-later, by B5-Software.
