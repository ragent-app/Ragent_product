# Ragent

Ragent 是一个 AI 工作台，将计算机上运行的智能体工具与 Web 和 Android
客户端连接起来，帮助用户跨设备管理会话和工作。

> 当前源码已公开供审阅；各安装包的验证范围和限制请查看发布说明。

电脑端安装包可在 [官网下载页](https://www.agentoncloud.com/download.html)和 [GitHub Releases](https://github.com/ragent-app/Ragent_product/releases/latest) 获取，支持 Windows 11 x86-64、macOS 13 及以上 Apple Silicon，以及 Ubuntu 24.04 x86-64 和 ARM64。当前公开版本为 0.0.2。
电脑端通过公开版本和内部构建标识检查更新；内置更新功能之前的旧版需要先手动更新一次。
Android 应用目前在 Google Play 封闭测试，也可从 GitHub Releases 下载单独签名的 APK。

## 主要功能

- 在电脑上运行智能体会话，通过网页或 Android 客户端查看进度、历史和结果。
- 按需管理工作区和文件、配置可用的 Harness 与模型服务，并处理审批请求。
- 配对可信设备；远程连接方式取决于网络、账号和部署配置。

功能及审批行为因运行时、服务商和部署方式而异，请以发布说明的验证范围为准。

![桌面管理器中的 Harness 管理界面](docs/media/windows-desktop-manager-v2.png)

*浏览器中的桌面管理器连接隔离的临时实例，画面不含个人数据。*

<img src="docs/media/android-session.png" alt="Android 应用中已完成的示例会话" width="300">

*Android 测试版本连接共享演示实例的实际画面。*

## 源码入口

- `chat/`、`lib/`：会话、执行、运行时适配与共享逻辑。
- `static/`：Web 工作台。
- `android/`：Android 应用及共享模块。
- `p2p/`：P2P 主机与信令代码。
- `accounts/`、`infrastructure/turn-broker/`：通用账号和 TURN broker 实现。
- `tests/`：自动化测试。
- `packaging/`、`native/`：平台集成与打包源码。

更多背景见 [架构说明](docs/architecture.md)。

## 本地查看

需要 Node.js 24 或更新版本。在项目根目录执行：

```sh
npm ci --ignore-scripts
node cli.js --help
node scripts/launch-test-instance.mjs --port 45678 --ttl 600
```

启动后可访问 `http://127.0.0.1:45678/`。该命令创建隔离的临时实例，
十分钟后停止；它不会自动安装 Harness 或配置模型服务。Windows 上已验证
实例健康接口、首页和 Web 脚本可访问；真实模型执行、完整测试与安装流程
仍需进一步验收。

## Android

英文 [README](README.md#android-contributor-build) 包含贡献者调试构建步骤。
该模式使用自行生成的调试密钥，不包含生产 Google 服务配置，不适用于
Google Play 发布，也不能用于验证正式 Google 登录或推送。

## 许可证

项目自有源码采用 Apache-2.0；第三方组件保留各自的许可证，参见
`LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`。依赖与素材审查仍在进行。
