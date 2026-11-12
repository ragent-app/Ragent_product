# Ragent 审批链路调整方案：Claude Code 与 Codex

> 本文保留了 11 月 10 日的原始方案和背景；后续实现、策略变化与尚未验收项目以前面的进展及“当前证据与未决项”为准。

## 2026-11-11 Windows 与三星补充进展

- Windows 审批器已支持一部分静态 Bash 管道和常见 Git 只读参数，并区分上下文不足、配置不可信、额外权限等原因；`recommended` 与 `full-auto` 继续使用同一自动放行标准。
- 2026-11-12 核对本机正式服务：运行目录 `G:\AgentoCapp\payload` 的源提交为 `44aebe1`，其审批文件与当前源码的哈希不同，不能将源码验收视为已部署。以提交 `eabe593` 构建了 G 盘安装候选，公开版本 `0.0.1`、内部 MSI 版本 `0.0.58`，EXE SHA-256 为 `385ce1617efd6588edb460a1bf53c8cb163c12fd902dc84ba3a80044cb761d00`；运行时审批文件完整性检查通过，安装候选未签名。用户指定的既有管理员通道对当前 `G:\AgentoCapp` 执行只读升级准入检查通过，数据布局为原位保留。候选相对已安装版本跨 211 个提交、279 个文件，且另有并行任务进行；尚未安装、重启或对正式服务执行升级后验收。
- 后续从 `464412431958812317affc6122b9972e0dbddb04` 的 Git 对象直接生成 G 盘桌面运行时和 Windows 打包输入，未创建工作树；逐文件复核 1,359 个运行时文件及 9 个构建输入的 SHA-256，均与各自清单一致，载荷扫描和审批必需文件检查通过。直接载入该载荷的 Windows 审批器，两个模式均自动通过绝对路径普通筛选，并将敏感路径交风险处理。首次冒烟以没有经 Run 证明的相对工作目录调用，得到上下文未验证，改用明确绝对路径后通过。首次暂存时 `main` 被并行提交更新，暂存器按设计中止；清理该次不完整目录的请求被自动策略拒绝，目录保留，使用另一临时目录完成。可用空间约 2.3 GiB，低于近期安装包构建 4–6 GiB 的空间要求；此载荷不是 MSI/EXE，也没有部署或验证正式服务。
- 对旧版正式服务的本机历史做了只读、仅输出计数的检查：最近 92 个 Run 中，29 条 Claude 审批记录带 `windows_analysis_incomplete`。将这 29 条输入以原有 Run 风险上下文交给当前源码的 Windows 分类器及 ripgrep、默认文件和相对操作三个桥进行静态回放，3 条直接通过、1 条通过所测桥、其余 25 条未由这些路径放行；recommended 与 full-auto 的自动放行结果一致。未执行历史命令，未输出命令或文件路径；该回放没有覆盖其他专用桥和运行时交互，不能将 25 条全部断言为实际弹窗或拒绝，也不能用这一组已被拦截的样本推算总体通过率。未放行项中包含 PowerShell 管道、变量、条件和 Bash 条件语法；2 条被分类为高风险目标，需要进一步区分真实危险与误拦。
- 对上述历史做结构化分析发现，7 条 Bash 记录采用 `if true; then …; fi` 包装普通单文件 `rm -f`，内层操作通过现有目标检查。分类器现识别单条命令的恒真包装，仍独立检查实际目标；敏感目标、递归危险删除、额外分支或额外命令仍不会因包装而自动通过。后续历史回放时记录增至 34 条，其中这 7 条均在两种模式下直接通过，模式自动放行结果一致；样本随并行运行增长，不能直接与前一批计算通过率。真实 Windows Claude CLI 在隔离目录下验证两种模式均自动完成对应的普通文件删除；三星使用既有隔离测试 APK 验证危险卸载仍进入审批、手机拒绝经生产发送器返回真实 CLI（1/1）。测试使用本机模拟模型，未消耗官方额度，手机身份及传输仍为夹具。
- 另有 4 条真实历史请求是在 PowerShell 中使用 Ragent 文档提供的 `node "$env:AGENTOC_PROJECT_ROOT/cli.js" trigger list` 回退形式；原有只读桥无法识别这两个 Run 环境变量。现将严格匹配的列表和帮助调用改写为固定只读助手，并要求已核对的当前 Run/会话控制凭据；该路径不再依赖无关的特权操作通道。`trigger list` 同时接受 `--source-session` 作为 `--session` 的兼容别名，助手仍将执行范围绑定当前会话。四种回退写法在真实 Windows Claude CLI 的 recommended/full-auto 中共 8 次通过，并从隔离服务返回结果；原生命令助手、凭据续期及危险/额外参数拒绝回归通过。34 条历史的静态回放中这 4 条均由只读桥放行，两个模式一致；回放根据历史记录中存在会话通道推定其可用，真实启动仍会逐字段核验凭据。三星危险审批拒绝回传另通过 1/1；其设备包和网络身份仍为隔离夹具。以上均未使用官方模型额度。
- 三条旧版 Claude Bash 审批是调用 `agentoc api POST` 向当前会话登记生成文件；它们使用当前会话变量、字面量 JSON 和普通绝对文件路径。Windows 现将符合条件的调用改写为固定的非提权助手，助手从 Run 会话凭据重建当前会话地址，并清除 Node 启动钩子；普通工作区外文件也适用。额外 API 参数、其他会话、未知字段、相对或受保护路径、计划模式与缺少绑定的凭据不走此入口。三条历史记录的静态重放在两个模式下均匹配，重放仅根据历史清单推定通道可用，不能证明旧请求实际执行；真实运行仍检查凭据和文件。Windows 真实 Claude 用隔离工作区外文件、本机模拟模型和模拟会话服务，验证三种历史命令写法在两种模式下共 6 次自动执行并返回结果；会话能力和固定助手的边界测试通过，三星危险操作拒绝回传 1/1 通过。模拟服务未验收正式服务的资产存储及手机文件显示；未使用真实模型额度。第一次原生测试因 G 盘空间不足失败，空间回升后通过；首次真实客户端夹具尝试创建硬链接被系统拒绝，改用隔离副本后通过。
- Windows Git 分类现支持常见的字面量 `git log --format=...` / `--pretty=format:...` 输出格式，例如 `git log -1 --format='%h %s'`。真实 Claude CLI 和 Codex App Server 分别在 recommended 与 full-auto 下触发审批回调、自动放行并返回隔离仓库的提交结果；模型服务为本机模拟端点，没有使用官方额度。Bash、PowerShell 和 Git 分类回归通过；其他未知选项仍由原有风险流程处理。
- Claude 已支持按实际工具参数自动处理 `TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate`，包括任务状态和依赖变更；这类操作管理 Claude 的任务列表。输入不完整、含未知字段或附带额外权限仍按原有流程处理。使用本机真实 Claude CLI、隔离任务列表和本机模拟模型，分别强制这四类工具触发审批回调，recommended 与 full-auto 八种组合均自动通过并返回成功结果；读取、更新测试先创建任务再操作其实际 ID。该结果不代表真实负载频率，也未验证其他 Claude 版本的未来参数。
- 该策略变更后，在三星 SM-S9060 使用先前构建的隔离 workbench 测试 APK 重跑真实 Windows Claude 危险请求回传：1/1 通过，手机拒绝经实际提交路由及生产 `flushClaudeBidiApprovalResponses` 回到 CLI；本机模拟模型收到工具结果。测试 APK 构建时间早于本次策略变更，Windows 审批代码为变更后的当前源码；owner 身份、网络承载及发送调度仍由夹具驱动。测试后移除了临时测试包和 USB 端口映射，正式手机应用保留。首次尝试重新构建时因 G 盘空间降至约 485 MiB 主动中止，随后改用现有 APK 完成测试。
- 2026-11-12 在本机 Windows 重跑 `test-windows-approval-gate.mjs`、`test-windows-bash-actions.mjs`、`test-windows-powershell-actions.mjs` 和 `test-windows-sidecar-approval-live.mjs`，四项均通过，最后一项覆盖 Claude 和 Codex 的 sidecar 决策。这些是本地回归，不能代表真实生产工作负载的审批频率；执行期间共享工作区另有并行修改。
- 同日用真实 Windows Claude CLI、Run 准入生成的风险上下文和本机模拟模型复验：`rg -n SEARCH_TOKEN .` 在 recommended 和 full-auto 都经审批回调自动通过，测试敏感内容未返回；危险卸载命令在 recommended 进入人工队列并由夹具拒绝，在 full-auto 自动拒绝。四次均通过，未调用官方模型。首次把实例控制目录放在被搜索的项目内，触发受保护目录判断并等待人工回复；调整夹具，将实例目录置于项目外后才得到上述结果。受保护目录位于搜索范围内的情形不包含在这次通过结果中。
- 本机发现 ripgrep 配置可以改变默认搜索范围或运行预处理器。对于受支持的绝对路径搜索，托管桥接会先禁用隐式配置，再重新通过风险门；真实 Windows Codex App Server 使用本地模拟模型服务验证了两种档位，未使用官方账号额度。Codex Hook 的相对路径搜索仍缺少可靠的实际工作目录；Claude 的受支持相对路径搜索现已使用运行时目录校验。
- 三星 SM-S9060、Android 16 上，审批界面和事件重放合计 18 项全部通过。该测试使用设备上的合成数据，不能证明手机经真实服务提交审批的链路已经通过。
- 2026-11-12 再次用同一三星和已有隔离测试 APK，连接当前 Windows 审批分类和队列：Claude 危险请求拒绝回传 1/1 通过，Codex 同组两个请求的一次拒绝回传 1/1 通过。两次使用本机 HTTP 测试适配器和 USB 反向端口，未调用真实账号；测试后已移除测试包和端口映射。
- 同日对后续提交重新运行三星与 Windows 本地适配器链路：`ApprovalWindowsBridgeDeviceTest` 实机 1 项通过、0 失败、0 跳过，测试断言手机拒绝已进入 Windows 队列。首次构建因原签名文件缺失失败，改用项目支持的隔离开源调试配置和 G 盘已有测试签名后通过；临时端口映射已移除。此测试仍不覆盖正式服务认证、配对或真实模型提供商。
- 随后把上述测试的审批提交从模拟处理替换为源码中的 `handleSessionMainRoutes` 实际 HTTP 路由。三星分别对 Claude 危险请求和同组两个 Codex 请求执行拒绝：两次设备测试均 1 项通过、0 跳过；路由返回 202，Windows 队列分别收到一个和两个拒绝。事件内容和 owner 身份仍由本地夹具注入，不覆盖正式服务的身份认证、配对、网络传输或真实 provider 接收响应；USB 反向端口已移除。
- 再次扩展上述三星测试：将隔离 provider 请求写入真实 Run spool，经真实历史投影和事件读取路由供手机读取，手机决定再经过真实提交路由。Claude 单请求及 Codex 双请求合并各在三星通过 1/1、0 跳过，队列分别收到一个及两个拒绝。provider 请求和 owner 身份仍是测试输入，HTTP 承载是本机夹具；未覆盖真实登录、配对及 provider 接收响应。实际投影事件没有先前夹具手填的 explanation 字段，设备断言已改为验证真实命令目标；其他解释字段测试仍独立保留。
- 同日新增三星与真实 Windows Claude CLI 的隔离联动：CLI 从本机模拟模型获得针对不存在测试包的卸载请求，Ragent 将实际控制请求投影给三星；手机拒绝经实际提交路由进入队列，测试适配器按 Claude 控制协议把该队列决定转发给 CLI，CLI 随后向本地模拟模型返回工具结果。三星 1/1、0 跳过，CLI 退出成功，未使用真实账号额度或执行卸载。该测试的 owner 身份和网络承载仍由测试注入，队列到 CLI 的最后发送由测试适配器执行，尚不能证明正式服务的认证、配对和生产发送器已端到端通过。
- 随后将上项测试的最后转发替换为生产 `flushClaudeBidiApprovalResponses`，三星再次通过 1/1、0 跳过；队列记录被标记为已发送，CLI 接收拒绝并返回工具结果。对同一队列重复调用发送函数验证仅发送一次。身份与网络承载仍为隔离夹具，调用生产发送函数由测试驱动，未验证正式服务的认证、配对和自动轮询调度。
- 同样使用三星、真实 Windows Codex App Server 和本机模拟模型验证单个危险请求：真实请求经 Run 投影与事件路由到手机，手机拒绝经生产提交路由、队列和 `flushCodexAppServerApprovalResponses` 送回 CLI；重复扫描只发送一次，CLI 继续到下一次本地模型请求并完成。设备测试 1/1、0 跳过，未消耗官方模型额度。身份、网络承载和发送函数调度仍由隔离测试驱动；此前的双请求合并手机测试使用模拟 provider 请求。
- 使用 USB 反向端口、本机测试 HTTP 适配器和真实 Windows 审批分类及响应队列，三星点击拒绝后成功在 Windows 队列生成一条对应的 `deny`。首轮测试夹具误把内部决策名称写成 `decline` 导致断言失败，修正夹具后复测通过。该测试未覆盖正式服务的身份认证、配对、网络传输及 provider 收到响应；执行时共享工作区包含其他任务的未提交修改。
- 同一 Codex 轮次内，工作目录、命令、其他请求字段和风险判定均一致的危险或未知命令请求，可以复用已写入历史的审批卡；用户决定在 Run 锁内分别排入每个原始请求的响应队列。不同轮次、目录、权限授予及决定后才到达的请求保持独立。三星通过本机测试通道点击一次拒绝，Windows 对两个实际 Codex 请求分别排入拒绝；本机测试还覆盖跨刷新、并发决定及终态回放。该范围不包括 Claude 请求或网络授权合并。
- [OpenAI 官方 App Server 文档](https://developers.openai.com/codex/app-server/)说明 Codex 对并发网络审批按目标主机、协议和端口聚合，但客户端当前网络审批上下文只公开主机与协议。本机 Codex 生成的实验协议类型也只有 `host` 和 `protocol`，无法据此证明端口一致；Ragent 不在客户端按主机盲目合并不同网络授权，已支持的上游聚合由 Codex 处理。文档所述行为尚需按实际安装版本验证。
- 三星事件重放中，没有 `riskCode` 的合成事件最初在目标摘要断言处失败。界面现对含操作信息的解释显示本地化目标摘要；修复后原失败输入和新增用例均在三星上通过。失败记录保留在 G 盘任务目录。
- 对真实本地 Codex Hook 的工作目录试验表明：请求指定另一工作目录时，Hook 事件只暴露会话目录和命令，不暴露该工作目录。因此不能把 Hook 的会话目录当作相对路径的实际执行目录。
- Claude 不同请求 ID 的同轮同命令合并已覆盖部分情形（见下）；网络授权合并、完整手机到正式 Windows 服务往返、代表性工作负载的审批频率及 Linux/macOS 原生验收仍待完成。不能据此声称达到 99% 自动通过。

日期：2026-11-10  
状态：Codex 全平台 Run 级项目 trust gate、POSIX 风险决策和请求幂等已实现；Windows Codex 0.167.0 离线 App Server 验收通过；Android OAuth/E2E 与生产服务部署验收待完成

## 结论

现在的审批请求过多，不宜简单归因于“自动审批器坏了”。Ragent 已有自动决策和自动响应路径；问题主要在于 Harness 是否会把动作送到该路径、Ragent 能否识别请求，以及识别失败时的保守回退。Claude Code 与 Codex 的权限协议不同，不能用一个 Harness 档位名假定它们会产生相同的审批事件。

Codex 0.149 起不再支持显式 `approvalPolicy="untrusted"`。Ragent 在受控 Run 的私有 App Server 进程上只注入该 Run 的 `trust_level="untrusted"`，并在 `thread/start`、`thread/resume`、`thread/fork`、`turn/start` 中省略 `approvalPolicy`。此入口现用于 Windows、Linux 与 macOS 的 Ragent 审批档位。Codex 会从不信任项目派生严格审批策略：命令逐条请求审批，执行策略明确允许的命令除外。启动响应仍须确认有效策略为 `untrusted`、reviewer 为 `user`、sandbox、cwd 和 workspace root 均匹配，否则 prompt 前停止。

Codex OAuth App Server broker 按账号共享，不能为单个 Run 绑定独占的项目 trust；受控 Run 因此使用私有 App Server，并沿用现有 OAuth 锁避免并发刷新同一凭据。代价是受控 Run 会串行占用 Codex OAuth 执行通道。经本机验证，`thread/start.config.projects` 不会改变有效审批策略，不能替代进程级项目配置。

Codex 的 `approvalsReviewer="user"` 只表示把已产生的审批请求交给用户；它不会制造请求，也不会自动批准。改成 Codex 的 `auto_review` 会把决定权交给 Codex reviewer，而不是 Ragent 审批器，不应作为本问题的默认修复。

## 当前链路与问题定位

| 层 | Claude Code | Codex App Server |
|---|---|---|
| Harness 请求 | 双向协议的 `can_use_tool`，受控档位会逐工具调用进入审批回调 | JSON-RPC 请求：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、MCP elicitation 等；只有 Codex 判定需要审批时才会发出 |
| Ragent 自动处理 | `trackClaudeBidiApprovalRequest` 后进入共享风险门与 Windows 专用门 | `trackCodexAppServerApprovalRequest` 后进入 POSIX 共享风险门或 Windows 专用门 |
| 自动决策结果 | 安全请求在协议回调内自动批准；风险、能力授权或未知形状进入用户流程 | 安全请求通过 JSON-RPC `accept` 自动应答；全自动档位对不能自动批准的请求自动拒绝；其他需人工决策的记录进入 Ragent 审批界面 |
| 主要差异 | 默认权限回调可覆盖普通工具调用 | `on-request` 不是逐工具回调，只对 Codex 已决定需要升级审批的动作发请求 |

当前代码可从这些位置追踪：

- `chat/provider-contract.mjs`：产品风险档位到 Harness 权限模式的映射。
- `chat/codex-app-server-protocol.mjs`：Codex `thread/start` 与 `turn/start` 的审批和 sandbox 字段。
- `chat/runner-sidecar.mjs`：Codex/Claude 审批请求拦截、自动响应与待审批记录。
- `chat/windows-approval-gate.mjs`：Windows 命令与文件变更分析。
- `chat/privileged-gate.mjs`、`chat/risk-classifier.mjs`：Linux 审批器中可复用的通用风险分类与决策语义。

### 当前 Codex 档位映射

| Ragent 档位 | Codex Windows Harness | Codex 非 Windows Harness | 结果与限制 |
|---|---|---|---|
| safe / recommended | Run 级项目 trust `untrusted`（省略 `approvalPolicy`）+ profile sandbox，`approvalsReviewer=user` | 同 Windows：Run 级项目 trust gate + profile sandbox，`approvalsReviewer=user` | 两个平台都先把 Codex 审批请求交给 Ragent 分类；安全请求自动答复，危险、能力授权与未知形状进入 owner 流程。执行策略明确允许的命令可能不会产生审批事件 |
| full-auto | Run 级项目 trust `untrusted` + profile sandbox；安全/谨慎请求自动答复，危险或越界请求自动拒绝 | 同 Windows | POSIX 使用共享风险分类，Windows 使用 PowerShell/路径分类；两个平台都不等待 owner。Codex 自身明确 allow 的请求仍可能不会进入 Ragent |
| conservative-auto | Run 级项目 trust `untrusted` + `workspace-write`、关闭网络 | 同 Windows | 只自动答复可证明的安全请求；谨慎、危险、越界和额外能力请求无人值守拒绝，并记录原因 |

此处 `danger-full-access`、`workspace-write` 是 Harness sandbox，不等于 Ragent 的风险档位。Ragent 不应把 `approvalPolicy=never` 或绕过审批作为消除提示的办法；这样会让危险操作绕过审批事件入口。

### 为什么 Codex 仍可能产生多张人工审批卡

1. **请求触发面不同。** `on-request` 只覆盖 Codex 要求升级权限的动作，不会保证普通命令进入 Ragent 分类器。Run 级项目 trust gate 会把需要审批的命令送进 Ragent；执行策略明确允许的命令仍可不发请求。0.147 的 `git status` 实测无 owner 卡，只能证明没有用户提示，不能证明是 Ragent 自动答复。新版官方语义仍是“不信任项目命令逐条审批，显式 exec-policy allow 除外”。
2. **Windows 分类覆盖不足会制造误审批。** Codex App Server 的 Windows 请求使用规范 PowerShell 可执行文件和静态 `-Command`，但不带 `-NoProfile`；旧规则因此把每条这类命令都送去审批。Windows 也缺少常见 `rg` 搜索和工作区测试/构建任务的规则。当前调整允许该 Codex 协议形状进入 AST 分析，并将受限 `rg` 与常用工作区任务列为谨慎级；recommended/full-auto 对谨慎级自动放行，safe 仍可要求用户审批。非递归目录枚举只返回名称/元数据，也不再因命中系统或 Ragent 保护根而自动升级。未知 shell、路径/Run 上下文缺失、额外权限、敏感文件内容、递归敏感扫描、动态执行、危险写删和未知工具仍保留审批边界。
3. **执行策略可能绕过 Ragent 入口。** 即使项目 trust 是 `untrusted`，Codex 执行策略允许的命令也不会触发审批事件。Ragent 必须区分“Codex 没有发事件”和“Ragent 自动答复”；不能仅凭零张 owner 卡判断自动审批器工作正常。对已允许命令应审计来源与规则，确保允许项来自经过审查的策略。
4. **有些请求应保留人工确认。** `item/permissions/requestApproval`、MCP elicitation、额外文件系统/网络权限及信息不完整的文件变更仍需单独判断。Codex 普通文件的删除和移动现按实际目标分析，敏感目标和危险删除仍需审批或自动拒绝。
5. **受控安装 Hook 仍按命令本身分类。** App Server 缺少 `-NoProfile` 不再单独阻断其规范 PowerShell argv 的分析。Hook 改写后的安装命令仍不在自动放行的工作区任务范围内，继续要求用户审批。荣耀手机最近一次 Codex Official Account 只读运行在执行命令前报 refresh token 已使用，未到审批阶段。

## 调整目标

让 Ragent 风险档位决定“哪些动作自动放行、哪些动作需要用户、无人值守时如何拒绝”；让 Codex sandbox 继续限制进程可触达的范围；让所有应进入 Ragent 决策的动作都能被同一套策略识别。提示卡必须给出明确原因，并且同一请求的重放不能产生重复卡片。

## 完整调整方案

### 1. 用 Run 级项目 trust 替代已退役的显式审批枚举

Windows、Linux、macOS 上 `safe`、`recommended`、`full-auto`、`conservative-auto` 以及显式选择 `untrusted-*` 权限模式的 Run，都在私有 App Server 进程参数中加入 `projects={"<cwd>"={trust_level="untrusted"}}`。不写用户全局 `config.toml`，不改项目配置，也不发送 `approvalPolicy="untrusted"`。本机 0.147.0 与当前安装的 0.167.0 均通过实际 App Server 启动和策略回读验证；每个版本仍须在 prompt 前校验有效策略、reviewer、sandbox 与 workspace 绑定。

Codex 的进程级 `-c/--config key=value` 接受 TOML inline table；本机 `config/read` 能看到项目条目，并与现有项目配置合并。`thread/start.config.projects` 的线程级字段没有改变有效审批策略，因此不使用。

每个 gate Run 在 prompt 前校验响应中的 `approvalPolicy=untrusted`、`approvalsReviewer=user`、sandbox 类型与网络边界、`cwd` 和 `runtimeWorkspaceRoots`。响应缺项、返回 `on-request`、reviewer 不匹配或 cwd/root 越界时，Run 以明确兼容性错误停止；不会悄悄继续。`thread/fork` 同样省略已退役字段并在新 Run 启动时重新绑定 cwd 和项目 trust。

项目 `trust_level="untrusted"` 会跳过仓库内 `.codex/` 层的配置、hooks 与 rules。用户层配置仍由 Codex 读取；Ragent 的托管 hook 继续通过 App Server hook 接口注册到托管 home。使用此档位时，仓库内自定义 Codex hooks/rules 不会生效，用户需把必须保留的配置迁移到用户层。

Windows、Linux、macOS 的 `safe/recommended/full-auto/conservative-auto` 已接入此 Run 级入口。POSIX 使用共享 `classifyRisk` / `decideRiskGate`；full-auto 采用 safe+caution 分类范围后自动拒绝其余请求，conservative-auto 采用 safe 分类范围并自动拒绝需升级的请求。Windows 保留自己的 PowerShell/路径分类器。`on-request` 适合“sandbox 内自动运行，越界时询问”的 Codex 原生交互，不满足 Ragent 逐命令分类目标。新版本支持的 `approval_policy.granular` 可选择 sandbox 升级、执行规则、MCP elicitation、权限请求和 skill 审批等提示类别；它用于按类别放行或自动拒绝，不会把 sandbox 内每条普通命令都转成 Ragent 审批事件，不能替代项目 trust gate。

### 2. 将 harness 适配与风险判定分开

每个 Harness adapter 负责把原生事件规范化为相同记录：运行、thread、turn、item、request id、请求类型、命令或文件变更、cwd、sandbox/网络权限请求、Harness 响应能力。Ragent 风险门只消费规范化记录；协议 adapter 负责用原生响应格式答复 Codex 或 Claude。

Codex 的 `thread/start` 响应须成为启动时的能力检查点。Codex 未给出预期审批策略、审批 reviewer 或 cwd 绑定时，Run 不得开始执行。每一个请求和响应都要核对 `threadId`、`turnId`、`itemId` 和 JSON-RPC id，保持已有的跨 thread/turn 隔离。

### 3. 扩展 Windows Codex 分类，而不是广泛放行

保留现有 PowerShell AST 分析和路径绑定；增加受限的 Codex 命令形状识别：

- 对 Codex 实际发来的 argv/shlex 先解析成 token，不把整条命令拼回 shell 后执行或盲目重解析。
- 为经过验证的 Windows shell/executable 形状分别调用 PowerShell、`cmd.exe` 或 Git Bash 静态分析器；只在可确认真实 executable、参数、cwd、重定向和组合命令时分类。
- 增补受限的只读搜索规则和工作区开发任务规则：`rg` 仅接受静态只读参数，默认跳过隐藏/忽略项且不跟随链接；工作区内 `npm/pnpm/yarn/bun` 的 test/build/lint/check/typecheck 等常用任务，以及工作区内静态 JS/Python 脚本，标记为谨慎级。recommended/full-auto 对谨慎级自动放行，safe 仍请求用户审批。非递归 `Get-ChildItem` 目录枚举只读名称/元数据，可列出保护目录的直接子项，但不能读取文件内容；递归扫描、包安装、未知任务名、解释器内联代码、动态变量、额外网络/文件系统权限、敏感文件内容与危险写删继续要求审批或拒绝；不按 executable 名称放行整类命令。
- 将完整的 `additionalPermissions`、`networkApprovalContext` 与 sandbox escape 单独分类为权限授予请求。即使命令本身是 `git status`，也不得用命令分类覆盖额外文件系统或网络授权。
- 对 Codex `fileChange` 以活动 item 的完整 diff 为依据；合并同一 item 的多文件决策。缺少对应 item、文件路径或变更类型时仍要求用户；删除和移动继续按高风险处理，后续仅在有完整目标、可恢复性及风险证明时再讨论放宽。
- `item/permissions/requestApproval` 与未知 MCP elicitation 继续要求用户；只自动接受由当前 Run 创建并绑定的 Ragent 管理 MCP 工具请求。
- Windows 将 ProgramData 作为系统路径保护时，若某个 Run 的已验证工作区本身位于 ProgramData 下，允许该工作区内的只读请求自动通过。例外绑定在执行范围摘要内的 ProgramData 根、workspace 根及实际解析路径；对所有保护根另有一项窄例外：非递归 `Get-ChildItem` 只返回直接子项元数据。memory/config 内容、递归读取、敏感路径内容和所有写入/删除仍走原策略。

Linux 继续复用 `classifyRisk` / `decideRiskGate` 的通用安全、谨慎、危险分级；Windows 保留独立的 PowerShell/路径实现。Linux 的 `sudo`、root 执行器与策略不应直接搬到 Windows；复用的是风险语义、审批聚合、审计字段与拒绝理由。

### 4. 统一 Ragent 风险档位语义

`recommended` 与 `full-auto` 使用完全相同的自动通过分类。达到自动通过标准的请求在两个档位都会自动通过；未达到标准的危险/未知请求在 recommended 中交给用户，在 full-auto 中自动拒绝。两者不能分别使用宽严不同的自动审批阈值。

| Ragent 决策档位 | Safe | Caution | Danger / 未知 | 额外权限或用户提问 |
|---|---|---|---|---|
| safe | 自动放行 | 用户审批 | 用户审批 | 用户审批；问题/计划确认原样交给用户 |
| recommended | 自动放行 | 自动放行 | 用户审批 | 用户审批；问题/计划确认原样交给用户 |
| full-auto | 自动放行 | 自动放行 | 自动拒绝，不等待用户 | 自动拒绝未授权能力；问题/计划按产品的无人值守策略结束为需用户处理 |
| conservative-auto | 在 workspace-write/no-network sandbox 内自动放行可证明的安全操作 | 按无人值守策略拒绝需要升级的请求，不能等待用户 | 不得因 sandbox 允许写工作区就把危险操作算安全 | 保持权限边界；网络/外部路径升级应明确拒绝并写入原因 |

“自动放行”必须有静态分析结果、有效 run context 与匹配的活动 item；无证据时落到用户路径或无人值守拒绝。用户审批响应只对当前操作或用户明确选择的持久范围有效，不能把一次批准隐式记成整个 session 的 allow rule。

### 5. 减少重复提示并补足可解释性

- Codex JSON-RPC request id 和 Claude bidi request id 在单个 Run 内幂等；重复事件复用第一次自动响应或 owner 卡，不重复回包或创建第二张卡。不同 request id 的语义相同操作暂不跨请求合并。
- 对同时到达、目标完全相同的网络请求可按 Codex 的 host/protocol/port 分组合并显示；不同端口、不同授权范围不得合并。
- 对不同请求 id 但同一危险命令，只有在 payload、cwd、权限范围都一致且仍处于同一活动 turn 时才合并为一组；用户决定要逐个映射回原始 JSON-RPC 请求。
- 自动批准/拒绝记录 `policyVersion`、风险 tier、原因码与响应成功状态；日志只保存经过脱敏的命令摘要，不保存 token、命令敏感参数或认证数据。
- 用户卡片显示“为什么需要你”，例如额外网络授权、目标在工作区外、删除动作、分类器无法确认 shell 身份；不显示笼统的“Codex 请求批准”。

### 6. 不把 Codex Auto-review 当作 Ragent 自动审批

Ragent 管理审批的 Run 继续使用 `approvalsReviewer="user"`，让尚未由 Ragent 自动处理的请求回到 Ragent owner 界面。Codex `auto_review` 可作为独立可选 Harness 功能研究，但不能默认开启来掩盖 Ragent 分类失败，也不能把其批准视为 Ragent 审批记录。官方文档明确指出 reviewer 只处理已经需要审批的动作，不改变 sandbox 内已允许动作的执行策略。

## 实施顺序

1. **观测先行（部分完成）：** 自动答复和 owner 请求已有 spool 事件、risk tier、原因与策略版本；projection service 已累计 Claude/Codex 的 provider、risk tier、reason code 及 policyVersion 计数，并按最近 128 个 Run 隔离；跨请求语义重复统计仍需补齐。
2. **Codex 策略兼容（已实现）：** Windows、Linux、macOS gate Run 使用进程级项目 trust 覆盖、有效策略回读与 prompt 前 fail-closed；不会在拒绝后静默降级或重试。已验证 0.147 与 0.167 App Server 策略响应，并在 0.167 命令 fixture 验证 owner prompt、Ragent 自动批准与 full-auto 自动拒绝。
3. **Windows Codex 命令分类（持续扩展）：** 保留 PowerShell AST、路径与权限边界；新增 Codex App Server 缺少 `-NoProfile` 时的受限 argv 识别、静态 ripgrep 读取和常见工作区开发任务谨慎级分类。其他 shell、动态命令、上下文不足时仍 fail-closed。此次代码调整尚未运行测试或 Windows 本机回归，审批频率下降幅度尚无实测数字。
4. **跨平台策略一致性（已实现，需 Linux/macOS CI）：** 三个平台为 safe、recommended、full-auto、conservative-auto 使用同样的项目级请求入口；POSIX 用共享风险分类器，Windows 用 PowerShell/路径分类器；profile sandbox、写入和网络边界保持独立。`granular` 不能代替逐命令 gate。
5. **审批聚合与 UI（部分完成）：** 相同 provider request id 已幂等且保留单卡；原因码随审批记录保存。provider、risk tier、reason code 与 policyVersion 计数按最近 128 个 Run 隔离；不同 request id 的同一网络或危险操作合并仍未实现。
6. **分层验收（部分完成）：** Windows 本机 CLI/App Server 离线 fixture 与协议和策略 suites 已覆盖；荣耀真机上的审批 UI 与本地事件重放已完成离线验收，但尚未覆盖手机 OAuth → Ragent UI → 真实服务审批链路。部署后真实服务回归及 Linux/macOS 原生环境验收仍未完成。

## 验收用例

| 用例 | 预期 |
|---|---|
| Codex `git status --short`、工作区内只读查看 | Codex trusted allowlist 或 Ragent 自动响应；owner 提示为 0。验收须区分“Codex 未发审批事件”和“Ragent 已自动答复” |
| Codex 工作区内可证明的普通文件编辑 | 按当前 Ragent 档位自动处理；不重复展示 file change 和 command 两张同义卡 |
| Codex 删除工作区目录、访问敏感凭据、shell 拼接/动态执行 | safe/recommended 走审批或拒绝；full-auto 拒绝；原目标文件未改变 |
| Codex `winget uninstall` 或系统服务修改 | 绝不作为普通命令自动放行；显示一个带目标和风险原因的 owner 请求 |
| Codex 请求网络/工作区外访问 | 分别识别权限增量；不能因命令本身安全而自动授权 |
| Codex 活动 fileChange 缺失、未知工具或未来协议方法 | 保留审批并显示未知/上下文不足原因；不丢请求、不重复弹卡 |
| Codex `thread/start` 返回错误策略或 `on-request` 意外覆盖项目 trust | 在执行 prompt 前中止并显示策略不兼容；不得退化为无提示运行 |
| Codex 旧版与新版本启动、thread resume/fork | 运行时有效审批策略保持预期；owner 与 sandbox 配置没有被旧线程状态覆盖 |
| Claude Code 已覆盖的只读、工作区编辑、额外网络权限、未知工具 | 保持现有行为和风险边界；共享门更新不能回归 Claude 的逐工具回调 |
| 事件重放、重复 JSON-RPC 请求 id、同一 network host/port 并发 | 同一个原始请求仅答复一次；UI 不创建重复卡 |

验收指标：安全只读用例人工审批数为 `0`；已知危险动作自动放行数为 `0`；每个必须用户决策的操作最多一张 owner 卡；对每张卡可从日志追溯到一个明确 risk reason；对已拒绝动作确认没有对应副作用。

## 当前证据与未决项

- Claude Windows 的 Bash 和 PowerShell 普通相对路径读取、写入及单文件删除，现在会先按统一风险规则分析，再在执行时核对工作目录；目标或工作目录位于工作区外本身不会触发审批。执行目录不一致时停止，敏感目标和无法确认的操作仍交给原策略。请求审批与 full-auto 的自动通过标准相同。真实 Windows Bash、PowerShell 与 sidecar fixture 已验证；此方案没有固定目录句柄，分析与执行间目录被替换仍存在竞态。
- 常见依赖安装、项目自定义脚本、普通 Node/Python 脚本，以及 Go、Cargo、.NET、Gradle、Maven 和常见 npx 构建测试命令允许在工作区外按同一标准自动处理；Claude 的相对工作目录在执行时核对。包安装、项目脚本和构建任务会执行其自身代码，静态审批不能保证代码内部没有危险操作；这与扩大自动通过范围同时存在。测试只验证请求分类和目录约束，没有实际联网安装依赖。
- Claude Bash 的普通 HTTP(S) curl 查询和指定普通目标文件的下载可自动通过，执行时禁用本机 curl 配置并限制跳转协议；上传参数仍交原策略处理。测试在本机 HTTP 服务器验证配置中的 POST 不会改变实际 GET 请求，并验证工作区外下载；真实 Claude CLI 在两种模式均触发回调并自动通过查询。远端服务仍可能给 GET 请求赋予副作用，静态规则无法判断服务端行为。
- Claude 的 Glob、Grep 等文件搜索工具省略可选目录时，按会话目录补全后再做风险判断；会话目录在工作区外也按同一标准处理。补全仅针对未提供目录的调用，敏感目录不会因此自动放行。
- Windows Claude 文件工具的相对路径现先绑定到会话目录，随后按绝对目标重新判断；普通读取、写入和搜索不因工作区外位置而拦截，敏感目标仍保留审批。真实 Claude 在两种模式下通过测试用 ask 规则触发 Read 回调，成功读取工作区外普通文件；测试使用本地模拟模型。此验证主动要求 Read 进入回调，不能推断所有真实会话都会由 Claude 发起该回调；路径检查与执行之间仍可能有目录替换竞态。
- 真实 Claude CLI 暴露了默认模式会自行放行部分 Bash 命令的问题：忽略文件能重新包含 `.env`，导致目录搜索绕过 Ragent。推荐与全自动档现通过本次会话的 `ask` 规则把 Bash/PowerShell 送入 Ragent；它不要求用户逐条点击，普通请求由自动审批器回应。Windows 的 ripgrep 搜索和 POSIX 上可识别的字面量 ripgrep 搜索补充敏感路径排除规则，工作区内外一致；这会从搜索结果中排除这些路径，即使忽略文件试图重新包含它们。真实 Claude 和 Codex 客户端使用本机模型服务的回归覆盖 Windows 情况；Linux WSL 使用真实 Bash、ripgrep 和审批队列验证 POSIX 路径。Linux Claude 的全自动档也改为经过审批器，而旧的单向 Claude 运行时无法回传决定，不能用于该档。Claude 的规则优先级见[官方权限文档](https://code.claude.com/docs/en/permissions)。此规则覆盖命令工具，复杂或无法解析的 POSIX 搜索、独立文件工具及间接脚本不能视为已受到同等拦截；未知命令仍可能请求审批或被自动拒绝，实际频率需要生产数据验证。
- 在强制敏感路径排除且不跟随符号链接的前提下，ripgrep 的 `--hidden`、`--no-ignore` 和 `-u`/`-uu` 普通搜索可自动通过。真实 Windows 和 Linux Claude 的两种模式均验证了普通隐藏文件可见、测试 `.env` 内容不可见；Windows Codex 的托管搜索入口也验证了同样的文件列表。此验证使用本地模拟模型；符号链接跟随、外部预处理器和未识别选项仍需进一步判断。
- Windows Claude 的字面量 Bash 和可静态解析的单条 PowerShell 搜索支持常见正向 glob/类型筛选：执行前把敏感排除放在筛选参数之后，并确认全部排除均位于筛选之后。真实 Claude 两种模式、真实 Bash/PowerShell 的工作区外夹具和真实 Codex 托管 Hook 均验证普通匹配结果存在、测试 `.env` 和凭据目录不出现在结果中。若调用方把正向筛选放在排除之后且无法安全改写，仍须按原规则核查；Codex Hook 的相对路径实际工作目录仍不可确认，继续要求明确目标。
- Claude Bash 的静态 `cd 目录 && 后续命令` 会先解析目录，再逐段判断后续动作；执行时将切换目标固定为分析过的绝对路径，工作区外同样适用。动态目录和无法判断的后续动作继续交原策略处理。
- Windows Claude 的复合 Bash 命令现在逐段注入相应的搜索、Git 差异及 curl 防护，使 `cd 目录 && rg ...` 等普通操作也可自动通过。真实 Claude 在两种模式下执行了该搜索，真实 Bash 验证了工作区外目录、忽略文件尝试重新包含 `.env` 的情况；敏感文件未进入结果。复杂或不能静态识别的组合仍可能进入审批或自动拒绝。
- Windows Claude Bash 的字面量 `||` 分支、`true`/`false` 和将标准错误丢弃到 `/dev/null` 的常见写法，可与现有普通读写规则组合；每个分支均经过同一风险判断。真实 Claude 客户端在两种模式下用本机模拟模型执行了查找失败后读取普通文件的命令并自动通过。含危险删除的后备分支仍进入审批或自动拒绝；对于经过绑定的目录切换，目录切换失败时不会从原目录执行后续分支。
- 真实 Windows Claude 客户端的两条连续命令回归表明，第一条在子目录中完成后，下一条从会话目录执行；关闭 Ragent 命令入口时的基线也相同。最初假设目录会跨命令保持并据此断言失败，已按真实基线修正；推荐和全自动模式的两条命令均自动通过。
- Linux 真实 Claude Code 2.1.310 的行为不同：切换目录后，后续命令继续使用新目录。对可静态确认的普通 `cd`，审批器绑定原目录与目标，并在收到对应工具成功结果后更新会话目录；失败和中断不会更新。两种模式使用本机模拟模型服务连续执行切换目录和 ripgrep，均自动通过，搜索结果未包含测试凭据。复杂或动态目录切换，以及切换成功但后续命令失败时，目录状态仍可能无法确认，后续相对搜索可能被中止；macOS 原生环境尚未验证。
- Codex 的普通 `git diff` 可按谨慎级自动处理；本机真实 Codex App Server 在两种模式均以隔离测试仓库执行成功，模型服务使用本机模拟端点。Codex 路径没有重写命令，Git 配置的差异程序或转换器可能执行；Claude 路径会禁用这两项后执行。
- Windows Git 普通查询扩展到带字面量版本范围的 `git diff` 和 `git log`、`git show --stat HEAD`、`git diff HEAD -- 普通文件` 以及常见 `git ls-files` 选项。显式文件路径经过现有路径风险检查，敏感路径仍进入审批或自动拒绝。Claude 的 diff/show 会禁用外部差异程序和文本转换器；真实 Claude 和 Codex CLI 使用隔离仓库和本机模拟模型服务，在两种模式均自动通过并执行提交摘要查询和指定普通文件的差异查询。危险选项、`HEAD:.env`、动态路径和复杂 pathspec 不进入此次自动规则。Codex 路径没有重写 Git 命令，仓库配置的外部差异程序或文本转换器可能运行。
- Windows Bash 和 PowerShell 对可解析的 `git -C 目录 ...` 按指定目录检查子命令及其文件目标，工作区外同样适用。真实 Claude CLI 使用隔离工作区外仓库，Codex CLI 使用隔离子仓库，均通过本机模拟模型服务在请求审批和全自动两种模式下自动执行了查询；敏感路径及强制推送仍进入风险处理。该路径检查不能固定目录句柄，检查与 Git 执行间目录被替换仍可能产生竞态。
- Windows 本机真实 Claude CLI 使用隔离配置和本机模拟模型服务，分别以 recommended 和 full-auto 执行相对路径写入及隔离项目的 npm 脚本；两类用例均实际触发审批回调、由 Ragent 自动批准并完成，未使用真实模型额度。重新编译当前源码的原生删除助手后，其受保护目标和响应测试通过。
- `build`、`dist`、`node_modules` 等常见生成目录即使位于工作区外，也可经非提权原生删除助手自动清理；助手核对实际目录并逐项固定和校验目标。真实 Windows fixture 验证了两种模式下的工作区外清理及工作目录不匹配时不删除，受保护子项仍触发审批。目录名只能作为生成目录的惯例，不能证明内容可重新生成。
- 普通系统目录中的单个文件读取和搜索不再仅因位于系统目录而触发审批；明确配置的受保护目录、敏感凭据路径和 Windows 注册表数据文件所在目录仍保留风险判断。系统目录写入及递归搜索继续遵循对应操作的策略。
- 本地手工选取的 29 个 Claude Bash 分类样例中，两种模式分类完全一致：25 个普通操作自动通过，普通推送、强制推送、删除根目录及读取 `.env` 进入后续人工审批或自动拒绝。此样例并非实际用户工作负载，不能推算真实自动通过率；生产数据和未覆盖的命令仍需验证。
- Linux WSL QA 环境复用 G 盘现有 Node 运行时，以 G 盘目录保存测试数据：风险分类 155 项、审批门 134 项、provider 档位，以及 Claude 协议/工具策略、Codex adapter/请求幂等、跨刷新投影和审批分组测试通过。分类器现把明确删除 `.ssh`、`.gnupg` 等凭据目录列为危险操作；普通近似名称不受此规则影响。最初将分组测试文件名写错，改用实际文件后通过；分组测试日志含隔离实例的 AgY 凭据检查失败，该结果不能作为真实账号或服务验收。POSIX 风险测试直接在 Windows Node 运行时未通过系统路径断言，在 Linux 运行时通过；provider 档位测试中两条旧的 Codex Linux 期望已更正并复验。WSL 测试源码和临时目录位于 Windows 挂载盘，不等同于独立 Linux 文件系统或 macOS 验收。
- Linux 额外使用已校验官方 SHA-256 的 [ripgrep 14.1.1](https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1) 和真实 Bash 验证 Claude POSIX 审批回调：工作区外普通搜索、正向通配符和 `--` 参数均自动通过并排除 `.env`；敏感目标在推荐档进入审批、全自动档拒绝。另以真实 Claude Code 2.1.310 配合本机模拟模型服务，验证两种模式均实际触发审批回调、自动通过普通搜索且不返回测试凭据；未调用真实模型额度。

- 本机 Windows Codex CLI `0.147.0` 与隔离安装的 `0.167.0`：真实 App Server 启动时只设置当前 cwd 项目 trust，不发送已退役的审批枚举；返回有效 `approvalPolicy=untrusted`、reviewer=user、sandbox 和 workspace root。0.167.0 使用本机 fake Responses provider、隔离 `CODEX_HOME` 和测试 key，命令级 owner prompt、无害命令自动批准、full-auto 危险命令拒绝均通过；没有使用 Codex 账号或官方模型额度。
- 本机真实 CLI fixture：推荐档 `git status --short` 无 owner prompt 自动执行；推荐档危险 `winget uninstall` 进入一个 owner 审批后拒绝；full-auto 对同一危险动作自动拒绝且无 owner prompt。
- 本机真实 managed Hook：Ragent hook 通过 App Server 注册和信任校验，执行 preToolUse 并改写安装命令；改写后的安装命令仍需 owner 审批。当前源码调整已允许 Codex App Server 的规范 PowerShell argv 缺少 `-NoProfile` 时进入静态分析，但本轮未重放该 Hook，也未测量审批频率变化。
- 2026-11-10 荣耀 MTN-AN80（`MTN-AN80` / `ADNQ6R5716008635`）离线真机验收：`ApprovalAttentionDeviceTest` 16/16 通过；`ApprovalReplayDeviceTest` 使用本地合成 approval event、fake transport 和 in-memory Room 重放，1/1 通过，验证事件字段持久化以及真机卡片中的危险操作目标、条件状态和 approve/deny 控件。两组均未调用 OAuth、Codex 官方 provider 或模型额度。
- 荣耀上的 app 模块 `RunDockApprovalIslandTest` 曾为 1/4 通过。2026-11-12 在三星 SM-S9060（Android 16）复跑同样为 1/4：两个用例在英文按钮显示断言失败，一个寻找展开卡片内已不再显示的旧标题。现有实现会按设备语言本地化默认按钮，展开卡片显示操作说明；测试调整为读取本地化资源和当前说明，并使用实际触摸测试卡片内部。调整后的三星复跑为 4/4 通过、0 跳过，覆盖展开、收起、重新展开、卡片内部触摸和提交中禁用重复操作；此前对动画时序的猜测没有得到证实。中间一次复跑因 G 盘空间一度降至约 150 MiB 而主动停止，空间恢复后完成复测。
- Codex 0.149 的退役行为及当前 `granular` 能力依据官方文档与合并记录；0.167.0 已验证策略字段，但受管策略环境及真实 provider 账号尚未验证。
- 最近荣耀手机 Codex Official OAuth 运行在审批事件产生前因 refresh token 已使用而失败。用户说明 Codex 账号目前无法登录，免费档额度很少且要求不要消耗；因此本轮只做本地假传输/合成事件验收，没有重试 OAuth 或请求官方模型。手机端完整 OAuth → Ragent UI → 真实审批事件验收仍未完成；没有把 provider 的“可用”状态当作授权成功。
- 不同 provider request id 的语义重复合并、手机端 OAuth、已部署 Windows 服务与 Linux/macOS 原生环境验收仍未完成；当前不把它们记为通过。

- PowerShell 的 `2>$null` 和 `>$null` 现在识别为丢弃输出，普通命令不再因此被当成动态路径；其他动态重定向仍按原风险处理。条件语句不再因为包含普通写入或删除而整条要求审批：条件和所有分支中的动作分别经过现有策略检查，受保护目标、无法识别的动作和危险递归删除仍进入风险处理。真实 Windows Claude 和 Codex 客户端使用本机模拟模型服务，在 recommended 和 full-auto 两种模式下分别验证了普通读取重定向与条件写入自动执行；未使用真实账号额度。PowerShell 动作和共享审批门回归通过，三星真机使用隔离测试服务验证危险 Claude 操作进入审批并被拒绝。以上是指定用例的结果，不能据此推算生产审批频率。
- PowerShell 输出处理增加 `Out-Null`、`Format-List` 及 `fl`：前面的文件操作仍逐项判断目标，格式化属性只接受已有的字面量形式。Windows 真实 Claude 和 Codex 在两种模式下通过本地模拟模型服务执行了普通文件写入、丢弃输出和格式化查询；受保护目标及计算属性风险回归通过。三星隔离测试服务的危险 Claude 操作审批与拒绝链路 1/1 通过。对 34 条旧记录的分类回放中，两种模式一致，自动通过数量未变；一条 PowerShell 从语法不支持转为识别出高风险目标，并非成功消除该条审批。生产请求频率仍需实测。
- PowerShell 管道中 `Where-Object`、`where` 和 `?` 的字面量属性比较可按前序动作一起自动判断；包含脚本块、动态值或未知比较符的形式仍需进一步处理。Windows 真实 Claude 和 Codex 客户端在两种模式下使用本机模拟模型执行目录筛选并确认结果；受保护目标和执行脚本块的回归保持风险处理。三星隔离服务的 Claude 危险操作审批与拒绝链路 1/1 通过。这些用例未测量生产审批频率，也不说明历史中含脚本块的筛选已被解决。
- 后续扩展原生 PowerShell 语法树判断：管道筛选中单一的 `$_` 或 `$PSItem` 字面量属性比较也可自动处理，例如 `{ $_.Name -like '*.txt' }`。目标路径仍由前面的文件操作判断；多条语句、方法调用、动态值和嵌套命令仍进入风险处理。真实 Windows Claude 和 Codex 使用本地模拟模型，在两种模式下执行该筛选并核对结果；三星隔离服务中 Claude 危险操作的审批及拒绝链路 1/1 通过。此扩展仅覆盖上述形态，并未证明复杂历史脚本块都能自动处理，也不能推算生产审批频率。
- PowerShell 筛选进一步支持括号、`-and`、`-or`、逻辑取反及字面量布尔值的组合，逐个检查表达式，前序文件目标仍走原有策略；嵌入命令、方法或动态变量的表达式仍需风险处理。Windows 真实 Claude 和 Codex 客户端在 recommended 与 full-auto 中均使用本机模拟模型实际执行组合筛选并返回预期文件；三星隔离测试中的危险 Claude 操作审批与拒绝链路 1/1 通过。这些用例不代表已测得生产审批率。
- 修正 PowerShell `Copy-Item` 对复制源的判断：普通系统文件的复制源按读取规则处理，目标仍按写入规则判断；显式受保护目录、敏感系统文件及系统目录写入仍进入风险处理。真实 Windows Claude 和 Codex 在两个模式中将系统 `win.ini` 复制到 G 盘隔离目录，逐字节核对成功；模型服务为本地模拟。PowerShell 动作回归及三星危险 Claude 操作审批拒绝链路 1/1 通过。历史中的另一条复制请求来自明确受保护目录，仍进入风险处理，不计作被消除的审批。
- Claude 同一活动轮次内同时等待、工作目录和完整命令参数及风险判定一致的 Bash/PowerShell 请求，可以复用一张审批卡；用户决定在 Run 锁内分别排入各原始请求。缺少可信上下文、轮次或工作目录、包含权限建议、权限扩展以及不同内容或已作决定的请求不合并。本机覆盖投影、队列及每个 Claude 响应 ID；三星 1/1 验证一张卡的拒绝映射到真实 Claude 请求及另一条隔离合成请求，真实请求收到拒绝。对真实 Claude 同时输出两个相同 Bash 工具调用的实验，只观察到第一条审批，第二条在等待时没有到达，因此没有证明真实双请求并发；模型服务为本地模拟，设备身份和传输为夹具。首次设备试验因夹具在 CLI 退出时过早关闭而失败，修正生命周期后通过。

## 外部依据

- [Codex 配置参考：approval_policy 与项目 trust_level](https://developers.openai.com/codex/config-reference/)
- [Codex 合并记录：移除 `approval_policy="untrusted"`](https://github.com/openai/codex/pull/39630)
- [Codex 审批与安全：从已废弃的 untrusted approval policy 迁移](https://learn.chatgpt.com/codex/agent-approvals-security)
- [Codex App Server：审批请求与响应协议](https://developers.openai.com/codex/app-server/)
- [Codex App Server README：managed human command checkpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
