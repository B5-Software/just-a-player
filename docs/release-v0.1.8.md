# Just A Player 0.1.8

- **触屏均衡器**：从滑块圆点直接上下拖动，点按时保持当前增益。沿轨道其他位置划动可滚动 DSP 面板。
- **MIDI 合成**：修正效果发送量与声像计算、重置后的鼓组和部分变体音色。混响延迟按采样率换算，MIDI 总音量作用于整个混音。
- **桌面模式切换**：从 Native 返回完整模式时加载本地界面，修复开发服务器已退出时的白屏，并继续使用原播放会话。
- **Windows 系统媒体控制**：更新曲目信息、封面和进度。改进连接外部播放器后的跳转同步，减少延迟回报造成的进度回跳。

Windows、macOS 和 Linux 提供 x64 与 ARM64 安装包。Android 提供支持四种 ABI 的签名 Universal Release APK。各安装格式均提供 with-midi 和 without-midi 两种版本，后者仍可导入 SF2。

## English

- Drag the EQ thumb directly on a touchscreen. Taps preserve the gain, and swipes elsewhere on the rail scroll the DSP panel.
- Correct MIDI effect sends, pan, drum selection after reset and SoundFont variation selection. Reverb timing now follows the sample rate, and MIDI master volume applies to the entire mix.
- Load the bundled interface when returning from Native mode so the full player can reopen after the development server exits. Playback continues in the same session.
- Update metadata, artwork and progress in Windows media controls. Improve seek synchronization with external players when position updates arrive late.

Windows, macOS and Linux installers are available for x64 and ARM64. Android downloads are signed Universal Release APKs covering four ABIs. Both with-midi and without-midi editions support imported SF2 banks.
