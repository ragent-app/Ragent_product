Ragent — 本地 AI 自动化工作台 (macOS)

需要 macOS 13 或更新版本。桌面管理器使用 Electron 44。

快速开始 / Quick start
----------------------
1. 把 AgentoC.app 拖入 Applications（或直接双击运行）。
2. 首次运行会自动生成 owner 登录凭据并弹出文本文件显示用户名/密码
   （保存在 ~/.config/agentoc/owner-credentials.txt，登录后请改密并删除该文件）。
3. 自动打开 Ragent 桌面管理器；也可在浏览器中打开 http://127.0.0.1:7690/。

日常使用
--------
- 双击 AgentoC.app：启动服务并打开桌面管理器（服务已运行时仅打开管理器）。
- 命令行：AgentoC.app/Contents/Resources/agentoc-cli <command>
  （例如 agentoc-cli doctor、agentoc-cli set-password）
- 停止服务：AgentoC.app/Contents/Resources/agentoc-stop
- 日志：~/.config/agentoc/chat-server.log
- 实例配置（升级保留）：~/.config/agentoc/instance.env

可选：登录时自动启动（手机随时可连的前提）
------------------------------------------
先停止正在运行的 Ragent 服务，然后在终端中运行：
"/Applications/AgentoC.app/Contents/Resources/agentoc-login" enable
查询状态："/Applications/AgentoC.app/Contents/Resources/agentoc-login" status
停用并停止登录服务："/Applications/AgentoC.app/Contents/Resources/agentoc-login" disable
停用不会删除配置、凭据、工作区或日志。启用后服务在登录时启动并在异常
退出后重启；正常退出服务前请先停用自启动。若已有同名的手工配置，本工具
不会覆盖或卸载它，请先自行检查和移除旧配置。移动应用前请先停用，移动后
再从新位置启用。服务日志位于配置目录下 launch-agent.stdout.log 和
launch-agent.stderr.log，要求仅当前用户可读写。

手机连接（TURN + P2P）
----------------------
本机服务默认监听回环地址。手机连接依赖账号、信令和中继服务；
可用功能和网络路径以对应版本的发行说明及实际验收结果为准。
默认中央服务地址在 instance.env 中，可由部署方配置。

在本机：
  1. 在浏览器中登录（首次双击 AgentoC.app 自动生成凭据），
     进入 设置 → 设备/账号 绑定 Google 账号
     （手机与 Mac 绑定同一 Google 账号；未绑定的 Mac 通过一次性
     account-claim 二维码由已绑定的手机授权）。
  2. 手机端打开 Ragent，选择这台 Mac。连接可使用中继，网络条件
     允许时也可能使用直连；实际行为取决于服务和网络配置。

AI 执行引擎
-----------
- Codex (codex)：已内置（含 macOS 原生引擎），由应用包内的启动器调用。
- Claude Code (claude)：已内置原生二进制，由应用包内的启动器调用。
- 首次使用需在 设置 → 模型提供方 完成对应账号登录/API Key 配置。

安全说明
--------
- 服务仅监听 127.0.0.1，不经本机对外暴露端口。
- 中继和直连的可用性取决于账号、服务和网络状态。
- 凭据与会话数据保存在 ~/.config/agentoc/。
