# Codex 能力管理与账号同步方案

状态：实施中。本文区分已验证的行为、正在实现的能力和尚未验证的目标；不能据此认定 Google Drive 已经接通。

## 目标与边界

Ragent 在执行 Codex 的主机上管理账号范围内的能力发现、配置、授权状态和远程展示。Codex 负责实际加载和调用其 App、Plugin、Skill 和 MCP；Ragent 不充当 Google OAuth 或 MCP 代理。Windows、Linux、Mac 和 Android 应展示同一执行主机、同一账号下的状态，并保留现有工作区政策和操作审批。

Google Drive 完整验收要求在用户 Google Drive 云盘根目录创建专用测试文件夹，再通过实际 Codex 任务在其中创建测试文档，分别记录发现、授权、调用和文件落盘结果。普通编码任务不得因外部服务不可用而被全局阻塞。

## 代码现状与约束

- `lib/provider-runtime/run-provider-prepare.mjs` 根据 Provider、认证和运行策略生成 Codex Home 与配置；当前生成配置显式设置 `plugins = false`。`chat/runtime-policy.mjs` 解释了早期为避免代理环境额外认证挑战而禁用插件的原因。直接声称登录后原生 Plugin 会被加载是不成立的。
- `chat/codex-app-server-broker.mjs` 复用账号对应的 App Server，`chat/codex-app-server-client.mjs` 提供能力查询；`chat/harness-capability-catalog.mjs` 将运行时结果投影到会话 API。读取目录、全局可调用和某个 Thread 的实际工具集合是不同证据。
- Codex 原生 `skills/list`、`mcpServerStatus/list`、`app/list` 和 `app/installed` 已在本机版本探测；不同版本可能没有某些接口或字段，必须降级处理。`app/installed.callable` 只证明返回的运行时快照，不证明特定任务已调用成功。
- Codex 0.164.0 的 `thread/start` 和 `turn/start` schema 探测未列出 `disabledPluginIds`，不能照搬较新协议字段解决只读隔离。`thread/start.config` 是泛型配置对象，是否足以隔离全部 MCP 和 Plugin，以及在实际运行版本能否正常执行，都需实际验证。
- Codex 0.164.0 的 `features list` 探测将 `apps` 和 `plugins` 均列为稳定且默认开启；Ragent 自己生成的 `plugins = false` 会覆盖后者。原生 Plugin 功能稳定与 App Server 的 Plugin 管理 RPC 尚不适用于生产是两项不同结论。应评估提供受策略约束的原生 Plugin 加载开关并实测代理及授权影响，不能仅因管理 RPC 未开放就断言原生 Plugin 无法加载。
- [OpenAI App Server 文档](https://developers.openai.com/codex/app-server)目前将 Plugin 管理接口标为开发中、不用于生产客户端。生产功能不能依赖这些接口；协议中出现接口也不能证明可完整枚举 ChatGPT 云端所有已安装 Plugin。未来仅在官方支持后启用生产安装和同步，实验验证必须隔离和显式开启。
- 旧的 `/api/codex/mcp-servers` 操作全局 Codex 配置，与按用户所选 Provider 执行的会话不是同一作用域。新功能使用 Provider 和经过验证的账号作用域；旧接口的兼容和迁移不能将未知来源配置自动导入其他账号。
- Android 原连接器页使用旧全局 MCP 接口；Web 原连接器面板也只列出 MCP 配置。两端需要展示选定的执行目标与账号，并区分 Codex 的 App、Skill、MCP 和 Ragent 自有连接器。

## 分层设计

```text
Web / Android: 目标、账号、能力列表、状态和用户操作
       ↓ 已有目标访问控制和远程通道
Ragent Control: Capability Catalog + Provider-scoped 管理 API
       ↓ 账号绑定、并发协调、最小状态存储
Ragent Host: Codex broker / 生成的账号 Home / MCP 配置
       ↓ Codex 原生协议和用户授权
Codex: App / Skill / MCP /（官方支持后）Plugin
```

上层状态模型保留 `discovery`、`configuration`、`authorization`、`runtime`、`scope` 和更新时间/错误信息。`unknown` 不能变成成功；配置成功不等于授权成功，授权成功不等于工具可调用，工具可调用不等于写入成功。App、MCP、Skill、Plugin 保留各自的原生语义，不强行提供统一安装接口。

## 已实施的基础能力

1. **发现**：会话能力目录按选定 Provider 查询 Codex Skills、MCP 状态、Apps 和已安装 App 状态，处理分页、超时、不支持和错误；Plugin 生产查询明确标记不可用。访问受会话权限、所有者权限及工作台政策约束。
2. **MCP 配置**：`/api/providers/:provider/codex/mcp-servers` 使用 Provider 验证账号，按账号管理服务器；同一账号的多个 Provider 共用期望配置。使用原生 `codex mcp` 写配置，仅将 MCP 表合并到普通运行时；限制 URL 和输入，不返回凭据或环境变量。变更在下次运行时准备时生效，并尝试通知已运行的 broker 重新加载；失败不应阻断普通任务。
   获取配置锁后及发起 OAuth 前会重新解析 Provider 账号，拒绝已切换账号的请求；自动测试覆盖请求读取期间发生账号切换。该检查缩小了异步切换窗口，不替代最终的并发账号切换验收。
3. **账号隔离**：不同账号使用不同的 Codex Home 和 MCP 配置，保留可验证的旧账号 Home。MCP OAuth 使用 Codex 原生文件凭据存储，Ragent 不读取第三方令牌。账号不可验证时拒绝猜测或继承旧状态。
4. **OAuth**：仅连接已运行且账号匹配的 broker，按服务器序列化，同一授权的通知只返回发起方；收到完成通知后重新查询 MCP 授权状态才显示已连接。停止跟踪不等于撤销原生授权；旧请求的占位持续至完成或超时，避免无 `loginId` 的旧版回调串到新请求。
5. **界面**：Web 连接器面板显示账号范围 MCP 和发现的 Apps/Skills；Android 按账号列出和管理 MCP，提供授权链接及状态检查。Android 已增加独立的 Codex 账号选择，未打开会话时也可查看账号范围的同步和插件加载设置；打开所属账号的会话后可查看原生 Apps 的配置与运行状态、管理可操作的 Skills，切换账号时不混用其他会话的状态。App 的授权和实际工具访问仍需另行确认，当前没有声称支持 App 安装管理。对支持的 Codex 回环回调，手机可复制浏览器返回地址并转交当前授权任务；其他回调仍需主机浏览器。以上仍需在三星实体机完成布局和交互验收。
6. **Skill 首版**：Web 和 Android 对当前会话提供 Skill 启停。服务端根据会话明确指定的 Provider、模型范围或默认选择重新核对账号，再查询原生目录，拒绝客户端传入路径、失效项目及无法确定的账号；按账号保存期望状态，后续正常任务准备时将其写回生成配置。界面说明下次任务将启用或禁用，并提供撤销更改，不把持久化结果当作当前运行时已经更新。
7. **原生 Plugin 加载开关**：已增加账号范围的显式开关，默认关闭；正常的官方 OAuth 运行环境可将期望值写入 Codex 配置，受管理和只读运行环境仍禁用。保存、手动重试或后续任务准备时会尝试通过账号校验及空闲检查安全退出 broker，下个任务再启动；忙碌、老版本不支持或退出失败时保留待处理状态，不中断任务。Web 和 Android 显示待重启的期望值，不声称已经安装或同步任何 Plugin。真实代理和账号验证仍待完成。
8. **后台发现**：Codex OAuth 登录成功后后台尝试查询已运行且账号匹配的 broker，记录按账号和 Provider 隔离的发现状态；没有运行中的 broker 时标记等待并在短时间内重试，不为发现而启动另一份 OAuth 持有者。普通 Codex 任务成功提交后会重新调度发现，不等待结果或阻断任务；无法确定 Provider 和只读任务不触发。Web 和 Android 查询当前会话能力时也会更新发现结果，并提供状态及手动刷新。当前不会自动安装插件；项目级 Skill 仍由当前会话查询。真实实例行为仍待验收。

## 必须完成的工作

### P0：正确性与单一账号所有权

- **跨 Provider 同账号**：一个账号的多个 Provider 不得并发使用独立的可轮换 OAuth 凭据副本。需要统一账号级 broker/Home 所有权、迁移检查和并发锁；MCP、Skill 与 Plugin 期望配置按账号共享，仍需验证与共享 Home 的一致性。旧实现把单个 Provider ID 写在共享 Home 中，账号合并后不同任务会覆盖它，必须改为每次运行独立的身份绑定并校验 broker。验证账号切换、同账号多 Provider、并发启动、崩溃恢复及旧会话恢复；对无法安全迁移的旧状态拒绝并提示。
- 账号所有权约束必须覆盖所有启动入口：普通及受监督任务、后台生命周期任务、模型目录查询和 Thread fork；不能只修复聊天任务后，让模型列表查询重新创建另一份 OAuth Home。
- 检查 Linux control/runner 用户、Windows 服务身份、目录 ACL、文件凭据及 broker IPC 边界，确认实际执行进程读取同一账号 Home。特别检查只读任务使用的运行隔离目录是否会复制同一 OAuth 轮换凭据并形成第二个持有者，不能因隔离权限而破坏账号级单一所有权。配置重载只能在确认成功后记录完成，失败后可重试。
- 可研究的隔离方向：Codex App Server 的 `chatgptAuthTokens` 可由宿主提供短期访问令牌并处理刷新请求，使隔离进程不持有刷新令牌；但官方将该模式标为实验性，且要求宿主管理完整认证生命周期。当前 Ragent 的原生 broker 才是轮换令牌持有者，尚无经验证的安全令牌交接、续期及权限边界，不能据此启用生产实现。参考 [App Server 外部认证](https://developers.openai.com/codex/app-server)。
- 验证 Skill 启停在真实 Ragent 任务、多个会话及项目/用户作用域的生效和重启恢复；继续核对受管理策略和只读任务边界。Codex 写入的配置不能在 Ragent 下次生成 `config.toml` 时被覆盖。
- 为状态增加可观测的刷新、超时、失败原因和重试；确保退出/停止跟踪语义与原生协议一致。不要记录授权 URL、令牌、文件内容或可识别账号的敏感数据。

### P1：产品体验

- 在 Web 和 Android 明确区分选定的目标设备、Provider、账号和作用域；状态随目标或账号切换失效，避免旧异步结果覆盖新选择。
- 授权引导应说明是否需要主机浏览器；手机回调转交只接受当前任务生成的精确回环地址和状态，通过已鉴权通道由主机访问 Codex 回调；真实设备、不同版本及失效场景仍须验收。
- 将 Skill、App 和 MCP 的发现/配置/授权/调用状态贯通到会话；安装、启用、权限变更和破坏性外部操作继续遵循原生政策与审批。自动恢复仅限用户已批准并仍被策略允许的配置，新权限需用户主动处理。
- 提供明确的旧全局 MCP 迁移预览与用户选择，避免无账号归属的数据自动复制；为不兼容版本提供解释和手动替代路径。

### P2：验证与交付

- 阶段测试覆盖身份绑定、配置锁、失效的授权通知、分页和版本差异、目录权限、重载失败/重试、UI 状态和远程权限策略。
- 使用本机 Windows Ragent 实例、SSH `pinggu-192.168.196.184` 的 Linux 实例、SSH `choukyou@192.168.196.153` 的 Mac 实例和三星实体机分别验证，记录实际构建版本、运行身份、账号选择和结果。独立的本机开发工作树、缓存和报告放在 `G:/AgentoC`；用户已明确允许现有 Windows 服务按原配置使用 `C:/ProgramData` 产生运行数据。避免影响其他并行任务。
- 真实 Google Drive 验收需证明：发现目标能力 → 用户授权有效 → 新 Codex Thread 实际获得并调用目标工具 → 测试文件夹和文档确实存在。任一步缺失则明确报告未通过，不以 mock 或列表结果替代。
- 最后执行回归和交付审计：普通任务、只读策略、原有审批、并发账号切换、Web 和实体 Android、服务重启恢复，记录已知限制与回滚方法。

## 接口与状态约定

| 对象 | 来源 | 可执行操作 | 成功的证据 |
| --- | --- | --- | --- |
| App | Codex `app/list` 和 `app/installed` | 发现和展示；授权仍由原生流程决定 | 当前查询返回的可调用状态；线程实际调用另行验证 |
| MCP | 账号范围配置及 `mcpServerStatus/list` | 添加、删除、发起原生 OAuth、停止跟踪和刷新 | 写入配置、原生授权状态和任务内工具调用分别确认 |
| Skill | Codex `skills/list` | 对当前会话可见项设置启停期望值 | 保存成功仅表示期望状态；下次运行时刷新后读取生效状态 |
| Plugin | Codex 原生加载配置；官方 Plugin 管理能力 | 账号范围设置原生加载期望值；管理 RPC 提示不可用 | 配置保存不等于运行中生效；官方正式支持管理 RPC 后逐版本验证发现、安装和授权 |

账号范围 MCP 接口位于 `/api/providers/:provider/codex/mcp-servers`；授权任务的查询和停止跟踪从该路径的服务器名称下进行。Skill 修改位于当前会话的 `harness-capabilities/skills`。请求必须先通过目标及会话授权，写操作要求所有者权限，并由服务端重新解析 Provider、账号和原生目录；客户端不得提交主机 Skill 路径或选择其他账号的授权任务。

状态字段分别表示发现、配置、授权和运行时；客户端应展示查询失败或 `unknown`，并提供刷新入口。切换执行目标、会话或账号时丢弃过期结果。保存 Skill 或 MCP 配置不代表当前已有 Thread 已经更新；应提示下一次运行时刷新，并通过原生结果确认。

## 同步策略和生命周期

提供三种账号级策略：`manual` 由用户发起发现；`approved-auto` 默认在登录和后续任务启动后自动发现并使用先前明确配置的能力；`disabled` 停止同步和同步状态刷新。新能力和额外授权仍需用户操作，工作区和现有审批策略保留最终决定权。关闭同步不会删除或停用已经配置的工具；Plugin 加载使用独立开关。原生 Plugin 安装协调仍属待实现工作。

登录完成或手动刷新时，先确认目标、Provider 和可验证账号，再读取原生发现结果和账号内的期望配置，计算差异。对允许恢复的既有配置执行可重试的协调；发现新能力、缺失授权、策略禁用或不兼容版本时展示对应状态，不自动赋予外部服务权限。必要的原生授权在执行主机上完成，随后重新读取授权状态。下一次运行时准备加载新配置；需要时在新 Thread 验证工具调用。取消跟踪只停止 Ragent 对该任务的等待，不承诺取消 Codex 已发出的授权请求。

账号切换时停止引用旧账号的内存结果和待处理授权任务，重新解析账号 Home、配置和 broker；保留旧账号数据供该账号再次登录时使用。并发配置写入按账号加锁，原生 OAuth 凭据由单一运行环境持有；无法证明账号归属或安全交接时，应拒绝迁移并报告可操作的错误。

## 部署、兼容与回退

1. 以固定源码版本生成 Windows、Linux 与 Android 构建产物，记录源码提交、包版本、签名和部署时间。构建前复核磁盘余量和其他会话的未提交工作；不得把它们无意间打包或覆盖。
2. 先验证部署包与现有服务身份、现有数据目录、账号和升级机制兼容，再按各平台正常升级流程部署；升级前记录现有版本和回退路径。Windows 的服务运行数据继续使用用户允许的既有 `C:/ProgramData` 路径。
3. 部署后先检查服务健康、现有账号与普通 Codex 任务，再验证能力目录、MCP 配置和授权、Skill 状态以及重启恢复；最后在三星实体机通过真实目标连接重复关键操作。测试任何失败都保留原始错误和版本，不将其计为通过。
4. 回退时使用先前完整版本的正常升级或恢复机制，保留会话、账号及用户文件；账号 Home 所有权和旧会话迁移是否可逆需在部署前验证，不能只回滚程序而忽略状态格式。不得删除第三方凭据来制造干净状态。
5. Codex 方法和字段按运行版本探测；缺失接口、原生认证失效及不支持重载均作为独立状态上报。不得使用终端交互脚本模拟尚不支持的 Plugin 安装，也不得自动绕过工作区禁用策略。

验收记录至少包含执行目标及服务版本、所选 Provider、可验证的账号绑定、操作时间、发现结果、授权结果、运行线程与实际工具调用结果。Google Drive 验收另外记录专用文件夹和文档的可核实位置；不得在报告中写入令牌或授权链接。

| 验收场景 | 判定通过的条件 |
| --- | --- |
| 不同账号切换 | 配置、第三方授权及列表不串账号；不可验证账号不能继承旧状态 |
| 同账号多个 Provider | 并发任务使用同一凭据所有者；MCP/Skill 期望设置一致，旧会话仍能恢复 |
| 原生方法缺失或超时 | 明确提示不支持或未知；普通编码任务可继续；恢复后可重试 |
| MCP 连接 | 添加配置、主机授权、状态复查和新任务调用分别成功；撤销或过期后不再显示已连接 |
| Skill 启停 | 只能操作原生目录中当前会话可见的项目；保存后展示待生效，刷新/重启后按原生结果核对 |
| 权限与审批 | 非所有者不能修改；受管理与只读策略不因同步获得额外能力；外部写操作仍走既有审批 |
| Windows、Linux 与 Mac | 现有服务升级后账号和普通会话仍可用；重启后账号绑定、配置及旧会话保持正确 |
| 三星实体机 | 对三个真实目标分别检查选择、展示、修改、授权指引和状态刷新；断线或切换目标不显示旧状态 |
| Google Drive 实际写入 | 用被测 Ragent 的新 Codex 线程在云盘根目录创建专用文件夹并在其中创建文档，独立核实位置和内容 |

### 三星端逐项验收

以已安装的最终集成包和三个正式目标分别执行，记录 APK 签名与哈希、主机版本、所选目标、账号和实际结果；账号仅用脱敏标识。每次开始前核对页面显示的目标与被测主机一致。

1. **进入与布局**：在无会话和已有会话两种状态进入连接器，分别检查目标名称、Codex 账号选择、MCP、App、Skill、同步和 Plugin 加载设置。检查顶部/底部安全区、键盘弹出、滚动、长账号名、中英文、深浅色及系统放大字体；控件不得重叠、截断重要状态或被系统栏遮挡。检查单选项整行点击及读屏名称、选中状态和焦点顺序。
2. **账号与会话**：先选择账号 A，再选账号 B，确认列表、期望设置和状态属于 B；切到 A 的会话后确认会话能力来自 A。切换过程中延迟返回的旧请求不能覆盖当前页面；没有可验证账号或会话不属于所选账号时展示可理解的提示。
3. **MCP 管理**：在明确的测试账号添加测试服务器，分别核对 URL 与可执行文件加逐行参数；使用包含空格的路径和参数验证边界。刷新后核对账号归属及配置，再删除测试项并确认仅该账号受影响。服务不可用、版本不支持和操作失败要显示真实原因，不得显示成功。
4. **授权**：选择需要 OAuth 的测试连接，确认弹窗同时展示目标账号和服务器；在手机浏览器完成授权并转交支持的回环返回地址，检查状态；同时验证不支持时的主机浏览器回退。未完成或未验证时不得显示已连接；停止跟踪、关闭弹窗、切换账号或断网后再次检查，不得把旧请求归属到新账号。手机复制链接及重新进入的行为必须可操作。
5. **Skill 与 App**：在被测账号的真实会话中切换一个可管理 Skill，验证待生效和撤销，再启动新任务并从原生状态确认；App 展示发现、配置和运行状态时，未知授权仍保持未知。通过手机发起新任务实际使用已授权能力，核对工具调用与结果，而非只看列表。
6. **同步与 Plugin**：逐一选择手动、已批准自动、关闭，刷新或重连后核对当前账号策略；关闭同步不删除现有工具。检查 Plugin 加载开关、待重启和不支持管理接口的提示；不把保存成功显示为插件已安装或第三方授权有效。
7. **连接与回归**：请求期间切换 Windows、Linux、Mac 目标并模拟断线和恢复；旧目标响应、错误、授权任务和进度不得出现在新目标。验证返回、重复点击、慢请求、失败重试、屏幕旋转和普通编码任务；可能修改外部数据的操作仍遵循已有审批。

Google Drive 最终场景在云盘根目录创建单独的测试文件夹，并在其中创建文档；记录实际线程、工具调用、文件夹和文档的可核验位置，独立核实内容。不要把模拟 App、测试目录、安装成功或授权页面显示当成写入成功。

## 当前验证证据

- 本机 Codex App Server 的能力查询和协议结构已做隔离探测；Web 的桌面/移动浏览器面板测试及 Android 的 Provider 范围管理单元测试已通过。
- Linux 实例的 Harness API 报告 Codex 0.164.0 已安装并可用、一个 Codex OAuth Provider 可用；使用该实例的 Codex 二进制和临时 Home，四项原生能力查询均返回预期结构。此检查未使用真实账号完成任务。
- Linux 当前 `agentoc.service` 以 `pinggu` 用户和组运行；配置目录为 `750 pinggu:pinggu`，原生 Provider 注册目录为 `700 pinggu:pinggu`，runner Home 根目录为 `2770 pinggu:pinggu`。这只是部署前的目录检查，尚未证明实际任务启动者对新增账号设置及 broker 的权限完整可用。
- Mac 现有 `/Applications/Ragent.app` 当前报告版本 `0.3.19`（并行工作期间由 `0.3.18` 更新），本机健康检查返回 HTTP 200，SSH 显示实际用户为 `kyouchou`；应用打包路径中的 Codex 报告 `0.164.0`，默认 SSH PATH 没有 `codex`。当前未向该实例部署本功能，也未在 Mac 完成本功能的真实账号和任务验收。
- Mac 使用快照 `60334881157c97968c3e55ca3b728f1c7991e624`、应用内置 Node 和临时测试数据执行 21 项阶段测试，通过。首次执行缺少应用启动器提供的 `AGENTOC_PACKAGED_HARNESS_ROOT`，其中一项找不到 Codex；补充实际应用运行时路径后完整重跑通过。这不是正式实例升级或真实账号任务验收。
- 固定主机快照 `d6575598358d926b4c1948ef5e13c6741bf614b1` 包含最新账号凭据交接修复，分别在 Windows 和 Linux 使用对应 Node 运行 13 项阶段测试，全部通过；其中 Linux 覆盖 Unix 套接字的生命周期启动器。测试使用临时数据和模拟服务，没有升级、启动或替换 Linux 正式实例，不能作为真实账号、手机或 Google Drive 验收。
- 后续固定主机快照 `60334881157c97968c3e55ca3b728f1c7991e624` 合并了当时已提交的并行改动和本功能代码，Windows 20 项、Linux 21 项阶段测试通过。首次 Linux 测试包漏带 `scripts/`，两项无法启动；补齐同一快照脚本后完整重跑通过。桌面运行载荷的完整性扫描和 Windows 审批组件输入检查也通过。上述快照不含其他任务当时尚未提交的修改，也没有部署到正式实例。
- 并行的 Windows 正式实例真实官方账号并发测试曾报告共享 Codex 进程未就绪和 OAuth 刷新锁超时；旧进程空闲交接及后续升级后，两条真实会话已验证运行时间重叠且最终完成，期间只有一个 broker 和一个 Codex 进程。这验证了当时安装版的该场景，仍须对本功能最终集成版本、只读任务和其他平台分别验收。
- 从上述固定快照以 Git 对象生成的精简桌面运行载荷已通过 `verify-runtime-payload` 和 Windows 审批组件输入检查。该载荷未安装，也不包含后续其他任务尚未完成或提交的修改；最终集成包仍需重新固定版本、构建和验收。
- Windows 已安装实例的界面显示两个 Codex OAuth Provider；通过管理员通道只比较身份、未输出账号值或令牌，两个 Provider 均具有工作区账号标识，且标识不同。正式实例运行的载荷尚未更新为本文改动。
- 在 G 盘隔离测试目录中，真实本机 Codex 和 Ragent broker 对本地模拟 MCP/OAuth 服务完成授权，回调返回成功且复查状态为 `oAuth`；另一个独立 Codex Home 对同一服务为 `notLoggedIn`。追加第二个服务器后，原生 `config/mcpServer/reload` 和状态查询可发现新服务器。这不是 Google 授权，也未证明跨 Provider 同账号的旋转凭据协调。
- 真实 Codex 对隔离的本地 Skill 接受 `skills/config/write` 禁用请求，随后列表返回禁用，且将设置写入 `[[skills.config]]`。用 Ragent 渲染器重新生成启用设置后，强制刷新列表返回启用；真实任务重启恢复和与多个并发运行的协调尚未验收。
- Codex 0.164.0 探测分别接受 `features.plugins=true` 和 `false` 并返回对应状态；Ragent 运行时测试覆盖账号设置启用、只读环境禁用，以及不同账号和同账号多 Provider 的偏好隔离。这仅验证开关，不证明 Plugin 发现、加载或云端同步成功。
- 本机 `C:/Users/asus/AppData/Local/OpenAI/Codex/bin/37f54d68e5533a51/codex.exe` 当前报告 `0.163.0-alpha.11.2`；用该二进制重新运行模拟 MCP 线程隔离探测，普通 Thread 的 `mcpServerStatus/list` 返回一个工具；`thread/start.config` 对该服务器设置 `enabled=false` 后，新 Thread 的同一状态查询返回零个工具；两个 Thread 均完成一次本地模拟模型的回合。同一个原生工具搜索在普通 Thread 找到了模拟工具，在禁用服务器的 Thread 返回结果中没有该工具；模拟模型随后在两个 Thread 都发出该工具调用，普通 Thread 到达模拟 MCP 一次，禁用服务器的 Thread 未到达。该结果只覆盖单个模拟服务器和模拟模型，尚未验证 Plugin、App、多个服务器、恢复的 Thread 或其他版本，不能代替只读权限验收；该二进制不一定是 Ragent 当前执行的版本。
- 使用上述 Windows 二进制、纯合成 JWT 和本地模拟模型验证实验性外部认证：正常请求可以完成，测试目录没有生成 `auth.json`。模拟服务返回 401 时，进程发出了外部刷新请求，但提供新的合成令牌后该回合因测试环境的应用网络策略不可用而失败；因此刷新链尚未验证，不能作为生产隔离方案。完整探测脚本位于 `G:/AgentoC/_qa/codex-external-auth-probe.mjs`，未使用真实账号或令牌。
- 账号范围 MCP 和 Skill 配置并发、授权请求归属、路由权限、Web 桌面和移动视口以及 Android 工作台相关单元测试已通过；其中 OAuth 端到端证据使用的是本地模拟服务。
- Android 工作台 19 项相关单元测试及两项宿主侧 Compose 截图渲染通过；已人工查看 320dp 中文大字体和 360dp 英文深色预览，并修复窄屏文字挤压及 Skill 待生效文案。账号切换和新会话选取也有对应状态测试。预览使用较高视口以同时展示多张卡片，不替代手机滚动、交互或真实目标验收。
- Android 的 MCP 添加表单随后增加了逐行参数输入，避免将带空格的可执行路径和参数混成一个文件名。原生 Codex MCP 配置探测和 Android 工作台单元测试已验证路径和参数边界；这批表单改动尚未进行真机验收。
- MCP 添加表单的账号单选项已支持点击整行，并为读屏器提供单选组、选中状态和账号名称；Android 工作台 Kotlin 编译通过。实际触摸和读屏效果尚待三星实体机验证，这项修改也不在此前的 APK 候选中。
- MCP 授权弹窗增加账号和服务器名称，便于用户核对授权对象；中英文字符串 XML 和占位符已检查，新的界面修改尚未编译或在三星验证。
- 包含上述无障碍调整的 Android 源码快照为 `f8b8231347fcdda6e9f23b77706997489cdecdf9`，尚未打包；它以当时主线为基础，不能代替其他任务尚未提交的改动或最终集成验证。
- Android 固定源码快照 `18bf27bc55f6d2d79b0830e065d4e2836eb830e9`（基于当时的 `f6a6b95`，叠加本项 Android 修改）已构建 debug APK，SHA-256 为 `B96DCADE9E96654F4F0D7C745CAEAA563AFF47161C48D67B56DE4D9A73C5B984`。资源检查确认包含原生 App 列表、MCP 参数表单和 Skill 撤销文案，签名与当时从三星手机提取的安装包一致。该候选包未安装，可能不包含随后并行开发的功能，不能作为最终集成包或真机验收结果。
- 整合当时已提交主线与上述 Android、主机修改的联合源码快照 `8a61f78dec325f35ee46031983aeadeb27c5f1be` 已固定，仅用于后续集成构建准备；它尚未构建、部署或进行端到端验证，也不包含其他任务未提交的变更。较早的 `81fab0a0fd7c66d623784cb454cdc218ad0c0cc1` 已用于准备浅层 Mac 打包源码，并不含后续无障碍修改。
- Android 集成候选源码 `fbcdb07f9a16ab6ee0795b4d7c7094514f0f7706` 额外纳入了并行任务已在三星实测的附件选择归属修复及其测试；该修复当时仍在共享工作区、尚未提交。首次构建缺少 SDK 路径，指定本机已有 SDK 后重试；由于 G 盘剩余空间快速下降，重试被主动停止，没有产出可验收的 APK。该源码未经本功能真机验收，也未覆盖其他并行任务的未提交修改。
- 后续集成源码 `e0871b92d18329474ec854e2149fe661e7962c2d` 进一步纳入了附件草稿按项目隔离的已测试修改和当时最新的已提交主线；该快照尚未构建，也未部署或完成能力管理验收。
- 最新固定源码 `8aebf30f9004db7a9956e90b420f9d135b7b268f` 增加 MCP 锁后账号复核及手动发现的原始账号绑定检查；两组针对性回归通过。首次同步回归在机器负载下触发测试等待超时，调整测试使用可控短重试间隔并放宽完成期限后重跑通过。该快照尚未构建或部署。
- 锁占用期间切换 MCP 账号的回归已进一步覆盖，连同账号同步测试在 Windows、Linux、Mac 阶段测试中通过；Linux 和 Mac 使用临时测试数据及各自主机的 Codex 运行时，并未更新正式实例。源码快照 `c3c183b6e5ef7dfde0fc8b28d6ca5bdc138d78b2` 未部署，真实账号并发切换仍待验收。
- 从 `c3c183b6e5ef7dfde0fc8b28d6ca5bdc138d78b2` 的 Android 源码生成的候选 APK SHA-256 为 `BAF64AA75EB5A4B85CE0F74F6D5A3A462B8CDAAFD45AF037D1ED2E568FA30C41`。资源检查包含 App 列表、MCP 参数、授权账号与服务器提示和 Skill 撤销；签名与当时三星已安装的 APK 一致。该包尚未安装或进行能力管理真机验收，且可能不含其他并行任务后续修改，不能作为最终集成包。
- Windows 固定快照 `d9bad8f6a808cb5ced5b642c8f92deb1660a1413` 已构建 `0.0.70` 候选 MSI，SHA-256 为 `937AC5298F3086F261E18C44656FCFFC5F452212936562A857122AA738771669`，载荷扫描及 Windows 审批组件输入检查通过。构建时现有正式实例为 `0.0.69`；候选未安装，必须重新核对并行修改、升级兼容性和真实账号，不能作为正式验收结果。
- Linux 候选打包首次因 `npm pack --json` 输出超过单个进程参数长度而失败；脚本现改从临时文件读取清单，保留源码一致性校验，并在快照 `58df9c5d0789ab20f5e787fc3089ef3d478c86d5` 重新构建成功。候选版本 `0.0.36+main.58df9c5d.202611121825` 的 SHA-256 为 `d1dcadf0044ab56d820895b8a85c9a449b10efc9e9acb18aa7587ce6c3153a30`；包未安装，正式服务仍运行且健康检查返回 200。
- 后续集成快照 `3bfb85f9ae124fdbb3d94552c008189309f1ccdc` 增加授权弹窗中的账号与服务器名称；目前仅校验中英文资源 XML 和占位符，尚未编译、部署或真机验收。
- 模拟 Codex OAuth 登录完成后，后台发现会自动记录“等待运行环境”；另用可控 broker 夹具验证等待后的短时间重试、账号变更防串和状态文件不含账号明文或令牌。这不是实际 ChatGPT 登录或云端插件同步证明。
- Android MCP 授权请求增加目标、账号和会话切换后的过期结果保护，切换期间的授权结果不会重新显示在新的管理范围；工作台 21 项单元测试通过，其中包括授权请求进行中切换账号和会话。此验证使用开发者调试配置，未生成或安装正式签名包，也不能代替三星真机及实际 OAuth 验收。
- 手机回环回调转交使用真实 Windows Codex 进程和合成 OAuth/MCP 服务验证：转交后原生状态为已授权，其他账号目录仍未授权。账号绑定、状态与路径不匹配及重复提交已覆盖；真实 Google、三星、不同平台和网络异常仍需验收。
- Android 集成候选源码 `a58dae6994ced9ca2b90d07fbe5a64cafca90284` 基于主线 `d9c515d9e6930f6875750412b3290938b07d818b`，其受版本控制的 1,152 个 Android 文件已按 Git 文本换行规则核对。APK SHA-256 为 `D2C7CA2CE930C8A4EECEA0D3F81289D5468106D264FD3AE9FA1444D59858BFC5`，显示名 Ragent，签名与当时三星已安装包一致；22 项工作台测试通过，包含手机返回地址防重复提交。该包尚未安装，不代表真实设备或服务验收完成，也未包含并行开发中尚未固定的改动。
- Mac 阶段包使用主线 `02abeeab6524a20b70e017c1c7b06b4e436fcfff` 与能力改动合成的固定源码 `1546707d64ef6ef8320183333dd6ec6bd2230b47` 构建；只读挂载检查确认外层应用名 `Ragent.app`、`CFBundleName=Ragent`、版本 `0.3.20`，签名结构验证通过，DMG SHA-256 为 `3be231ce0ebe83639800e184631b5e0d39785080c47796679ea4170f0f7cf04f`。该开发包未经公证，尚未安装；现有 `/Applications/Ragent.app` 为 0.3.19、健康检查 200。构建日志残留的旧产品名已在工作区脚本修正，未包含在此阶段包内。
- Linux 阶段包源码 `afc017e101ec966a8e60577fcc472bd671240471` 以 `1546707d64ef6ef8320183333dd6ec6bd2230b47` 为基础，仅额外修正 `npm pack` 清单过长问题。包名和桌面名称为 Ragent，版本 `0.0.36+main.afc017e1.202611121930`，SHA-256 为 `b0b3dfab2ded79b8fa01383489d3663316faf48c7202773e9215f1bf9fa2db3f`，已检查能力管理文件存在；未安装，旧 `agentoc` 0.0.35 服务仍健康。现有旧包的卸载脚本缺少改名迁移保护，会停止 Run slice；新包升级检查允许独立运行的任务继续，不能保证与旧脚本的行为一致。必须解决这一迁移时序并验证后才能升级现有实例。
- Linux 后续候选源码 `7829fc4799f43e728c37720ff9b32f2e1c49fba5` 增加旧卸载脚本兼容：缺少改名保护时，先启用禁止新 Run 的重启排空并要求所有现有 Run 结束；带保护的脚本沿用允许独立 Run 的升级排空。Linux 上的 dpkg 容器测试覆盖两种分支及用户数据保留。新 `ragent` 包版本 `0.0.36+main.7829fc47.202611121947`、SHA-256 `6d96996ae3403c0d63ee12e6be86e5b3f6913f05edbbd7453e7b66d248276420`，包内已确认包含新检查；尚未安装到现有服务或完成真实升级验收。
- Windows 阶段 MSI 使用固定源码 `1546707d64ef6ef8320183333dd6ec6bd2230b47` 构建，产品名和厂商为 Ragent、版本 `0.0.73`，SHA-256 为 `8ba69262614aad563a05ac19c60e0dfb8508e877c040bcb0b05d5b97f41914dc`。构建完成并通过运行时载荷扫描；该开发包未签名、未安装，不能代表正式实例或手机端验收。构建时 Android 和 Electron 缓存、临时文件位于 G 盘。
- Windows 正式实例真实 Codex 会话 `5a5a295ef93043e3752af189555b940d` 使用 `mine` 账号完成 Google Drive 验收：运行 `run_e11f6d9bbad431a0cb9a5fc5` 的原生工具返回 [根目录文件夹](https://drive.google.com/drive/folders/1MZvPi280qsg7W-dFCmmCF4C7QvRq0Jcm) 和 [文档](https://docs.google.com/document/d/1aagwm95lTxvqNPwEoY3xUW5xbyunZJwKy342SuG3qAU)，随后工具读取结果的 `parent_ids` 与该文件夹 ID 一致，内容为 `Ragent Codex Google Drive 连接验收`。首次在自主模式下创建被拒绝；将本次验收会话切到请求审批后，按单次请求批准文件夹创建、移动新文档及写入内容。审批卡当时未显示 MCP 请求细节，属于待部署修复；此成功仅证明现有 Windows Codex App 连接与实际读写，并不证明 Plugin 安装同步、其他主机或三星端通过。
- Windows/Linux/Mac 新版部署和三星真机的最终端到端验收均尚未完成。

参考：[Codex App Server](https://developers.openai.com/codex/app-server)、[Codex 配置参考](https://developers.openai.com/codex/config-reference)、[OpenAI Plugins 文档](https://developers.openai.com/plugins/build/plugins)、[Tool search 协议](https://developers.openai.com/api/docs/guides/tools-tool-search)。

### Cross-platform 0.0.1 release preparation

The public Windows, macOS and Linux release version is **0.0.1**. Build the macOS and Linux release candidates from the same reviewed, committed source as Windows by dispatching `posix-package-build.yml` with `release_version=0.0.1`; verify the resulting `ragent_0.0.1-darwin-arm64.dmg` and `ragent_0.0.1_amd64.deb`, their embedded version, source identity and SHA-256 before attaching them to the release. Earlier development candidates use higher versions and must not be presented as these release artifacts.

Before publication, install and exercise both release candidates on the actual target systems, including migration from any existing development installations. In particular, the current Linux development installation reports agentoc 0.0.35. The isolated Debian rename fixture now verifies takeover by ragent 0.0.1 while preserving configuration and owner data and blocking unsafe active runs; the actual machine migration and service operation still require verification. An existing ragent installation with a higher package version is a separate downgrade case and must not be assumed to upgrade normally. The macOS development candidate was ad-hoc signed and is not notarized; verify the intended distribution signing and notarization before claiming public release readiness. Android device verification and the final integrated source snapshot also remain outstanding.

Current acceptance checkpoint: the Android debug application and instrumentation APK both assemble successfully after adapting `AppApiRuntimeGraphTest` to the named storage-disposal parameter. This is a build result, not a Samsung device pass. On the target Mac, `security find-identity -v -p codesigning` returned zero valid identities; `notarytool` is installed. A Developer ID signing identity and notarization credentials will be needed for a signed and notarized public macOS release if that distribution mode is required. The existing ad-hoc candidate does not satisfy that condition.

The POSIX candidate workflow now defaults to 0.0.1 and checks the Debian package name, embedded version and architecture, plus the mounted macOS app name, embedded public version and signature structure. The workflow YAML and extracted shell syntax were checked locally. The same metadata-check commands were exercised against existing development candidates on Linux and Mac; those candidates have older development versions and are not 0.0.1 release artifacts. Signature structure verification alone is not Developer ID signing or notarization.

2026-11-12: fixed integration snapshot `e1c5b01ae0447e0f551c7ce1a70c55470226a16c` (base `4c10219b61e407a13ab9cabb0042ea020b059dcf`) was staged from Git objects, and its 1,430-file desktop runtime payload passed the secret/integrity scan. After resolving the account-home preparation merge using the current shared implementation, Linux and macOS 0.0.1 development candidates were built from this same snapshot with Node 24.12.0. Linux `/var/tmp/ragent-capability-e1c5b01/out-node24/ragent_0.0.1_amd64.deb` SHA-256 `b2832233e3d9cb6524b287e2565282cbcfc46940abca455790f83bd2afd68494`; package metadata and embedded source commit were verified. macOS `/private/tmp/ragent-capability-e1c5b01/out/ragent_0.0.1-darwin-arm64.dmg` SHA-256 `ff731d8f2d90fee8a27b0b8b1c89ffe879ce2f5e62f05e776173ac073427b003`; mounted application is Ragent 0.0.1, embedded commit matches, and ad-hoc signature structure verifies. Neither package has been installed or validated against real accounts. Other ongoing work is not fully captured by this snapshot; it is not a final release build. macOS is not notarized. A first Linux candidate built under Node 22 is superseded by the Node 24 candidate and is not for release.

On both Linux and macOS, the exact `e1c5b01ae0447e0f551c7ce1a70c55470226a16c` payload passed the five stage checks for Codex provider-home routing, capability sync, native provider runtime, app-server approval adaptation and MCP OAuth; Mac used the installed app's Node 24 and packaged harness path. These checks use fixtures and temporary state, not the actual installed application or a live Google account. The initial Mac test stream was interrupted by Windows console GBK encoding; it was rerun successfully with UTF-8 output.

The same five fixture-based checks were also run on Windows from the staged `e1c5b01ae0447e0f551c7ce1a70c55470226a16c` source, all passing. During concurrent development another task installed a newer Android integration APK to the Samsung; capability management itself still requires device acceptance and the currently installed host source must be identified before drawing conclusions.

Android 320dp × 720dp, 1.3× font-scale Chinese Compose preview rendered successfully and was visually inspected: the MCP action, long account name, authorization state and account selector wrap within the viewport, with additional cards available by scrolling. This is a host-rendered preview, not a Samsung touch/accessibility test.

Android MCP OAuth lifecycle: switching accounts or sessions now cancels a known pending authorization on its original target; a late start response is also cancelled when the target is unchanged. If the target changed, the client does not send the old job's cancellation to the new host. The workbench ViewModel suite passed 24 tests, including pending and in-flight account/session switches and the cross-target guard. This change is not yet in the currently installed Samsung APK and still requires device acceptance.

The previous Android build used the contributor variant (`com.agentoncloud.android.opensource`) and a contributor key; it cannot update the Samsung's installed Ragent application and was not installed. A build using the established Ragent package ID, Firebase configuration and matching debug signing key is in progress; package identity and certificate must be checked before any device installation.

The Ragent (not contributor) Android debug app and instrumentation APK built successfully using the established signing key and existing Firebase configuration. App candidate: `G:/AgentoC/_qa/codex-capabilities-ui/ragent-capability-oauth-cleanup-debug.apk`, package `com.agentoncloud.android`, public version 0.0.1, SHA-256 `5FD2CA70A977E2410B27EE8388B672B983C926DCD8876896E89AE3D70A686442`; signer SHA-256 `258e3d0c7ad1bf68b5f519ad0c4258e3d42a38b93def21fe943c82bf85e1250c`. Instrumentation APK SHA-256 `E35CE7ED271BFEDF46C66CD6CD307FC2CFDCEB2C11B83D865EE69E2D58630A28`. The APK was built from the shared working tree while parallel work continued, so it requires source-drift verification before installation and is not a final release candidate. It has not been installed or run on the Samsung.

Read-only check of the actual Mac Ragent `/api/native-providers` returned one enabled Claude API-key provider and no Codex provider. A real Codex account login on the existing Mac instance is therefore still required before Mac account and capability acceptance. No credentials or account identifiers were printed or copied.

Samsung debug APK provenance check: its instrumentation package is `com.agentoncloud.android.test` and is signed by the same `258e3d0c...` certificate as the app. A file timestamp scan found no files under the current Android/shared source trees modified after the Ragent debug build directory was created at 20:58:30 (excluding build/cache directories); this is useful drift evidence but not an immutable source manifest. The device remained in use by the parallel cross-platform test, so no installation was attempted.

A read-only check of the current Windows installed payload found none of `chat/codex-capability-sync.mjs`, `chat/codex-mcp-oauth.mjs`, `chat/codex-plugin-restart.mjs` or `chat/codex-skill-management.mjs`. The service was healthy, but the current installed build therefore cannot yet support the new management flow; it must receive an integrated package before phone-to-host acceptance.

Integration snapshot `5c899323a11f5ed0a302d531b5c7327e7abd72f9` merges the capability changes and latest Android authorization cleanup onto main `792999aeab576cf02f56eb6c0ad170cd8f3fb079`, which includes the newer Codex adapter changes and descends from the installed Windows package source `337b1eefd19b69cc862cd99a0f30b92371f1f7d8`. Its 1,439-file runtime payload passed integrity scanning and the five Windows fixture checks for provider-home routing, capability sync, native provider runtime, approval adaptation and MCP OAuth. The snapshot does not include all parallel uncommitted changes and is not yet an installation candidate; it has not been deployed or tested against Codex 0.167.2 with a real account.

Windows 0.0.1 development candidate `G:/AgentoC/_qa/ragent-capability-95093-0.0.1-windows-x64.msi` built from fixed snapshot `95093a6a7d303ab992af22bceb19580c35ee3e8c` based on main `14aad4812cd2fc742eaf30686a45bf18a431e9bf`. SHA-256 `7ff7d658193a336bc97f96c19d5b65b5f367ef7f4befa9b270d752196a83f5f3`; build metadata records public 0.0.1, MSI internal ProductVersion 0.0.77; ProductName and Manufacturer are Ragent, and runtime scan passed. The MSI is a development candidate, not installed or release-signed. The current Windows payload includes uncommitted parallel attachment changes not all represented by this snapshot; compare and integrate those before installing, and recheck the installed MSI product version immediately before any upgrade.

A Windows installed-payload audit found two modified manifest files (`chat/router-control-routes.mjs`, `chat/file-asset-relay-jobs.mjs`) and one additional application file (`chat/file-asset-timing.mjs`). These installed changes were merged into integration snapshot `0788434917da234cdf5b42a31e4ae8f2c5a9cc1d`; a conflict in quota completion was resolved by preserving both workspace-account scoping and attachment timing. The combined upload-intent, timing, quota retry, Codex approval adapter and MCP OAuth fixture checks passed. The first test run lacked a staged dependency; it was rerun successfully using a junction to the installed node_modules after package lock hashes matched. Automatic approval review rejected deletion of that temporary junction with reason `blocked by policy`; the junction remains and no installed data was removed. The installed files were rechecked unchanged before packaging.

The merged tree was combined with current main `366922cebda1130fa40350d634ce0af070b8d22d` as snapshot `c031238d4b84a4978868a277f2a2170c3c1a5f7b`. Windows candidate `G:/AgentoC/_qa/ragent-capability-c031-0.0.1-windows-x64.msi` has SHA-256 `8cba01809a0d18dd2c753c03554686aa89756b6f6ee3925b39571b29fd65d75f`, public build metadata 0.0.1, internal MSI ProductVersion 0.0.77, and Ragent product/manufacturer. Runtime payload scan passed. The candidate has not been installed or release-signed; later parallel changes and live service state must be checked again before installation.

Mac's existing Ragent instance started a native Codex device authorization job (`a0375a01-2e10-4207-be6b-db2633386084`) and reached `awaiting-device-auth`; owner action is pending. No tokens were copied or displayed. The Samsung candidate's DEX was inspected and contains the new OAuth cleanup method; its instrumentation APK contains the long approval-detail test. These checks establish package contents only, not installed-device behavior.

On the actual Mac Ragent 0.3.19 instance, native Codex device login job `a0375a01-2e10-4207-be6b-db2633386084` completed and `/api/native-providers` showed one Codex OAuth provider. A real task in session `51aefde38a05368b355279ad8c1b459d`, run `run_034c7d22e194f88dd7789d42`, completed with exact reply `RAGENT_MAC_CODEX_OK` using the account's listed `gpt-6-astra` model. Before that, a request without a model failed with provider preparation reason `model-missing`; a second request using the listed `gpt-5.4-mini` failed because that model was unavailable for the ChatGPT account. The installed instance capability catalog returned five skills and one MCP item but no Google Drive entry; this is not proof of the account's cloud capabilities, nor a pass for new management features. No credentials were copied.

On the existing Mac service, a read-only real Codex Run `run_746b3c23a0fe9a6dc508c8b8` was asked to find the previously created Google Drive acceptance folder using only a native Drive tool. The Run completed but the assistant reported that the native Google Drive tool was unavailable. The isolated test session was set to recommended approval mode; no file writes were requested. This does not establish why the App is unavailable and does not pass Mac Drive acceptance. The latest capability manager is still not deployed to that Mac instance.

Read-only inspection of the recently written managed Codex configuration on the actual Mac instance showed `[features] plugins = false`. This is a concrete native-plugin loading restriction in the installed build; it may affect plugin availability, but it does not by itself prove why the Google Drive App was unavailable or that enabling it would authorize Drive. The new account-scoped plugin preference remains to be deployed and tested on this actual provider.

Further read-only Mac diagnosis connected to the existing provider broker for the recently active managed Codex home, without starting another OAuth owner or copying credentials. `skills/list` returned successfully, while `app/list` and `app/installed` each timed out. The installed old client only implements skill/plugin/MCP catalog queries; the result does not distinguish old broker routing from upstream behavior and does not prove the account lacks Drive. Recheck with the newly integrated broker before concluding cloud discovery is unsupported.

A second read-only query through the same existing Mac provider broker called `app/list` with `forceRefetch=false` and returned the upstream error `failed to list apps: Failed to send request`; it did not return an empty App list. The earlier forced `app/list` and `app/installed` calls timed out, while `skills/list` succeeded. The actual network/account cause remains undetermined.

A read-only Samsung UI-tree inspection showed another active release/approval QA session on screen, so no installation, navigation or instrumentation was performed. Continue once that device use has ended, rechecking the installed APK and current source first.

Integrated Android source snapshot `07f3627b460147f509cd2cf83c1262e58c216e84` merges capability snapshot `c031238d4b84a4978868a277f2a2170c3c1a5f7b` with committed main `bdf22bc6`; this includes the subsequently committed attachment pipeline and model picker changes. It is a Git-object snapshot with a sparse source checkout, not a modification to the shared branch. A correctly branded, established-key debug APK and instrumentation APK are being built from it; the Samsung was still displaying another active approval QA session, so no device installation or interactions were performed. Commits and uncommitted changes made in parallel after the snapshot require integration review before release.

Integrated build snapshot `90e3eec95da1d42c1134e35e08a3af1ebd64b419` merges committed main through `3cbbbe7c` with capability changes and adds the Windows tray icon to the frozen build input list. The initial Windows build failed because `desktop/stage-windows.mjs` required `static/icon-512.png` but the immutable input manifest omitted it; the input list was corrected and the Windows MSI subsequently built successfully. Windows public build version 0.0.1, internal MSI product version 0.0.78; candidate SHA-256 `FC6076AD68063F9A1185EA2009DA039C4B4F63645DC21D0A9B31CACDAA8BAB2A`. Linux amd64 DEB and Mac arm64 DMG were built from the same snapshot at public version 0.0.1; Mac uses ad-hoc signing and is not notarized. These are development candidates, not published releases, and do not incorporate parallel uncommitted work.

Android source snapshot `07f3627b460147f509cd2cf83c1262e58c216e84` has the same Android tree as desktop snapshot `90e3eec95da1d42c1134e35e08a3af1ebd64b419`; debug and instrumentation APKs built successfully. The app package is `com.agentoncloud.android`, version 0.0.1, SHA-256 `B4D76876BC6ED9E6678D9468A73FABA100EF8835AB8A5982E1ADBDA1B52828B3`, signed by the existing device-compatible debug certificate `258e3d0c7ad1bf68b5f519ad0c4258e3d42a38b93def21fe943c82bf85e1250c`. No installation or real-device capability test has been performed with this APK.

A parallel Linux security acceptance reported that dangerous deletion bypassed approval under Codex 0.164.0, including newer source at commit `2f775bc1`. That report is not evidence of behavior on the 0.167.2 candidates; it is a release safety issue requiring investigation and integrated remediation before release and full acceptance. Preserve ongoing parallel work and avoid interrupting the current phone and service tests.

Consolidated candidate `c9ba219205eaf987c84e6b2c5f9b92cfa225ee17` has the same tree as integration snapshot `ff43de927a711ff86cbba3584e26bdf20ceadc50`, based on main `36353939fa5f19480805a3b326ea503a4cba8b2e`, plus capability work. It includes bounded retries when a ready Codex broker reports partial App/MCP discovery, so a transient App catalog failure does not immediately stop automatic discovery. The corresponding regression case is written and reserved for stage/final validation per owner instruction. Windows MSI, Linux amd64 DEB and Mac arm64 DMG version 0.0.1 built successfully from this exact source; Mac remains ad-hoc signed and unnotarized. Android source is unchanged relative to built snapshot `07f3627b460147f509cd2cf83c1262e58c216e84`. Later committed or uncommitted parallel work is not included and must be assessed before deployment. The Linux pre-existing package upgrade process PID 504737 remains live, and other work is actively upgrading the Windows managed Codex environment; neither was interrupted.

Integration snapshot `2b23fe48ee9e91cf99bf040c180b98425d3706b0` merges committed main `e93e56d8e8c44991469bc84bff35ec4f6955ceb7` with the capability snapshot. A conflict in `run-provider-prepare.mjs` was resolved by preserving the capability imports alongside the later read-only OAuth home logic. Frozen build commit `b4c1a8914186d87e345a5b4007f662d2a1e866fa` contains the identical tree. The Windows 0.0.1 MSI and Linux 0.0.1 amd64 DEB built from it; the Mac arm64 DMG build is ongoing. Mac's direct connection to the Node.js official checksum file was reset; the same official `v24.12.0/SHASUMS256.txt` was fetched on Windows and transferred to the Mac build, where the original script still compares the archive SHA-256 against that checksum. No installed instance was replaced during this packaging stage.
