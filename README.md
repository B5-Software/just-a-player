<div align="center">

<img src="apps/desktop/build/icon.png" width="88" alt="Just A Player 图标" />

# Just A Player

### HiFi，也好看。

让声音长出形状，让旋律点亮星河。一个由 **B5-Software** 打造的本地音乐播放器。

[![Build](https://github.com/B5-Software/just-a-player/actions/workflows/build.yml/badge.svg)](https://github.com/B5-Software/just-a-player/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/B5-Software/just-a-player?color=8973ff&label=下载)](https://github.com/B5-Software/just-a-player/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/B5-Software/just-a-player/total?color=6ca9e8)](https://github.com/B5-Software/just-a-player/releases)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-8f79d9)](LICENSE)

**[下载安装包](https://github.com/B5-Software/just-a-player/releases/latest)** · **[界面与功能](#看见音乐)** · **[音频输出](#认真播放)** · **[从源码构建](#从源码构建)**

</div>

![封面取色的玻璃界面、声波星球与毛笔 3D 歌词](docs/screenshots/hero.png)

## 看见音乐

封面的颜色缓缓流入背景、控件与光影。3D 场景随音乐起伏，歌词也有自己的空间、字体和姿态。

- **沉浸式舞台**：多种 3D 动效、全屏模式、鼠标交互，以及可平移、旋转、缩放的舞台布局。
- **立体歌词**：2D / 3D 歌词、字号调节、独立位置和旋转；新手指导提供测试歌词，调整后自动保存。
- **细腻的界面**：模糊封面、玻璃卡片、自动强调色、切歌颜色过渡、深浅主题与圆角自绘托盘。
- **字体自由**：内置 10 种 OFL 歌词字体，涵盖楷体、毛笔、手写与可爱风格；支持导入 TTF、OTF、WOFF、WOFF2、TTC、OTC。
- **专业仪表**：示波器、频谱、时频谱等 2D 视效，结合峰值、RMS 等读数；文字与刻度使用 OFL 字体。

![时频谱、频率刻度与实时电平读数](docs/screenshots/instruments.png)

### 音乐可以留在桌面

选择悬浮播放，主窗口直接收起为小窗，封面与播放控制仍在手边。Windows 桌面壁纸可全屏展示歌词与视效，支持多显示器、鼠标跟随、日期与时间。

主窗口显示时，壁纸渐变为保留画面的静态模糊背景；小窗或后台播放时恢复动态。可视化场景只由当前活动的舞台渲染，隐藏或最小化的窗口暂停绘制。

<p align="center"><img src="docs/screenshots/mini.png" width="550" alt="带模糊封面背景的 Just A Player 小窗" /></p>

## 认真播放

音频由独立进程中的 **Rust 引擎**解码与输出，界面负责控制和可视化。信号链卡片展示源格式、处理过程与实际输出格式。

| 系统 | 原生音频路径 | 安装包架构 |
| --- | --- | --- |
| Windows | WASAPI 共享 / 独占、ASIO | x64、ARM64 |
| macOS | CoreAudio、CoreAudio Hog 独占 | Intel x64、Apple Silicon ARM64 |
| Linux | ALSA 系统共享、`hw:` 硬件独占 | x64、ARM64 |

- **原始格式输出**：独占模式协商采样率、声道和样本格式；ALSA 硬件输出拒绝采样率替换，CoreAudio Hog 检查设备物理格式。不支持的配置会返回原因。
- **DSD**：DSF / DFF、DSD 转 PCM、DoP，以及支持驱动上的 ASIO 原生 DSD；解码卡片显示 DSD 格式。DoP 需要设备与独占路径共同支持，原生 DSD 需要对应 ASIO 驱动。Windows ARM64 的 ASIO 还需要 ARM64 驱动。
- **DSP 与 EQ**：均衡器、预置音效和应用内音量。默认音量 **20%**；追求 bit-perfect 时应关闭 DSP、将应用音量设为 100%，并确认实际硬件输出格式。
- **缓冲恢复**：检测流异常后重建缓冲；播放底栏、循环模式旁、托盘及输出设置提供手动重置入口。
- **系统控制**：媒体键与后台播放；Windows 系统控制中心显示曲目信息、封面及播放 / 暂停 / 切歌操作。

macOS 与 Linux 的后端由原生 CI 编译和空设备冒烟测试覆盖；具体 DAC、独占格式及 DSD 档位仍需对应硬件验证。软件无法替代设备厂商的驱动，也不会把驱动未提供的 DSD256 能力标记为可用。

### 本地曲库，好好整理

FLAC、WAV、AIFF、ALAC、MP3、AAC、Ogg 等常见格式，另支持 APE、DTS、DSD、SACD ISO、CD ISO / CUE。SACD ISO 当前按连续音频区域播放，优先立体声区域。APE / DTS 等扩展解码通过系统 FFmpeg 完成。

**NCM 直接导入、直接播放**：Rust 内置可寻址解密数据源，基于 [ncmdump-js-b5s](https://github.com/B5-Software/ncmdump-js-b5s) 实现，读取解码器所需的数据，不生成转换后的音频文件。

- 多列表管理、搜索、拖动排序、随机 / 循环、M3U / M3U8 / JSON 导入导出。
- 自动扫描系统音乐目录、常见网易云下载目录和自定义目录。
- 同名不同格式按质量优先导入，同名 LRC 稳定匹配。
- 每个列表分别记住曲目、进度与随机顺序；重启不自动播放，点击播放后续播。
- 尚未播放时，底栏显示**列表名称**及**即将播放曲目的封面**。

![待播放状态显示列表名称与下一首封面](docs/screenshots/playlist.png)

### 分析音源，也导出画面

**音源质量分析**给出数值评分，结合削波、噪声、动态、频谱带宽和有效位使用情况评估，不只读取元数据。升频、扩位与 AI 处理迹象属于带置信度的推测，不能据此证明音频的制作来源。

**视频导出队列**使用独立后台渲染，支持同时排入多首任务，前台仍可听歌。可设置分辨率、帧率、画质、歌词与 3D 动效，片头片尾元数据渐入渐出，并支持自定义署名。音频提供 AAC、Opus、FLAC、PCM 及原始压缩音轨复制等选项，实际可用项取决于输出容器。

HDR 默认关闭，支持的设备与图形路径可开启；提供帧率上限、渲染精度、后处理开关，以及 Windows 手动 GPU 选择。设备灯光可通过本机 OpenRGB SDK 服务跟随播放器强调色。

## 下载与运行

前往 **[Releases](https://github.com/B5-Software/just-a-player/releases/latest)** 选择对应架构：

| 平台 | 文件 |
| --- | --- |
| Windows | `Just-A-Player-版本-win-x64.exe` / `win-arm64.exe` |
| macOS | `Just-A-Player-版本-mac-x64.dmg` / `mac-arm64.dmg`，另有 ZIP |
| Linux | `Just-A-Player-版本-linux-x86_64.AppImage` / `linux-arm64.AppImage`；deb 分别为 `linux-amd64.deb` / `linux-arm64.deb` |

发布页附有 `SHA256SUMS.txt`。社区构建暂未使用商业代码签名证书或 Apple 公证。桌面壁纸与 Windows 系统媒体集成为 Windows 功能；其他平台可使用全屏、小窗、媒体键和原生音频输出。

基础无损播放与可视化不需要额外解码工具。**视频导出及部分扩展格式需要 FFmpeg 与 ffprobe**，安装后让它们位于 PATH 中，或位于 macOS 的 `/opt/homebrew/bin`、`/usr/local/bin`：

```sh
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg
```

Windows 可安装 [FFmpeg](https://ffmpeg.org/download.html) 并将其 `bin` 目录加入 PATH，随后重启播放器。本项目不捆绑 FFmpeg 二进制。ARGB 联动需要单独运行 [OpenRGB](https://openrgb.org/) 的 SDK 服务。

默认设置：**3D 歌词、音量 20%、原生渲染精度、不限制帧率、后处理开启；HDR、桌面壁纸与 ARGB 联动关闭**。最小化暂停绘制，后台音频按设置继续播放。

## 从源码构建

需要 Node.js 24、pnpm 12、Rust stable（至少 1.88），以及本平台 C/C++ 编译环境。Windows 使用 Visual Studio Build Tools 的 C++ 工具链；macOS 使用 Xcode Command Line Tools；Linux 需要 ALSA 开发包：

```sh
# Debian / Ubuntu 构建依赖
sudo apt install build-essential pkg-config libasound2-dev

git clone https://github.com/B5-Software/just-a-player.git
cd just-a-player
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

开发入口会检查并补齐 Electron 可执行文件，避免 pnpm 依赖变体缺少二进制时出现 `Electron uninstall`。若只修改界面，后续直接运行 `pnpm dev`；修改 Rust 后先运行 `pnpm engine:build`。

```sh
pnpm typecheck
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
pnpm --filter desktop test:e2e:smoke

# 构建本机安装包，产物位于 apps/desktop/release/
pnpm package
```

CI 在 Windows、macOS、Linux 的 x64 与 ARM64 原生 runner 上编译 Rust、检查类型、执行测试、打包，并启动打包后的程序验证引擎与界面。推送 `v*` 标签后，全部平台成功才上传 Release。

### 项目结构

```text
apps/desktop/       Electron 主进程、React 界面、Three.js 视效与打包配置
crates/jap-core/   音频类型与进程协议
crates/jap-decode/ 原生解码、NCM、DSD 与光盘容器
crates/jap-output/ WASAPI、ASIO、CoreAudio、ALSA 与空输出
crates/jap-engine/ 播放状态机、缓冲与 DSP
crates/jap-analysis/ 音源分析
crates/jap-napi/   Node-API 桥接
```

## 开源与致谢

Copyright © 2026 **B5-Software**。本项目按 **[GNU GPL v3.0 或更新版本](LICENSE)** 发布。

内置字体使用 SIL Open Font License 1.1，未嵌入商业字体。第三方组件保留各自许可证，完整说明见 [THIRD_PARTY.md](THIRD_PARTY.md)；安装包附带依赖许可文件。感谢 Rust / Symphonia / CPAL / ALSA、Electron / React / Three.js，以及 NCM、DST 解码器和开源字体项目。

README 图片来自实际应用界面；演示音频、封面与歌词由项目生成，不含用户曲库或商业歌曲素材。
