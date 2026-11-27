# Ragent 桌面端与 Android 端网络连接、性能与体验优化方案

- **编写日期**：2026-11-27
- **仓库基线**：`Ragent_product`（主分支 `main`）
- **覆盖范围**：桌面端服务（`chat-server.mjs` / `chat/` / `lib/` / `desktop/`）、Accounts 控制面与中继（`accounts/`）、Go P2P Sidecar 与信令（`p2p/` / `tunnel/`）、Web 前端（`templates/` / `static/`）、Android 原生客户端（`android/`）
- **文档定位**：结合代码级瓶颈审计与 ChatGPT / Gemini 客户端体验对标，形成可分阶段落地的全链路工程改造方案。

---

## 一、与 ChatGPT / Gemini 的连接与交互体验对标

ChatGPT 与 Gemini 之所以能提供“极快、极跟手”的交互体感，**约 30% 来源于云原生边缘基础设施，约 70% 来源于“本地优先秒开 + 单通道流式直推 + 乐观/平滑前端渲染 + 后台无感游标续传”**。Ragent 作为私有主机 + 移动端架构，天然不能（也不应）为了速度放弃本地执行与隐私，但完全可以在协议效率、本地缓存与前端感知层对齐甚至超越云端应用体感。

### 1.1 核心维度对比与差距根因

| 维度 | ChatGPT / Gemini（云原生） | Ragent 当前实现（私有主机 + 移动端） | 体验差距根因与可借鉴方向 |
| :--- | :--- | :--- | :--- |
| **网络拓扑与建连** | 就近 Anycast 边缘节点 + HTTP/3 QUIC / HTTP/2 持久连接，0-RTT / 1-RTT 即可发送请求 | 移动端无公网端点场景需经 Accounts 8 跳串行 Rendezvous → 签发 TURN 凭证 → 唤醒桌面 Go Sidecar → WSS 信令 → WebRTC ICE/DTLS/SCTP → `/api/auth/me` 探测（冷启 11+ 跳） | 无法变成纯云端，但可通过**合并 Rendezvous、预热/复用有效租约、全局共享 `OkHttpClient` 连接池、ICE Restart** 把重连压到 0.5~1.5s |
| **实时推流与接收** | 单条 HTTP/2 或 HTTP/3 SSE 直推 token 增量，零轮询，原生 Gzip/Brotli 压缩 | Web 端 `/ws` 无心跳、无 `perMessageDeflate`；Android 端 DataChannel **双重 Base64 膨胀（+77%）** + 零压缩 + `text_delta` 走 15s HTTP 长轮询 + 运行态额外 **1s 定时轮询** | 将 DataChannel 现有 `dc_push_v1` 升级为**直接推送流式帧**（`dc_stream_v1`），改用二进制帧 + 压缩，彻底消除运行态轮询 |
| **首屏与冷启动** | App/Web 秒开本地 SQLite / IndexedDB 缓存，0ms 展示对话列表与最近会话，后台静默增量同步 | **Web 端**：101 个 HTTP/1.1 未压缩请求（4.65 MB）+ 同步加载 3.57 MB `lute.min.js` **两遍** = **~8.5 MB**，无 IndexedDB，`sw.js` 每次还主动清缓存<br>**Android 端**：虽有 Room 13 张表，但建连后 3 处重复触发 `refreshSessions()`，强刷 `models?refresh=1`，Timeline 工具步骤未持久化，缩略图每次下载 8 MB 原图用完即删 | 对标 **Local-First（本地优先）+ SWR（先显旧数据再静默刷新）**，把冷启网络请求从“阻塞首屏主路径”降级为“后台增量补齐” |
| **流式观感与交互** | 乐观上屏 + 思考呼吸微动效 + rAF 平滑吐字 + 块级增量 Markdown + 永不锁死输入框 | **Web 端存在架构旁路**：实时流绕过已实现的 `realtime-render.js` 增量引擎，每帧（60–120fps）全量重跑 `marked.parse()` 并 `replaceChildren` 销毁整棵 DOM（$O(N^2)$ 卡顿）；发消息锁死输入框 `readOnly` 长达 20s；切换会话 3.5s 后假死无提示 | 修通 Web 增量流式渲染 + 引入自适应平滑吐字队列 + 解除输入框发送锁定 + 细进度条与骨架屏 |
| **切后台与弱网恢复** | 云端持续托管生成，切后台**不强行常驻长连接**（语音通话除外），靠高优推送提醒 + 回前台 200ms 游标续传 | 切后台无聊天/任务态 Foreground Service，Android 14+ Cached Apps Freezer / 国产 ROM 10–30s 即冻结进程；回前台要等 **4s `dc_ping` 超时**才重走 8 跳重建；Wi-Fi↔5G 直接销毁连接重建；FCM 收到推送不预热也不更新本地摘要 | 采用**四层分级保活 + FCM 富摘要落库 + 回前台 Happy Eyeballs 竞速恢复 + ICE Restart**，做到“短切不断、长切不丢、回前台秒续” |

### 1.2 核心设计原则
1. **本地优先（Local-First）**：所有已看过的数据（会话列表、最近会话全文、工具步骤投影、模型目录、缩略图、草稿）必须落盘持久化；冷启动与页面切换永远优先 0ms 渲染本地状态，网络只做异步增量校对。
2. **单通道直推（Push-First Streaming）**：有推送通道时（Web `/ws`、Android DataChannel `dc_push_v1`），增量内容直接沿推进通道下行，禁止“推送通知失效 → 再发 HTTP 拉取”的二跳放大。
3. **非阻塞交互（Non-Blocking UX）**：发送不锁输入框、切换不卡白屏、流式输出不卡主线程、断网允许浏览与起草。
4. **按需分级保活（Lifecycle-Aware Keep-Alive）**：不与系统省电机制硬对抗，而是区分“空闲后台”与“活跃任务后台”，在合规前提下最大化短切不断连与长切秒恢复。

---

## 二、连接速度优化（建连、路由与切网）

### 2.1 现状核心瓶颈（代码定位）

1. **8 跳串行 Rendezvous 建连瀑布**（无公网端点桌面端默认路径）：
   - `AccountSessionManager.rendezvous()`（`android/core/auth/src/main/kotlin/com/andysagent/ragent/core/auth/AccountSessionManager.kt:589-760`）与 `pollOwnerAccountRendezvous()`（`lib/owner-account-auth.mjs:1849-1994`）之间串行经过：
     `ensureActiveCredential()` → `POST /v1/owner-auth/rendezvous` → `POST /v1/owner-auth/account-intents/:id/authorize` → 唤醒桌面长轮询 → `POST .../complete` → `POST /v1/owner-auth/turn/connections/reserve` → `POST <TURN_BROKER>/v1/turn/credentials` → 拉起 Go Sidecar & `/signal` WS → `POST /v1/owner-auth/rendezvous/:id/complete` → 唤醒移动端等待器。
   - **跨进程唤醒抖动**：`createRendezvousInboxWait`（`accounts/rendezvous-inbox-wait.mjs:33`）与 `getAccountRendezvousResult`（`accounts/owner-auth-broker.mjs:2546`）跨进程依赖 `RENDEZVOUS_RESULT_CHECKPOINT_MS = 2_000` ms（`accounts/rendezvous-result-waiters.mjs:2`）的 DB 重读检查点；不支持长等待的旧路径更会退化为桌面 `4s ± 15%` 轮询（`lib/owner-auth-rendezvous-schedule.mjs:14`）与手机 `5s` 轮询（`AccountSessionManager.kt:63`）。
2. **Go Sidecar 闲置冷启惩罚**：
   - `DEFAULT_ON_DEMAND_IDLE_TIMEOUT_MS = 180s`（`lib/p2p-host-agent.mjs:25,262-272`）在无打开 DataChannel 后退出 Go 子进程。
   - 下次移动端发来 SDP Offer 时，`p2p-host-agent.mjs:749-758` 才同步触发 `resolveIceServers()`、创建 loopback HTTP 代理并 `spawn` Go 进程，阻塞 SDP Answer 生成；且每收到一条信令消息，`p2p-host-agent.mjs:704-727` 都会计算最多 7 种 debug HMAC-SHA256 变体并打日志。
3. **Wi-Fi ↔ 5G 切网直接销毁重连，无 ICE Restart**：
   - `ConnectivitySupervisor.onDefaultNetworkChanged()`（`android/core/network/src/main/kotlin/com/andysagent/ragent/core/network/ConnectivitySupervisor.kt:224-239`）在默认网络切换时直接关闭现有 P2P/TURN 会话，状态跌回 `Degraded`，并以 `coalesceInFlight = false` 触发整套全新 Rendezvous + 新建 `PeerConnection`（`android/app/src/main/java/com/andysagent/ragent/BoundTargetConnection.kt:159-175`）。
4. **Android `OkHttpClient` 碎片化，无法共享连接池与 TLS 复用**：
   - `OkHttpRagentTransport.defaultClient()`（`OkHttpRagentTransport.kt:782-787`）为匿名 Accounts、认证 Accounts 及每个 `TargetRuntime` 各自新建客户端（`RagentApplication.kt:961,1037,2753`）；
   - `ConnectionBootstrapClient.defaultClient()`（`ConnectionBootstrap.kt:121-125`）、`AccountAttachmentRelay`（`AccountAttachmentRelay.kt:36-37`）、`LocalRuntime.localHttpClient()`（`LocalRuntime.kt:44-48`）、`ContentReportTransport`（`ContentReportTransport.kt:20-37`）以及**每次 WebRTC 会话新建的 `P2PSignalingClient`**（`P2PSignalingClient.kt:72-74`）均使用独立 `OkHttpClient`；`AvatarImageCache`（`GoogleAccountCard.kt:180-194`）甚至直接用 `HttpURLConnection`。
   - 后果：同一台 Accounts / Signaling 服务器无法复用 HTTP/2 多路复用连接池、Dispatcher 线程池与 TLS Session Ticket。
5. **直连模式多 1 次串行公钥 RTT**：
   - `ConnectionBootstrapClient.fetch()`（`ConnectionBootstrap.kt:43-51`）每次无条件先请求 `GET /api/device-auth/bootstrap/public-key`，再请求 `GET /api/device-auth/bootstrap`。

### 2.2 具体优化方案

1. **压缩 Rendezvous 握手链路（8 跳 → 3~4 跳）**：
   - **合并 `create` + `authorize`**：已核验 `authorizeAccountJoinIntent`（`accounts/owner-auth-broker.mjs:2564-2657`）所需的全部鉴权、防重放与审计要素（`rac_`、`deviceId`、`nonce`、`issuedAt`、`deviceSignature` 等）在移动端发起 `createAccountRendezvous` 时均已具备。对已绑定账号/工作区可安全提供原子 `create + authorize` 路径（保留两阶段接口供 QR 扫码配对使用），直接砍掉 1 个串行 RTT 与 1 次全表 `store.mutate`。
   - **Accounts PG 并发控制两步安全演进（严禁直接拆锁）**：`accounts/store/postgres.mjs:1196-L1224` 的 `mutate()` 每次都在事务内执行**全库快照读（`readSnapshot`）+ 全库快照覆写（`writeSnapshot`）**，全局 `pg_advisory_xact_lock` 与单进程 `queue` 正是为了防止并发写入互相覆盖丢失数据。因此：**严禁在 `mutate()` 全表覆写移除前拆分全局锁**！须分两步演进：
     - **Step A**：开启 `accounts/server.mjs:483-488` 已实现但默认关闭的行级局部事务环境变量 `RAGENT_ACCOUNTS_SCOPED_RENDEZVOUS_RESULT=1` 与 `RAGENT_ACCOUNTS_SCOPED_RENDEZVOUS_CREATION=1`（对应 `mutateRendezvousResult` / `mutateRendezvousCreation`，`postgres.mjs:1229-1310`），并为 `authorizeAccountJoinIntent` 补齐局部事务路径；
     - **Step B**：将剩余全表 `mutate()` 调用方全部迁出后，再拆除全局 `queue` 并改为行级 `SELECT ... FOR UPDATE` / 按 `accountId` 细粒度加锁；同时放宽 `accounts/rendezvous-result-waiters.mjs:18-20` 硬编码的 `ceiling = 128` 断言（与 `accounts/rendezvous-inbox-wait.mjs:8-10` 同步扩展至 2048+），消除高并发 HTTP 429。
   - **Accounts 跨进程实时通知**：用 PostgreSQL `LISTEN/NOTIFY`（或轻量内存/Redis Pub/Sub）取代 `RENDEZVOUS_RESULT_CHECKPOINT_MS = 2000ms` 轮询检查点，消除每次等待平均 1~2s 的空转延迟。
   - **桌面端 TURN 凭证与租约预热池**：TURN 租约有效期 30 分钟（`chat/connection-bootstrap-service.mjs:132`），Signed Bootstrap Contract 有效期 10 分钟（`lib/connection-bootstrap-contract.mjs:10`）。桌面端应在后台维护与主设备绑定的有效 TURN 租约/凭证缓存（到期前提前续期），收到 Rendezvous 唤醒时 **0ms 直接签发 v2 合约**，不再临时串行请求 Accounts `/turn/connections/reserve` 与外部 TURN Broker。
   - **清理热路径冗余开销**：移除 `p2p-host-agent.mjs:704-727` 每次信令到达时的 7 重 debug HMAC 计算（仅在 `!verified` 时按需诊断）；延长主绑定设备 Go Sidecar 空闲保活时间（或允许常驻极轻量的热待机进程），消除冷启 `spawn` 延迟。
2. **Android 全局共享单例 `OkHttpClient` + 启动连接预热**：
   - 在 `AndroidRuntimeGraph` 构建唯一共享的 `baseOkHttpClient`（配置统一 `ConnectionPool`、合理空闲连接数与 TLS Session Cache），`Accounts`、`Bootstrap`、`P2PSignalingClient`、`LocalRuntime`、`AttachmentRelay` 及 `AvatarImageCache` 全部通过 `baseOkHttpClient.newBuilder()` 派生差异化超时，**全面复用 HTTP/2 连接与 TLS 0-RTT/会话恢复**。
   - App 启动瞬间异步预解析/预建连 Accounts 与 `P2P_SIGNALING_URL` 域名，把 TLS 握手与用户本地 UI 加载并行隐藏掉。
3. **支持 WebRTC ICE Restart 四层协同改造 + 有效合约复用**：
   - 当默认网络切换（Wi-Fi ↔ 5G）或短时断网恢复时，若当前已签名的 Bootstrap 合约/TURN 凭证距离过期仍大于 60s，优先在现有 `PeerConnection` 上触发原位 **ICE Restart**（复用既有信令房间与已认证会话态），2~2.5s 未收敛再降级重走 Rendezvous。必须同步打通以下 4 层硬阻塞：
     1. **Android 切网层**（`android/core/network/src/main/kotlin/com/andysagent/ragent/core/network/ConnectivitySupervisor.kt:224-239`）：在合约剩余 >60s 时不立即销毁会话，改为触发原位 ICE Restart（保留 `closeP2PSession` 作为超时兜底）。
     2. **Android 信令层**（`android/core/p2p/src/main/kotlin/com/andysagent/ragent/core/p2p/P2PSignalingClient.kt:58`）：新增 `reconnectNow()` 以 0ms 退避立即重连信令 WS。
     3. **Android WebRTC 层**（`android/core/p2p/src/main/kotlin/com/andysagent/ragent/core/p2p/P2PDataChannelTransport.kt:794-824`）：第 797 行写死了 `if (remoteDescriptionSet || remoteDescriptionSetting) return`，会静默丢弃二次 SDP Answer；需新增 `awaitingIceRestartAnswer` 状态放行重协商 Answer。
     4. **Desktop Node + Go 层**（`lib/p2p-host-agent.mjs:733-765` + `p2p/cmd/ragent-p2p-host/main.go:1080-1110`）：使用独立信令消息 `type: "ice_restart_offer"`；Node 侧校验 `handoffId` 但**不执行 `clearInvalidationPush()` / 清零通道计数**；Go 侧在 `peer != nil && peer.ConnectionState() != webrtc.PeerConnectionStateClosed` 时直接对现有 `peer` 执行 `SetRemoteDescription` → `CreateAnswer` → `SetLocalDescription` 保留 SCTP/DataChannel（若 Go 子进程已退出或原位失败，明确回退走标准 `offer` 重建）。
4. **同局域网直连（LAN）优化与直连公钥缓存**：
   - 保持对 Owner 受信任设备开启 `ICETransportPolicyAll`（`chat/connection-bootstrap-service.mjs:271-279`），并确保 host 局域网候选在本地 SDP 阶段立即 Trickle，不被慢速 TURN Allocate 阻塞；在诊断面板统计 `P2P` vs `Turn` 命中率。
   - 按 `instanceId + keyId` 在本地持久化缓存实例公钥，仅当验签失败或服务器响应携带新 `keyId` 时才拉取 `/api/device-auth/bootstrap/public-key`，省去直连引导的 1 个完整 RTT。

---

## 三、拉取（Pull）、推送（Push）、接收（Receive）全链路优化

### 3.1 现状核心瓶颈（代码定位）

1. **全链路零网络压缩 + DataChannel 双重 Base64 膨胀（+77% 流量）**：
   - `chat-server.mjs` HTTP 响应与静态资源完全没有 `Content-Encoding`（`gzip`/`br`）；`/ws` 的 `WebSocketServer`（`chat/ws.mjs:94`）未启用 `perMessageDeflate`；`tunnel/` 与 DataChannel 也全无压缩。
   - **Go Sidecar 双重 Base64 放大**：`proxyRequestBody()`（`p2p/cmd/ragent-p2p-host/main.go:691`）先将本地 HTTP 响应体 Base64 编码进 JSON（+33%）；当总 JSON 超过 48 KiB 时，`responseFrames()`（`p2p/cmd/ragent-p2p-host/response_stream.go:86-110`）再将这整段 JSON **第二次 Base64 编码**进 `http_response_stream_v1` 24 KiB 分块（综合膨胀 ~77%）。
   - **Store-and-Forward 缓冲延迟**：`proxyRequestBody()`（`main.go:680-684`）使用 `io.ReadAll` 将整个本地 HTTP 响应（上限 8 MiB）完整读入内存后，才发出第一帧 DataChannel 数据，且中间多跳了一次 Node loopback HTTP 代理（`lib/p2p-host-agent.mjs:274-373`）。
2. **吞吐窗口过小与 10ms 轮询背压**：
   - Go 侧（`response_stream.go:22,60-70`：`maxBulkBufferedBytes = 64 KiB`、`time.Sleep(10ms)`）与 Android 侧（`P2PDataChannelTransport.kt:1305-1333`：`highWaterBytes = 64 KiB`、`delay(10)`）均采用 `10ms` 轮询 `bufferedAmount()`。在 100ms RTT 的 TURN 链路上，64 KiB 窗口把理论峰值吞吐死锁在 **~640 KB/s**。
   - 经 verified carrier 下载附件时，`AssetDownload.kt:39-96` 使用严格**串行的 128 KiB HTTP `Range` 请求**，每 128 KiB 必须等待 1 个完整 RTT。
3. **Android 运行态“三循环并发打架”**：
   - 会话运行期间，`RoomSessionRepository.kt:536-618` 同时驱动 3 个循环：
     1. 15s `liveOnly=1` 长轮询（`ragent-http-bg`）；
     2. **每秒 1 次** `refreshCanonicalRunActivity`（`GET /api/sessions/:id/events?filter=visible&limit=1`）；
     3. `reconcileDurableSessionUntilSettled`（每 ≥1s 刷一次会话详情 + 耐久 `/events/wait`）。
4. **服务端热路径 7 大性能与锁瓶颈**：
   - **SQLite Auth 无缓存重复查询**：`handleRequest`（`chat/router.mjs:1483`）在静态文件分支（`:1537`）之前就同步查询 `node:sqlite`（`lib/auth-session-store.mjs:72`，每次现 `db.prepare` + `JSON.parse`），且单次 API 请求中 `getAuthSession(req)` / `isAuthenticated(req)` 未记忆化，被重复调用 **6~8 次**（`router.mjs:1483,1700,1703,1765,1776,1797,1832,2260`、`middleware.mjs:110,117`）。
   - **`ensureProjectsInitialized()` 无 memoize 全局串行锁**：每次 `listSessions()`（`session-manager.mjs:10495`）、`getSession()`（`:10564`）、`getSessionReadSnapshot()`（`:10606`）、`listProjects()`（`projects.mjs:474`）都无条件进入 `ensureProjectsInitialized()`（`chat/projects.mjs:352-424`），串行锁住全局 `runProjectMutation` + `withSessionsMetaMutation`，并遍历**所有项目**执行 `statOrNull` 与 `fs.realpath`（`chat/workspaces.mjs:194-302`）。
   - **`GET /api/sessions` 无分页全量深拷贝**：`router-session-main-routes.mjs:674-709` 从不传 `limit`，对每个会话执行 `enrichSessionMeta` + `JSON.parse(JSON.stringify(session))`（`chat/session-api-shapes.mjs:5-58`；注释记录真实 `chat-sessions.json` 已达 **1.76 MB**，见 `chat/session-meta-store.mjs:43`）。服务端已有 `?view=summary`（`session-api-shapes.mjs:63-76`），但 Web 端从未使用。
   - **`GET /api/models` 三倍重复执行**：`router-control-routes.mjs:2706-2716` 顺序调用 `getModelsForTool`、`getToolModelCatalog`、`getToolModelCatalogs`，且 `chat/models.mjs:851` 对 `fast === true` 或 `codex` 直接绕过 `toolCatalogCache`，导致每次请求重读密钥与重算目录 **3 次**。
   - **`GET /api/tools` 先扫盘后查缓存**：`lib/tools.mjs:680-696` 先执行 `loadCustomTools` / `loadSharedTools`（目录扫描）与 `await listHarnesses()`，最后到第 694 行才检查 `availableToolsCache`。
   - **运行态时间线二次递归投影 & `/events/delta` 退化**：`getSessionTimelinePage()`（`session-manager.mjs:11110-11118`）在运行态分片拉取时递归再跑一遍全页投影仅为了算 `runActivity`，向后翻页循环存在 $O(\text{pages}^2)$ 重复计算；`GET /api/sessions/:id/events/delta?filter=visible` 硬编码 `const resetRequired = true`（`router-session-main-routes.mjs:1143`），导致每次增量拉取都强迫前端整窗替换。
   - **其他热点与隐蔽 Bug**：`GET /api/agents`（`chat/apps.mjs:118-132`）无缓存读盘、双重深拷贝且每次 GET 触发账号同步；`GET /api/account-policy`（`lib/account-policy.mjs:61-68`）每次读盘；`GET /api/sessions/:id/events/wait` 最长 `30_000ms` 与 `server.requestTimeout = 30000`（`chat-server.mjs:831`）边界竞态；`tunnel-client.mjs:369` / `tunnel-server.mjs:297` 用数组 `.length` 比较 `16 MiB` 字节上限导致背压队列保护失效。

### 3.2 具体优化方案

#### A. 拉取（Pull）优化
1. **DataChannel 响应协议升级为 `AGR2`（“二进制流 + 压缩”，对称于上行 `AGB3`）**：
   - 对称复用上行 `AGB3`（`p2p/cmd/ragent-p2p-host/request_body_stream.go:159-178`）帧头结构新增下行协议 `AGR2`：响应头以小 JSON 帧下发（含状态码、Header、以及 `contentEncoding: "gzip" | "zstd"`），响应体改走**原始二进制分块帧**直接从 Go `resp.Body` 流式透传（取消 `io.ReadAll` 全缓冲与双重 Base64）。对可压缩 JSON（会话列表、时间线历史），单响应体积直降 **80%~88%**。
2. **全端启用标准 HTTP 压缩与 ETag 协商**：
   - 在 `chat/router.mjs` 为静态资源及 JSON API 响应增加 `Accept-Encoding: br, gzip` 支持（静态资源在 `staticAssetCache` 中预存压缩后 Buffer 与预计算 ETag，避免每次请求对 3.74 MB 文件重算 SHA-1 和二次 `stat`）。
   - Web 与 Android 统一为列表接口传入 `?view=summary&limit=50`（并支持 `updatedAfter=<ts>` 增量拉取），仅在进入特定会话时补充详情字段；修复 `GET /api/sessions/:id/events/delta?filter=visible` 返回真实增量事件而非硬编码 `resetRequired = true`。
   - 为 `chat-server.mjs` 将长轮询最大 `timeoutMs` 设为 `25_000ms`（低于 `server.requestTimeout = 30_000ms` 并放宽服务端 `requestTimeout` 到 `60_000ms`），避免长轮询超时与连接被强制掐断产生竞态。
3. **附件与大文件拉取加速**：
   - 复用加密中继架构提供对称的 **E2E 加密中继下载通道**（Desktop 流式 `PUT` 到 Accounts 内存管道 ↔ Android 流式 `GET` 解密），使远程大图/附件下载彻底走高速 HTTPS 流，绕开 WebRTC/TURN 限速。
   - 仍需走 DataChannel 的小文件下载（`AssetDownload.kt`）改为 **4 路并发 `Range` 流水线**（窗口扩大至 256 KiB/片），消除串行 RTT 惩罚。
4. **服务端 5 项高收益重构**：
   - **Auth 缓存与静态放行**：静态文件请求直接跳过 SQLite Auth；API 请求将解析后的 `authSession` 挂在 `req[kAuthSession]` 上实现单请求零重复查询，并对未变更会话叠加 30s 内存 LRU 缓存与预编译 `Statement`。
   - **`ensureProjectsInitialized()` 初始化一次化**：改为启动后只执行一次 + 仅在项目配置写操作/目录变更时局部失效，彻底解放 `listSessions`/`getSession`/`getSessionReadSnapshot` 的全局串行锁与全项目 `fs.realpath`。
   - **修复 `/api/models` 三次重复与 `/api/tools` 缓存顺序**：`/api/models` 合并为单次目录计算并恢复受控 TTL 缓存；`/api/tools` 优先命中内存缓存，后台异步刷新失效条目。
   - **合并 `getSessionTimelinePage` 运行态投影**：在单次扫描中同时产出展示事件与 `runActivity`，消除运行态二次递归和 $O(\text{pages}^2)$ 循环重建。
   - **修复 `tunnel/` 队列字节计数 Bug**：将 `.length` 检查改为累计 `queuedBytes >= STREAM_QUEUE_LIMIT_BYTES` 真实字节数。

#### B. 推送（Push）优化
1. **DataChannel 升级“单通道流式直推”（对标 ChatGPT / Gemini SSE，含防队头阻塞保护）**：
   - 在已协商的 `dc_push_invalidation_v1` 基础上扩展 `dc_stream_v1`（或开启专用低延迟 DataChannel `ragent-stream`），并严格配套防队头阻塞（HOL）护栏：
     - **单聚焦会话订阅 `dc_stream_sub_v1`**：仅对当前正在聚焦查看的活跃会话推流，避免后台多会话并发流冲爆主信道；
     - **16 KiB 单帧上限 + 拥塞合并降级**：复用 Go 侧 `trySendPush` 的 `BufferedAmount() > maxResponseBufferedBytes` 保护（`p2p/cmd/ragent-p2p-host/response_stream.go:122-135`），弱网拥塞时自动将堆积的 `text_delta` 合并降级为 1 条 `session_invalidated { latestSeq }`；
     - 正常状态下，桌面端 `sessionRealtimeLiveFeed`（已具备 30~50ms `text_delta` 合并）将增量文本、`reasoning_delta`、`tool_status`、`run_state` 与 `approval_required` 直接推送到手机端，携带单调 `liveCursor`/`seq`。
   - 收益：**彻底移除运行态的 1s `refreshCanonicalRunActivity` 轮询与 15s `liveOnly=1` 长轮询频繁重建**，首字延迟（TTFT）与流式响应延迟立减 1 个完整 RTT 以上，同时大幅减轻服务端与 TURN 通道控制面拥塞。
2. **Web `/ws` 增加双向轻量心跳、PRoot 路径守卫修复与游标续传**：
   - 服务端 `chat/ws.mjs` 增加 `15~20s` 原生协议层 `ws.ping()` 探活（注意 `chat/ws.mjs:145-149` 会以 `1008` 踢掉任何客户端应用层消息，心跳必须严格使用协议层 `ping/pong` 控制帧），连续 2 次超时未回 `pong` 立即清理半开连接；按需开启带有限阈值的 `perMessageDeflate`（仅压缩 >1 KB 帧）。
   - 修复 `chat/ws.mjs:102` PRoot 路径校验硬编码 `req.url !== '/ws'` 为 `url.pathname !== '/ws'`，以支持 `/ws?sessionId=...&afterSeq=...` 建连游标续传参数，短断线重连后首帧直接补发缺失增量，避免每次重连触发整套 HTTP 刷新瀑布。

#### C. 接收（Receive）与流控优化
1. **事件驱动背压取代 10ms 轮询**：
   - Go Pion 侧使用 `SetBufferedAmountLowThreshold` + `OnBufferedAmountLow` 回调通知发送协程；Android WebRTC 侧使用 `DataChannel.Observer.onBufferedAmountChange` 挂起恢复，彻底消除每 10ms 空转轮询。
   - 将 `ragent-http-bulk` 与响应通道的高水位从 `64 KiB` 提升到 `256 KiB ~ 1 MiB`（依据信道 RTT/丢包自适应，主控通道 `ragent-http` 维持高优先级抢占不变）。
2. **消除冗余后置调和请求**：
   - 修复 `static/chat/realtime.js:1300-1303`：当 WS/DC 推送的 `latestSeq` 与客户端 `projectedLatestSeq` 连续一致时，不再在 900ms 后强制调用 `refreshCurrentSession({ forceFresh: true })` 回源重拉。

---

## 四、初次加载时间优化（Web / Desktop / Android）

### 4.1 Web & Desktop 端现状诊断（代码定位）

1. **百请求未打包、未压缩瀑布**：
   - `templates/chat.html:24-39`（16 个 `<link>`）+ `static/chat/chat.css:1-15`（13 个 2-hop `@import`，且重复引入 `chat-goal-ui.css`、硬编码过时 `?v=20260808` 导致版本号无法更新）= **29 个阻塞 CSS 请求（963 KB）**。
   - `templates/chat.html:878-947` 同步加载 **70 个无 `defer`/`async` 的 `<script>`（3.48 MB）**，包含全量内联多语言的 `i18n.js`（235 KB）以及首屏用不到的 `organization-view.js`（380 KB）、`connector-panel.js`（100 KB）、`decision-sheet.js`（106 KB）等。
   - 全站静态版本指纹 `frontendFingerprint` 取整个 `static/` + `templates/` 最大 `mtimeMs`（`chat/router.mjs:974-1009`），改任意 1 行 CSS/JS 就导致全站 100+ 文件缓存同时雪崩失效。
2. **隐形 3.57 MB × 2 Vditor / Lute 启动税**：
   - `static/chat/markdown-composer-editor.js:785-869,981-984` 在脚本解析期就同步 `new window.Vditor(...)`，动态加载**不带 `?v=` 版本号**的 `lute.min.js`（**3,739,336 B / 3.57 MB**，响应头 `no-cache, max-age=0`）。
   - Vditor `after()` 后，`warmMarkdownWorkerWhenIdle()`（`:55-66`）再启动 `markdown-composer-worker.js:7-8` `importScripts` 加载并编译 `lute.min.js` **第二遍**！冷启动未压缩总流量高达 **~8.5+ MB / 105+ HTTP/1.1 请求**。
3. **字体双下载 Bug（352 KB × 2）**：
   - `templates/chat.html:21` 预加载带版本号的 `InterVariable-latin.woff2?v={{ASSET_VERSION}}`，但 `static/chat/chat-base.css:249` `@font-face` 写的是无版本号 `url('fonts/InterVariable-latin.woff2')`，而 `rewriteCssImportUrls()`（`chat/router.mjs:1114-1142`）不重写 `@font-face` 内的 URL，导致浏览器白下两遍字体。
4. **首屏 API 串行瀑布**：
   - `initApp()`（`static/chat/init.js:760-774`）中 `fetchSessionsList()` 必须串行等 `/api/projects` 返回后才发 `/api/sessions`（`session-http.js:1202-1216`），且 `restoreOwnerSessionSelection()`、WebSocket `connect()`、`loadModelsForCurrentTool()` 全被阻塞在 `/api/tools` + `/api/projects → /api/sessions` 完成之后。
   - `static/chat/device-bar.js:18-38` 回退逻辑会请求后端根本不存在的 `/api/device` 返回 404。
5. **Desktop Electron 包装器空转与误杀**：
   - `desktop/main.cjs:299-355` 对 `http://127.0.0.1:7690/?desktop=manager` 加载整套 8.5 MB 聊天页（Manager 其实根本不用聊天与 Vditor），且主进程每隔 `1800ms` 永远轮询该重页面，只要发生**单次** 1.6s 超时就把已加载 UI 直接切回 `wait.html` 销毁状态。

### 4.2 Web & Desktop 落地优化方案

1. **引入轻量打包构建（如 `esbuild`）+ Gzip/Brotli（兼容现有测试与发版门禁）**：
   - 将 29 个 CSS 合并为 1 个内联/单请求 Core CSS（彻底消灭 13 个 `@import` 与重复引用）；
   - 将 70 个 JS 拆分为 **Core Shell（~150–250 KB gzipped）** 与 **按需动态 `import()` 模块**：`organization-view`、`connector-panel`、`decision-sheet`、`cross-device-panel`、非当前语言 `i18n` 语言包全部懒加载；
   - **测试与门禁兼容边界**：`scripts/verify-runtime-payload.mjs` 与打包产物完全兼容，但 `tests/test-chat-split-frontend-smoke.mjs` 会直接对 18 个 `static/chat/*.js` 源文件执行 `node --check` 并在 `vm` 中加载，`tests/test-chat-loader-versioned-assets.mjs` 会校验 `static/chat.js`。因此必须**保留 `static/chat/*.js` 作为源码真值**，构建期输出带内容 Hash 的产物至独立目录（如 `static/dist/`）并由 `templates/chat.html` 与各平台打包脚本引用，同时在无打包产物的本地开发态保持优雅回退；
   - 改用**按文件内容 Hash 命名**，单个文件改动不影响其余已缓存资源。
2. **Vditor / Lute 彻底懒加载 + 版本化缓存 + Manager 隔离**：
   - 首屏输入区默认使用原生 `<textarea>`（0ms 即可聚焦打字）；仅当用户切换富文本/Markdown 工具栏或首次需要复杂编辑时再异步加载 Vditor + Worker，且强行把 `_lutePath`、`workerUrl` 与主题资源全部加上 `?v={{ASSET_VERSION}}` 走 `immutable` 缓存。
   - `?desktop=manager` 模式使用精简入口模板，彻底跳过 Vditor 与聊天消息渲染脚本加载。
3. **修复字体双下载与 404 回退**：
   - 在 `chat/router.mjs` 中同步重写 CSS `@font-face` 的 `url(...)` 版本号，确保与 `<link rel="preload">` 字节级一致；清理 `device-bar.js` 无效 `/api/device` 探测。
4. **打平首屏 API 瀑布**：
   - 新增聚合端点 `GET /api/bootstrap`（或在 `chat.html` 内联轻量首屏快照：当前用户信息、projects 列表、top-30 summary sessions、tools 概要）；
   - 前端认证通过后**立即并行发起 `/ws` 连接**与数据拉取，不再阻塞等待 `/api/tools` 和 `/api/sessions`；并行发起 `/api/projects` 与 `/api/sessions`。
5. **修复 Desktop 探针策略**：
   - `desktop/main.cjs` 改为探测轻量的 `/healthz`（而非 `/?desktop=manager`），`managerLoaded === true` 后探针降频至 10s，且需**连续 3 次探测失败**才回退 `wait.html`。

### 4.3 Android 端冷启动优化

1. **解除 `MainActivity` 主线程 `lazy` 锁竞争**：
   - `MainActivity.kt:444-456` 在 `setContent` 内直接访问 `app.runtime.configStore`，若后台线程 `"RagentRuntimeInit"`（`RagentApplication.kt:122-145`）仍在构建 `AndroidRuntimeGraph`，主线程会被 Kotlin `synchronized lazy` 锁住卡顿首帧。
   - **改造**：将首帧渲染必需的轻量依赖（`ClientConfigStore`、主题/语言、只读 `RagentDatabase`）与重型网络/WebRTC 图拆分解耦，确保首帧 0 阻塞绘制，网络模块随后异步挂载。
2. **消除建连后元数据请求风暴与无效探测 RTT**：
   - 将 `AppShellViewModel`（`WorkbenchViewModel.kt:430-450`）、`ChatViewModel`（`:960-989`）、`RoomSessionRepository.startLiveSync()`（`RoomSessionRepository.kt:415-431`）三处重复调用的 `refreshSessions()` 收口为单一连接就绪协调器，单次建连只发 1 次增量会话刷新。
   - 移除冷启动/每次建连时 `GET /api/models?tool=...&provider=...&refresh=1` 中的 **`refresh=1`**（`RoomSessionRepository.kt:3671-3684,3726-3766`），改用本地缓存 + 服务端默认缓存目录，仅在用户手动点击刷新模型列表时传 `refresh=1`。
   - 缓存 `readDedicatedLivePage(sessionId, probe = true)` 的能力探测结果（`RoomSessionRepository.kt:531-535` 按 `targetId + buildVersion` 记忆化），避免每次进会话浪费 1 RTT（Phase 2 由 `dc_stream_v1` 彻底替代）。
3. **Android 进会话 Markdown 两阶段首屏预热（守住防滚动跳变不变量）**：
   - `WorkbenchScreen.kt:2180-2200` 当前在进会话时同步对**全量** `turnGroups` 执行 `prepareMarkdownDocuments()`（以防止用户上滑时未解析历史轮次突然膨胀导致高度跳变），会阻塞 `readingReveal = 1f` 数百毫秒；且 `AgentMarkdown.kt:346` 缓存未命中时会回退到主线程同步 `parseBlocksFast(source)`。
   - **改造**：改为**两阶段预热**——第一阶段仅同步准备首屏锚点窗口（`restorationTarget ± 2` 轮）并触发 `withFrameNanos {}` 立即放行首屏可见（16~32ms）；第二阶段紧接着在后台 `Dispatchers.Default` 按距锚点由近及远的扩散顺序预热其余历史轮次写入 `markdownBlockCache`，既消除了进会话黑等，又守住用户上滑手势不跳高度的不变量。

---

## 五、前端观感优化（Web + Android，对标 ChatGPT / Gemini）

> **核心目标**：让用户在等待网络或流式输出时，感受不到“卡、顿、等、跳、死”，始终觉得界面跟手、轻盈、可预期。

1. **【P0 必修】打通 Web 实时流式增量渲染（解决掉帧、卡顿与无法选中文字）**：
   - **问题根因**：`static/chat/realtime-render.js:267-690` 已写好 rAF 节流（33ms）+ 块级增量拆分 + `deferEnhance: true`，但实时 `/ws` `session_events` 经 `realtime.js:1310-1354` → `RagentTimelineRuntime.renderIncremental()`（`timeline-runtime.js:456-564,867-910`）**完全绕过了它**，在 60–120fps 下每帧都对 0..N 全文跑完整 `marked.parse()` + 数学公式 + 代码高亮 + 表格增强（$O(N^2)$ CPU），并用 `target.replaceChildren(...)` 销毁整棵 DOM（导致无法划词选中、长回答严重掉帧）。
   - **改造**：
     - 对 `completed !== true` 的活跃消息强制传 `deferEnhance: true`，节流在 33ms；
     - 仅对**末尾未闭合的活跃 Markdown 块**更新文本/局部节点，已闭合的历史段落与代码块 DOM 节点彻底冻结复用；仅在收到 `completed === true` 时运行一次代码高亮与表格增强。
2. **流式渲染平滑吐字与 Android 真实卡顿修复（对标 ChatGPT / Gemini）**：
   - **Web 端（Adaptive Smooth Reveal）**：网络分包受 TCP/WebRTC 聚合影响常呈“一坨一坨”突发到达。复用 `pumpStreamingAnimation` 在 Web 端引入轻量字符/词元缓冲队列：以 60fps 在 ~150ms 窗口内匀速吐出刚到达的文本；队列积压超阈值时自动加速追平，兼顾丝滑视觉与零延迟积压。
   - **Android 端（修复 3 处主线程 $O(N^2)$ / `BreakIterator` 真实 Bug）**：Android `AgentStreamingMessage` 已内置基于 `withFrameNanos` + EMA 的平滑吐字，但存在 3 处隐藏主线程卡顿必须修复：
     1. `AgentUiComponents.kt:634` 对累积 `text` 每 delta 重跑全量 `streamingGraphemeRanges(text)`（$O(N^2)$ `BreakIterator`），需改为增量追加切片缓存（仅扫描新增后缀并检查边界 join）；
     2. `AgentMarkdown.kt:380-416,463` 的 `latestGraphemeRange()` / `tintLatestGrapheme()` 每帧全量扫描整篇文本，需改为 `BreakIterator.last()` + `previous()` 反向探测降为 $O(1)$；
     3. `AgentMarkdown.kt:336-369` 流式阶段对已闭合的历史 Markdown 前缀块未冻结复用，需拆分冻结前缀块与活跃尾块，避免长回复每 token 触发全表重构。
3. **输入与发送零阻塞（乐观交互）**：
   - **Web 端**：取消 `syncComposerPendingUi()`（`compose.js:931-935`）在发送期把 `msgInput.readOnly` 设为 `true` 长达 20s 的锁定。点击发送后 0ms 清空输入框、上屏乐观气泡并紧接柔和的“思考/连接中”微脉冲（Shimmer）占位，输入框**立即恢复可用**允许用户继续起草下一句（仅防重复提交同一消息）。
   - **Android 端**：断网或重连期间允许正常进入已缓存会话并发送消息，立刻乐观写入消息流（附带轻量“待发送”状态点）并入库 `pending_operations`，连接恢复后静默投递并平滑消去状态点。
4. **会话切换与首次进入永不“假死”**：
   - **消除 3.5s~30s 切换黑洞**：`realtime-render.js:926-934` 在 3.5s 后移除了模糊态，而 HTTP 超时是 30s（`session-http-helpers.js:687-690`），导致中间二十多秒旧会话原封不动卡在屏幕上像按钮失效。应改为：切换瞬间优先从内存/IndexedDB 0ms 渲染目标会话缓存，无缓存时展示结构化**气泡骨架屏（Skeleton）**，并在顶部渲染极细的**流光进度条**直至请求落定（或显式提供可重试提示）。
   - **停止首次进会话强行连拉多页历史并重跳滚动**：`session-http.js:2454-2474` 在首屏 50 条渲染完后继续串行自动追拉老页并重刷 `scrollToBottom`。改为首批可见消息到位即结束加载、锁定滚动位置，仅在用户主动向上滑动接近顶部时才预取更早历史页。
5. **消灭侧边栏重排掉帧与滚动跳动**：
   - Web 侧边栏 `renderSessionList()`（`session-list-ui.js:82-282`）停止每次 `innerHTML = ""` + 对每行读 `getBoundingClientRect()` 强制同步回流（`:158`）；改为按 `data-session-id` 原地最小化 Patch 文本/状态徽章，仅当会话顺序实际发生变化时执行局部位移过渡，并将全部入口统一收口至 `scheduleSessionListRender()`。
   - 图片、工具卡片与折叠代码区预先声明稳定占位尺寸/高宽比，防止异步加载把正在阅读的位置顶飞；流式输出时用户一旦上滑即立即解除自动粘底，底部浮现柔和的“↓ 回到底部”胶囊按钮。
6. **克制而诚实的弱网/重连反馈**：
   - 修复 Web 端 `offline` 事件不展示提示（`realtime.js:308-322,1506-1510`）以及 `online` 事件不重置 `reconnectAttempt = 0` 导致傻等 30s 退避（`:286-306`）的 Bug：断网即刻显示轻量顶部胶囊（“网络已断开 · 支持浏览与起草”），联网瞬间 `attempt` 归零秒连，重连成功后短暂提示“已恢复连接”后淡出，不遮挡阅读区。

---

## 六、Android App 缓存体系专项优化（含 Web 端持久缓存补齐）

Android 端已构建了很好的持久化地基——分目标 Room 数据库（13 张表，含 `sync_cursors`、`pending_operations`、`session_events` 历史表，见 `RagentDatabase.kt:10-28`、`Entities.kt:6-181`）、DataStore `chat_runtime_cache_v1`（`ClientConfigStore.kt:145-187`）与 `OrganizationOfflineCache`（`OrganizationOfflineCache.kt:11-66`），但存在 **5 个高影响缓存黑洞**：

| 缓存黑洞 | 现状问题与代码定位 | 优化落地建议 |
| :--- | :--- | :--- |
| **1. 图片/附件无持久化磁盘缓存（最高优）** | `TimelineAttachmentHost.kt:207-222` 加载缩略图时，竟通过 128 KiB WebRTC Range 下载**整张 8 MB 原图**到临时文件，解码完在 `finally` 里**直接删除**！点开大图时又用随机 `UUID` 下载到 `cacheDir/shared/timeline/<UUID>-...`（`:135-138`），从不复用已有文件；32 张内存 `LruCache` 还在离开会话时 `onDispose` 清空（`:80-81`）。 | ① **四平台零依赖 Go 缩略图服务**：Node 侧无图像库（`chat/session-attachments.mjs:114-133` 仅调 macOS `sips`），无需引入 `sharp` 原生 addon，直接复用全平台随包编译交付的 Go 二进制（`p2p/cmd/ragent-p2p-host`）内置 `image/jpeg` + `image/png` + `golang.org/x/image/draw` 提供 `/api/assets/:id/thumbnail?w=480` 并落盘缓存（端到端流量 **8 MB → ~30 KB**）；<br>② **Android 持久化内容寻址缓存**：接入全局 `DiskLruCache` / Coil `ImageLoader`（按 `assetId + sha256 + variant` 索引，设 200~300 MB LRU 上限），内存缓存提升至 Application 作用域；点开大图若本地已有原图则 0ms 瞬开。 |
| **2. 富时间线步骤仅存内存（冷启画面不一致）** | `visibleTimelineEvents`、`durableToolFacts`、`runActivityState` 仅存在 `RoomSessionRepository` 的 `ConcurrentHashMap`（`RoomSessionRepository.kt:301-355`）。杀进程后再次打开会话，只能看到纯文本消息，等连上电脑拉完数据后工具卡片才突然“蹦出来”，造成剧烈布局跳变。 | 在 Room 新增轻量级 `timeline_projections` 表（缓存最近 20 个活跃会话各最新 50 条渲染投影 JSON/Protobuf），冷启进入会话 0ms 完整还原与离线前一致的富卡片视图。 |
| **3. 零 OkHttp HTTP 缓存与 ETag 断链** | 服务端 `writeJsonCached`（`chat/router.mjs:1262-1276`）早已为 `/api/sessions`、`/api/projects`、`/api/tools`、`/api/models`、`/api/home` 返回强 SHA-1 `ETag`，但 Android OkHttp 从未配置 `okhttp3.Cache`，DataChannel/HTTP 请求也从未发送 `If-None-Match`；每次建连全量重抓全表替换 Room。 | ① 为标准 REST 客户端配置 50 MB `okhttp3.Cache`；<br>② 在 `OkHttpRagentTransport`（含 DataChannel 头透传）与 Room 元数据层记录资源 `etag`，请求带 `If-None-Match`，命中 `304 Not Modified` 直接跳过反序列化与 Room 全表覆盖写；<br>③ 持久化 `tools` / `providers` / `models` / `harnesses` 目录。 |
| **4. 草稿、Step Trace 与变更文件仅存内存** | `sessionDrafts`、`cachedStepTraces`、`cachedChangedFiles`（`WorkbenchViewModel.kt:864-876`）全在 ViewModel 内存，切后台被系统回收后用户输入一半的长提示词直接丢失。 | `sessionDrafts`（含待发附件引用）按 `targetId + sessionId` 防抖持久化至 Room/DataStore；按需缓存最近查看的变更摘要与 step trace（带 LRU 上限）。 |
| **5. Web 端完全缺失持久缓存（同步补齐）** | Web 端无任何 IndexedDB；`static/sw.js:7-26` 甚至禁用 `navigationPreload` 并在 `install`/`activate` 及每次页面加载时主动清空全部 Cache Storage；`createBoundedClientCache`（`bootstrap.js:1565`）每次读写还同步 `JSON.stringify` 估算字节大小。 | ① Web 端引入轻量 IndexedDB 存储最近会话列表、Home 视图与最近 5~10 个会话快照（按 `principalId`/`targetId` 隔离，登出或 401 自动清空），实现刷新秒开 SWR；<br>② `sw.js` 改为“带 Hash 静态资源 Cache-First + HTML/API 走网络/SWR”，不再自毁缓存；移除 `createBoundedClientCache` 同步 `JSON.stringify` 算字节开销。 |

---

## 七、增强 Android 应用切后台保持连接与恢复效果

### 7.1 现实约束与行业最佳实践（ChatGPT / Gemini 策略对照）

在 Android 14/15/16 上，**Cached Apps Freezer（后台缓存进程冻结）**、**Doze 模式**以及国产 ROM（MIUI / ColorOS / OriginOS / HarmonyOS）的后台限制会在 App 退后台 **10~30 秒**后直接冻结进程、暂停所有协程与定时器并回收网络套接字。

因此 ChatGPT / Gemini 采取的均是**合规分层策略**，而非“无条件常驻前台服务死撑长连接”（后者会显著增加耗电并触犯 Google Play 前台服务审查）：
- **空闲/无进行中任务切后台**：主动放行系统休眠，依靠高优 FCM 推送触达，回前台后靠本地缓存 + 游标在数百毫秒内完成续传；
- **进行中任务/语音/文件传输切后台**：按需拉起明确、可见、带实时进度通知的合规 Foreground Service，任务结束立刻退场。

### 7.2 Ragent 当前切后台行为审计（代码定位）

- `android/app/build.gradle.kts:104-111` 已设定 `targetSdk = 36`，`AndroidManifest.xml:7-111` 未声明 `FOREGROUND_SERVICE_DATA_SYNC`，且 `BackgroundDeliveryForegroundService`（`dataSync`）在 API 34+ 已明确禁用——因此在 Android 15/16 上**严禁为聊天/会话长连接强行启用 `dataSync` 或 `connectedDevice` 前台服务**（会触发 6 小时运行时长崩溃上限及 Google Play 拒审）。
- `RagentApplication.onStop()`（`RagentApplication.kt:2546-2612`）虽然通过 `connectionUses.setOwnerTargets("foreground-ui", ...)` 保留主设备租约并启动最长 **2 分钟**的 `backgroundSyncJob`（每 5s 轮询一次有活跃运行的会话），但一旦系统冻结进程，3s `dc_ping` 心跳挂起，TURN/Signaling 套接字静默失效；回到前台时，`verifyForegroundCarrier()`（`ConnectivitySupervisor.kt:318-387`）发现状态仍为 `Connected`，会先苦等 `dc_ping` **2.5s + 1.5s = 4 秒**超时期满，然后才判定断连并重走 **8 跳 Rendezvous + WebRTC**，导致用户回到 App 后黑等 **6~10 秒**才能发消息或看流式进展。
- `RagentFirebaseMessagingService.onMessageReceived()`（`RagentFirebaseMessagingService.kt:36-57`）收到 FCM 推送后只弹本地通知，**既不把最新状态摘要写入 Room，也不在点击通知时提前预热连接**。

### 7.3 `targetSdk = 36` 合规四级“分级保活 + 秒级续接”架构方案

1. **第一层：短切 `shortService` + 传输 UIDT + 后台心跳降频（严格合规，不碰 `dataSync` 红线）**
   - **短切保活（`FOREGROUND_SERVICE_TYPE_SHORT_SERVICE`）**：仅当存在正在运行的 Agent 任务或待确认审批且用户切到后台时，拉起 `shortService`（Android 14+ 专设，最长 3 分钟且无需额外 Play 敏感权限审批）并展示动态进度通知，保住“切出去查资料/回微信再切回来”的不断连窗口；所有任务结束或临近 3 分钟上限前平滑退场释放 `stopSelf()`。
   - **大文件后台传输（UIDT）**：沿用现有 API 34+ 合规的 `User-Initiated Data Transfer`（`BackgroundDeliveryJobService`）承载后台上传/下载任务。
   - **后台心跳智能降频**：进入后台期间，将 `CARRIER_HEALTH_INTERVAL_MS` 从前台的 **3s** 动态放宽至 **15~20s**（稳住运营商 4G/5G NAT 映射 30~60s 的存活窗口），大幅降低唤醒功耗与系统省电判定异常风险。
2. **第二层：FCM 零知识 E2E 加密富摘要落库（支持多设备扇出）+ 通知点击并行预热**
   - **架构约束核验**：`accounts/push-service.mjs:402-408` 是 **1 对多扇出**模型（桌面发 1 条事件，Accounts 扇出投递到该账号下全部已订阅 Android 设备）；且 `accounts/temporary-pairing-cipher.mjs:13` 仅是服务端静态加密而非 E2E，不可套用。
   - **推荐方案 A（`ragent-push-event-v2` + 实例级对称 `pushContentKey`）**：桌面端生成并持久化 32 字节 AES-256-GCM `pushContentKey`（带单调 `pushKeyId`），在设备认证建连后直接通过 P2P/HTTP 下发给每台已授权 Android 设备（**全程不经过 Accounts**）；发推送时桌面端用 `pushContentKey` 加密紧凑摘要 `sealedSummary`（AAD 绑定 `instanceId|eventId|sessionId|kind`，密文 ≤ 1.5 KiB），Accounts 原样透传扇出至所有活跃设备，Android 验签解密后直接写入 Room 摘要字段；撤销某设备信任时轮换 `pushKeyId` 即可前向隔离。
   - **零隐私风险保底（方案 B）**：若短期未引入密钥分发，则严禁在 FCM 携带正文/审批明文，仅附带无隐私风险的 `latestSeq` / `runState`，并在点击通知触发 `PendingIntent` 的第一时间并行调用 `prewarmPrimaryTarget()` 提前唤醒桌面与 ICE 探测。
3. **第三层：回前台 Happy Eyeballs 竞速恢复（把 6~10s 等待压至 ~1s）**
   - 改造 `verifyForegroundCarrier()`（`ConnectivitySupervisor.kt:318-387`）：
     - 回到前台若距上次收包 `> 1_500ms`，立刻发 `dc_ping`；
     - **600~800ms 内未收到 `dc_pong`**，不再死等 4 秒超时，直接判定连接“疑似已被系统冻结”，**并行发起**恢复竞速（若合约仍有效则先发 ICE Restart；若已过期或超时则并行启动 Rendezvous），哪条链路先联通就立刻切入使用并取消另一条。
   - 配合第二章的四层 **ICE Restart**，10 分钟内短切后台即使被系统冻结断 socket，回到前台亦可跳过 Accounts 8 跳协商，在 **0.5~1.5s** 内无缝恢复。
4. **第四层：面向高频用户的分渠道电源豁免引导**
   - 在设置中新增开关 **“增强后台连接保持”**，向用户清晰说明效果与耗电权衡：
     - **Google Play 分发版本**：严格遵守 Play 政策不乱申请敏感权限，提供一键跳转至系统“应用电池用量（设为无限制）”与国产 ROM 后台锁定/自启动引导页；
     - **GitHub APK 分发版本**：可额外检测 `PowerManager.isIgnoringBatteryOptimizations()` 并支持一键唤起系统电池优化白名单授权弹窗。

---

## 八、分阶段落地优先级路线图与量化验收指标

### 8.1 实施路线图

| 阶段 | 周期建议 | 核心交付项 | 涉及关键模块 |
| :--- | :--- | :--- | :--- |
| **Phase 1：体感立竿见影（High ROI Quick Wins）** | 1~2 周 | 1. **Web 实时流修复**：打通增量/块级渲染 + `deferEnhance: true` + 33ms 节流 + 平滑吐字，取消发送 20s `readOnly` 锁<br>2. **Web 首屏止血**：Vditor/Lute 懒加载 + `?v=` 缓存，修复字体双下载，消除 13 个 CSS `@import`，Desktop 改 `/healthz` 3 次容错探测<br>3. **服务端热点清理**：静态跳过 SQLite Auth + 请求级 `authSession` 记忆化、`ensureProjectsInitialized()` 单次化、修复 `/api/models` 3 次执行与 `/api/tools` 缓存顺序、开启 HTTP `gzip`/`br` 与静态预计算 ETag<br>4. **Android 轻量加速**：共享全局 `OkHttpClient` 单例、解除 `MainActivity` `lazy` 锁、去除 `models?refresh=1`、去重 3 处 `refreshSessions()`<br>5. **缩略图与磁盘缓存**：服务端新增 `/api/assets/:id/thumbnail` + Android 图片/附件持久化 `DiskLruCache` | `static/chat/{timeline-runtime,realtime-render,compose,markdown-composer-editor,chat-base}.*`<br>`chat/{router,projects,models,router-control-routes}.mjs`<br>`lib/{auth-session-store,tools}.mjs`<br>`desktop/main.cjs`<br>`android/core/{network,database,domain}/...`、`android/app/src/main/java/com/andysagent/ragent/{MainActivity,TimelineAttachmentHost}.kt` |
| **Phase 2：传输协议与缓存体系质变** | 2~4 周 | 1. **DataChannel 二进制流 + 压缩**：新增 `http_response_binary_v2` 消除双重 Base64 与 `io.ReadAll`，背压改为事件驱动 + 256KB~1MB 窗口<br>2. **单通道流式直推**：扩展 `dc_push_v1` / `dc_stream_v1` 直推 `text_delta` 与运行态，移除 Android 1s 与 15s 运行态轮询<br>3. **Web 打包与持久缓存**：引入 `esbuild` 代码分割 + Hash 缓存 + IndexedDB SWR 缓存 + `/ws` 心跳与断网即时状态<br>4. **Android 完整离线与 ETag**：Room 持久化富时间线投影与草稿、打通 OkHttp Cache + `If-None-Match` / `304`、修复 `/events/delta` 真增量、4 路并发 Range / 中继流式下载 | `p2p/cmd/ragent-p2p-host/{main,response_stream}.go`<br>`chat/{ws,ws-clients,session-live-feed,router-session-main-routes}.mjs`<br>`android/core/{p2p,network,database,domain,sync}/...`<br>`static/sw.js` + 前端构建脚本 |
| **Phase 3：极速建连与后台强保持** | 3~5 周 | 1. **极速建连**：合并 Rendezvous `create + authorize`、Accounts PG `LISTEN/NOTIFY` 替代 2s 轮询、桌面 TURN 凭证预热池、直连公钥本地缓存<br>2. **无缝切网与续接**：支持 WebRTC **ICE Restart** + 有效合约复用<br>3. **Android 分级后台保活**：活跃任务按需合规 FGS + 后台心跳降频（15~20s）+ 回前台 **800ms Happy Eyeballs 竞速恢复**<br>4. **FCM 富摘要 + 预热 + 分渠道省电引导** | `accounts/{owner-auth-broker,owner-auth-routes,rendezvous-result-waiters,push-service}.mjs`<br>`lib/{owner-account-auth,p2p-host-agent}.mjs`<br>`android/core/{auth,network,p2p}/...`<br>`android/app/src/main/java/com/andysagent/ragent/{RagentApplication,RagentFirebaseMessagingService}.kt` |

### 8.2 量化对比基准与验收目标

| 指标项 | 当前基线（实测/代码推算） | Phase 1~3 完成后目标 |
| :--- | :--- | :--- |
| **Web 冷启动首屏总流量** | ~8.5 MB（含 3.57 MB × 2 Lute、101+ 请求、无压缩） | **≤ 450 KB（gzipped）**，核心首屏请求 ≤ 10 个 |
| **Web 首屏可交互时间（TTI）** | 受 70 同步 JS + Vditor + 串行 API 瀑布阻塞 | 缓存命中 **< 300ms**，首次冷开 **< 1.2s** |
| **Web 长输出流式帧率** | 随着字数增长跌帧（每帧 $O(N^2)$ `replaceChildren`） | 全程稳定 **60fps**，划词选中不中断 |
| **Android 冷启进已有会话可见时间** | 首帧受 `lazy` 锁影响；工具步骤等连上电脑才蹦出 | **< 200ms** 0ms 完整呈现离线图文与工具步骤投影 |
| **Android 缩略图加载流量** | 每张图下载整张原图（最高 8 MB）用完即删 | 首次 **~30 KB（WebP）**，二次命中 **0 KB / < 10ms** |
| **DataChannel 大响应开销与吞吐** | 双重 Base64（+77%）+ 64 KB/10ms 轮询（TURN ~640 KB/s） | 二进制 + Gzip（体积 **-80%**），吞吐 **提升 3~5×** |
| **切后台 5 分钟后回前台恢复** | 4s `dc_ping` 超时 + 8 跳重建 = **6~10s** | 800ms 竞速触发 ICE Restart = **0.5~1.5s**（活跃任务期不断连） |
| **Wi-Fi ↔ 5G 切换恢复耗时** | 强制销毁会话重走全量 Rendezvous | 优先 ICE Restart，**1~2s 内平滑续流** |

---

## 九、SLO 可观测性埋点与 Phase 0 真机基线采集清单

为确保每一阶段的改造收益可量化、无回退，在代码落地前与落地过程中同步接入以下核心 SLO 指标：

| 指标名称 | 采集端 / 链路 | 统计口径与告警阈值 |
| :--- | :--- | :--- |
| `rendezvous_ms` | Android `AccountSessionManager` + Accounts | 从发起 `POST /v1/owner-auth/rendezvous` 到收到完整签名 bootstrap 合约耗时（P50 / P95） |
| `ice_connect_ms` | Android `ConnectivitySupervisor` + `P2PDataChannelTransport` | 从创建 `PeerConnection` / 发送 Offer 到 `ragent-http` `OPEN` 且 `/api/auth/me` 探测通过耗时 |
| `ice_restart_success_rate` | Android + Go Sidecar | Wi-Fi ↔ 5G 切换或短切回前台触发 ICE Restart 的一次成功占比（无需降级重走 Rendezvous） |
| `p2p_vs_turn_ratio` | Android `PeerConnection.getStats()` | 最终选定路径中 `P2P` 直连与 `Turn` 中继占比（分同局域网/跨网统计） |
| `dc_ttfb_ms` | Android `P2PDataChannelTransport` | 请求写入 DataChannel 到收到响应首帧（含二进制流首帧）耗时 |
| `chat_open_to_reveal_ms` | Android `WorkbenchScreen` / Web `session-http.js` | 点击会话到 `readingReveal == 1f`（Web 首屏可见且可交互）耗时 |
| `stream_jank_frames_p95` | Android `FrameMetrics` / Web `PerformanceObserver` | 流式吐字期间长帧（>16.6ms / >32ms）占比与掉帧 P95 |
| `foreground_resume_to_ready_ms` | Android `RagentApplication.onStart` → `Connected` | 后台切回前台（分 <3 min / >5 min 两档）到携带有效链路可用的恢复耗时 |

### Phase 0 真机与桌面基线采集清单
1. **Android 真机实测（`RFCT5155C1P` / `SM-S9060`）**：
   - 采集冷启动（无公网端点、经 Accounts Rendezvous）的 `rendezvous_ms`、`ice_connect_ms`、`chat_open_to_reveal_ms` P50/P95；
   - 实测三星 One UI 下 `FOREGROUND_SERVICE_TYPE_SHORT_SERVICE` 在息屏/切后台 1 min、2 min、3 min 时的真实存活率与 `foreground_resume_to_ready_ms`；
   - 实测 Wi-Fi ↔ 5G 切网与连续 5 张大图缩略图加载总流量与耗时。
2. **Web / Desktop 本地实测**：
   - 记录改造前冷启 Chrome DevTools 传输字节数、请求总数、LCP/TTI，以及 4000 字长代码块流式输出期间的主线程 Long Task 时长分布。
