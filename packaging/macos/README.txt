Ragent — 本地 AI 自动化工作台 (macOS)

快速开始 / Quick start
----------------------
1. 把 AgentoC.app 拖入 Applications（或直接双击运行）。
2. 首次运行会自动生成 owner 登录凭据并弹出文本文件显示用户名/密码
   （保存在 ~/.config/agentoc/owner-credentials.txt，登录后请改密并删除该文件）。
3. 自动打开 Ragent 桌面管理器；也可在浏览器中打开 http://127.0.0.1:7690/。

日常使用
--------
- 双击 AgentoC.app：启动服务并打开桌面管理器（服务已运行时仅打开管理器）。
- 命令行：AgentoC.app/Contents/MacOS/agentoc-cli <command>
  （例如 agentoc-cli doctor、agentoc-cli set-password）
- 停止服务：AgentoC.app/Contents/MacOS/agentoc-stop
- 日志：~/.config/agentoc/chat-server.log
- 实例配置（升级保留）：~/.config/agentoc/instance.env

可选：登录时自动启动（手机随时可连的前提）
------------------------------------------
APP="/Applications/AgentoC.app"
mkdir -p ~/Library/LaunchAgents
sed -e "s|{{APP_PATH}}|$APP|g" -e "s|{{HOME}}|$HOME|g" \
  "$APP/Contents/Resources/com.agentoc.agentoc.plist" \
  > ~/Library/LaunchAgents/cloud.agenton.agentoc.plist
launchctl load ~/Library/LaunchAgents/cloud.agenton.agentoc.plist
# 卸载：launchctl unload ~/Library/LaunchAgents/cloud.agenton.agentoc.plist && rm 该文件
# 注意：使用自启动后无需再双击 App；停止服务用 agentoc-stop（LaunchAgent 会自动拉起，
# 彻底停用请先 launchctl unload）。

手机连接（TURN + P2P）
----------------------
本机保持完全私有：不设任何公网直接访问入口，所有入站流量只经
Cloudflare Realtime TURN 中转。

中央服务（Accounts / TURN 凭据 / P2P 信令）本包已预置默认地址，
开箱即用；仅自建中央栈时才需要改 instance.env 中对应变量。

在本机：
  1. 在浏览器中登录（首次双击 AgentoC.app 自动生成凭据），
     进入 设置 → 设备/账号 绑定 Google 账号
     （手机与 Mac 绑定同一 Google 账号；未绑定的 Mac 通过一次性
     account-claim 二维码由已绑定的手机授权）。
  2. 手机端打开 Ragent，选择这台 Mac：设备鉴权与引导经 DataChannel
     完成，连接先经 Cloudflare Realtime TURN 建立，网络允许时自动
     升级为 P2P 直连并释放 TURN 租约。

AI 执行引擎
-----------
- CodeX (codex)：已内置（含 macOS 原生引擎），首次启动自动安装命令 shim。
- Claude Code (claude)：已内置原生二进制，首次启动自动安装命令 shim。
- 首次使用需在 设置 → 模型提供方 完成对应账号登录/API Key 配置。

安全说明
--------
- 服务仅监听 127.0.0.1，不经本机对外暴露端口。
- 手机流量经 Cloudflare Realtime TURN 中转，仅承载加密的应用流量。
- 凭据与会话数据保存在 ~/.config/agentoc/。
