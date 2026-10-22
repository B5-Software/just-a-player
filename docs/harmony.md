# HarmonyOS PC 7.0（实验性）

复用 React 界面和 Rust 引擎，通过 ArkWeb + Node-API 接入原生 OHAudio。
包名 `org.b5_software.justaplayer`，作者 B5-Software，版本 0.1.2。

| 用途 | Rust target | HAP ABI |
| --- | --- | --- |
| ARM64 真机，主要目标 | `aarch64-unknown-linux-ohos` | `arm64-v8a` |
| 官方 PC 模拟器 | `x86_64-unknown-linux-ohos` | `x86_64` |

同一个 HAP 包含两种 ABI。使用 DevEco Studio 26.0.0.851、HarmonyOS SDK
26.0.0 / API 26，以及官方 PC 7.0.0.107 模拟器做本地验证。

## 已验证的路径

- OHAudio 实际播放、跳转、暂停，按原生流报告设备格式；共享路径明确显示系统混音。
- 24-bit / 768 kHz FLAC 原生解码与 LYRICS 内嵌歌词读取。
- 6.144 MHz / float64 RF64 按块读取，设备不支持时经过 FFT 抗混叠降采样到实际输出率，标明非 bit-perfect。
- 逐字 LRC、字体资源、玻璃界面及图形失败后的 2D 歌词回退。
- USB 描述符解析、授权 FD 交给 Rust/libusb 的通路已编译；和 Android 共用 PCM / DoP / 原生 DSD 传输实现。

USB 独占需要真实 USB DAC；模拟器不能验证 USB 传输、硬件时钟或 bit-perfect。
OHAudio 共享输出不能宣称 bit-perfect。当前官方 PC 模拟器的 ArkWeb 禁用 WebGL，
因此该环境未验证 3D 画面、HDR 与 GPU 性能，界面会显示明确回退提示。

当前 HAP 是原生适配预览，尚未接入鸿蒙后台视频编码、AVSession 系统媒体控制、
后台播放权限申请和内置 FFmpeg 扩展解码。支持手动导入 SF2；暂不打包 HQ 音色库。
桌面壁纸和 Windows 托盘等桌面功能不在这个预览包中。

## 本地构建

安装官方 DevEco Studio、HarmonyOS 7 SDK、Node、pnpm 和 Rust。默认脚本识别
Windows 标准 DevEco 安装位置；其他安装位置设置 `HARMONY_NATIVE_SDK`，指向
SDK 的 `openharmony/native` 目录。构建所需 SDK 不随仓库分发。

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-unknown-linux-ohos x86_64-unknown-linux-ohos
node apps/harmony/scripts/build-native.mjs --arm64
node apps/harmony/scripts/build-native.mjs
pnpm --filter harmony build:web
cd apps/harmony
pnpm dlx @deveco/deveco-cli@1.3.7 build --build-mode release
```

产物：`apps/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。
这是 **Release 构建、未签名 HAP**，不能当作已签名真机安装包。真机安装需要在
DevEco 配置自己的开发者证书和 provisioning profile；签名材料不进入仓库。

## 模拟器回归

先使用官方 CLI 创建、启动 PC 7 模拟器，再安装启动应用：

```sh
cd apps/harmony
pnpm dlx @deveco/deveco-cli@1.3.7 run --device 127.0.0.1:10671
cd ../..
node apps/harmony/scripts/test-emulator.mjs
```

通过 `JAP_HARMONY_SERIAL` 选择 HDC 设备，`HDC_PATH` 指定官方 hdc。
测试只对 Debug 包开放的 `qaWrite` 导入原创合成测试信号；Release 中拒绝该操作，
同时关闭 ArkWeb 调试。报告和截图在 `apps/harmony/test-results/`，不进入发布包。

独立的 `HarmonyOS preview` 工作流供安装了官方 SDK 的自托管
`harmonyos-7` runner 手动执行，不阻塞桌面及 Android 的正式 CI / Release。
