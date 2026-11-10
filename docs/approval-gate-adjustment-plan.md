# Ragent 审批链路调整方案：Claude Code 与 Codex

日期：2026-11-10  
状态：Windows Codex 项目级审批入口与旧版真实 CLI 验证已实现；Android 真机 OAuth/E2E 与新版 Codex 真机验证待完成

## 结论

现在的审批请求过多，不宜简单归因于“自动审批器坏了”。Ragent 已有自动决策和自动响应路径；问题主要在于 Harness 是否会把动作送到该路径、Ragent 能否识别请求，以及识别失败时的保守回退。Claude Code 与 Codex 的权限协议不同，不能用一个 Harness 档位名假定它们会产生相同的审批事件。

Codex 0.149 起不再支持显式 `approvalPolicy="untrusted"`。Ragent 在 Windows 受控 Run 的私有 App Server 进程上只注入该 Run 的 `trust_level="untrusted"`，并在 `thread/start`、`thread/resume`、`thread/fork`、`turn/start` 中省略 `approvalPolicy`。Codex 会从不信任项目派生严格审批策略：命令逐条请求审批，执行策略明确允许的命令除外。启动响应仍须确认有效策略为 `untrusted`、reviewer 为 `user`、sandbox、cwd 和 workspace root 均匹配，否则 prompt 前停止。

Codex OAuth App Server broker 按账号共享，不能为单个 Run 绑定独占的项目 trust；受控 Run 因此使用私有 App Server，并沿用现有 OAuth 锁避免并发刷新同一凭据。代价是受控 Run 会串行占用 Codex OAuth 执行通道。经本机验证，`thread/start.config.projects` 不会改变有效审批策略，不能替代进程级项目配置。

Codex 的 `approvalsReviewer="user"` 只表示把已产生的审批请求交给用户；它不会制造请求，也不会自动批准。改成 Codex 的 `auto_review` 会把决定权交给 Codex reviewer，而不是 Ragent 审批器，不应作为本问题的默认修复。

## 当前链路与问题定位

| 层 | Claude Code | Codex App Server |
|---|---|---|
| Harness 请求 | 双向协议的 `can_use_tool`，受控档位会逐工具调用进入审批回调 | JSON-RPC 请求：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、MCP elicitation 等；只有 Codex 判定需要审批时才会发出 |
| Ragent 自动处理 | `trackClaudeBidiApprovalRequest` 后进入共享风险门与 Windows 专用门 | `trackCodexAppServerApprovalRequest` 后进入共享风险门与 Windows 专用门 |
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
| safe / recommended | Run 级项目 trust `untrusted`（省略 `approvalPolicy`）+ 当前 profile sandbox，`approvalsReviewer=user` | 当前实现为 `on-request` + profile sandbox；目标改为 Run 级项目 trust gate | Windows 受控 Run 的命令审批请求进入 Ragent 分类。0.147 的 `git status` fixture 没有 owner 卡，但不能据此断言是 Ragent 自动答复；也可能是 Codex 执行策略直接允许。非 Windows `on-request` 只覆盖 Codex 升级审批 |
| full-auto | Run 级项目 trust `untrusted` + profile sandbox；安全请求自动答复，其余请求自动拒绝 | 当前实现为 `never` + `danger-full-access`；目标改为 Run 级项目 trust gate | Windows 已可对进入 gate 的危险请求自动拒绝。当前非 Windows 映射允许 sandbox 内的普通命令直接执行，Ragent 没有逐条拒绝危险命令的机会 |
| conservative-auto | Run 级项目 trust `untrusted` + `workspace-write`、关闭网络 | 当前实现为 `on-request` + `workspace-write`、关闭网络；目标改为 Run 级项目 trust gate | Windows 命令请求进入分类，sandbox 限制写入与网络；当前非 Windows 工作区内命令可能直接执行，不会逐条经过 Ragent |

此处 `danger-full-access`、`workspace-write` 是 Harness sandbox，不等于 Ragent 的风险档位。Ragent 不应把 `approvalPolicy=never` 或绕过审批作为消除提示的办法；这样会让危险操作绕过审批事件入口。

### 为什么 Codex 仍可能产生多张人工审批卡

1. **请求触发面不同。** `on-request` 只覆盖 Codex 要求升级权限的动作，不会保证普通命令进入 Ragent 分类器。Windows 项目 trust gate 会把需要审批的命令送进 Ragent；执行策略明确允许的命令仍可不发请求。0.147 的 `git status` 实测无 owner 卡，只能证明没有用户提示，不能证明是 Ragent 自动答复。新版官方语义仍是“不信任项目命令逐条审批，显式 exec-policy allow 除外”。
2. **Windows 分类器只对可证明的命令自动放行。** `windows-approval-gate.mjs` 目前要求 Codex 命令能被还原为受信任的 PowerShell 可执行文件、`-NoProfile` 参数及可静态分析脚本。未知 shell、非 PowerShell 命令、工作目录/路径上下文缺失、额外权限、未知工具、没有对应活动项的文件变更都会保守地转人工审批。这个 fail-closed 行为安全，但覆盖面不足会表现为大量提示。
3. **执行策略可能绕过 Ragent 入口。** 即使项目 trust 是 `untrusted`，Codex 执行策略允许的命令也不会触发审批事件。Ragent 必须区分“Codex 没有发事件”和“Ragent 自动答复”；不能仅凭零张 owner 卡判断自动审批器工作正常。对已允许命令应审计来源与规则，确保允许项来自经过审查的策略。
4. **有些请求应保留人工确认。** `item/permissions/requestApproval`、MCP elicitation、额外文件系统/网络权限、信息不完整的文件变更、Codex 删除/移动请求目前不能只凭命令文本证明安全，不能为了降提示量而放宽。
5. **受控安装 Hook 还受 shell 证明条件限制。** 荣耀手机最近一次 Codex Official Account 只读运行在执行命令前报 refresh token 已使用，未到审批阶段。本机 0.147.0 的 managed Hook 确实执行并改写安装命令；但 App Server 给出的 PowerShell argv 缺少 Ragent 要求的 `-NoProfile`，sidecar 无法证明 shell 身份，因此保留 owner 审批，不会自动运行 Hook 改写后的安装命令。

## 调整目标

让 Ragent 风险档位决定“哪些动作自动放行、哪些动作需要用户、无人值守时如何拒绝”；让 Codex sandbox 继续限制进程可触达的范围；让所有应进入 Ragent 决策的动作都能被同一套策略识别。提示卡必须给出明确原因，并且同一请求的重放不能产生重复卡片。

## 完整调整方案

### 1. 用 Run 级项目 trust 替代已退役的显式审批枚举

Windows `safe`、`recommended`、`full-auto`、`conservative-auto` 以及显式选择 `untrusted-*` 权限模式的 Run，都在私有 App Server 进程参数中加入 `projects={"<cwd>"={trust_level="untrusted"}}`。不写用户全局 `config.toml`，不改项目配置，也不发送 `approvalPolicy="untrusted"`。旧版 0.147.0 的真实 thread/start 在仅设置项目 trust、并省略 `approvalPolicy` 时返回有效 `approvalPolicy=untrusted`；新版 Codex 的源码合并记录表明不信任项目仍逐命令请求审批。真实新版尚未安装，继续执行 prompt 前校验。

Codex 的进程级 `-c/--config key=value` 接受 TOML inline table；本机 `config/read` 能看到项目条目，并与现有项目配置合并。`thread/start.config.projects` 的线程级字段没有改变有效审批策略，因此不使用。

每个 gate Run 在 prompt 前校验响应中的 `approvalPolicy=untrusted`、`approvalsReviewer=user`、sandbox 类型与网络边界、`cwd` 和 `runtimeWorkspaceRoots`。响应缺项、返回 `on-request`、reviewer 不匹配或 cwd/root 越界时，Run 以明确兼容性错误停止；不会悄悄继续。`thread/fork` 同样省略已退役字段并在新 Run 启动时重新绑定 cwd 和项目 trust。

项目 `trust_level="untrusted"` 会跳过仓库内 `.codex/` 层的配置、hooks 与 rules。用户层配置仍由 Codex 读取；Ragent 的托管 hook 继续通过 App Server hook 接口注册到托管 home。使用此档位时，仓库内自定义 Codex hooks/rules 不会生效，用户需把必须保留的配置迁移到用户层。

Windows 的 `safe/recommended/full-auto/conservative-auto` 已接入此 Run 级入口；Linux/macOS 尚需用相同的项目 trust 入口和 POSIX 风险分类器完成策略对齐。`on-request` 适合“sandbox 内自动运行，越界时询问”的 Codex 原生交互，不满足 Ragent 逐命令分类目标。新版本支持的 `approval_policy.granular` 可选择 sandbox 升级、执行规则、MCP elicitation、权限请求和 skill 审批等提示类别；它用于按类别放行或自动拒绝，不会把 sandbox 内每条普通命令都转成 Ragent 审批事件，不能替代项目 trust gate。

### 2. 将 harness 适配与风险判定分开

每个 Harness adapter 负责把原生事件规范化为相同记录：运行、thread、turn、item、request id、请求类型、命令或文件变更、cwd、sandbox/网络权限请求、Harness 响应能力。Ragent 风险门只消费规范化记录；协议 adapter 负责用原生响应格式答复 Codex 或 Claude。

Codex 的 `thread/start` 响应须成为启动时的能力检查点。Codex 未给出预期审批策略、审批 reviewer 或 cwd 绑定时，Run 不得开始执行。每一个请求和响应都要核对 `threadId`、`turnId`、`itemId` 和 JSON-RPC id，保持已有的跨 thread/turn 隔离。

### 3. 扩展 Windows Codex 分类，而不是广泛放行

保留现有 PowerShell AST 分析和路径绑定；增加受限的 Codex 命令形状识别：

- 对 Codex 实际发来的 argv/shlex 先解析成 token，不把整条命令拼回 shell 后执行或盲目重解析。
- 为经过验证的 Windows shell/executable 形状分别调用 PowerShell、`cmd.exe` 或 Git Bash 静态分析器；只在可确认真实 executable、参数、cwd、重定向和组合命令时分类。
- 增补少数语义明确的只读命令规则（例如限定 cwd 的 `git status`/`git diff`、路径明确的目录/文件读取）；对 `npm run`、解释器 `-c`、管道、重定向、动态变量、环境变量注入、网络或凭据路径访问默认保持谨慎，不能按 executable 名称把整类命令放行。
- 将完整的 `additionalPermissions`、`networkApprovalContext` 与 sandbox escape 单独分类为权限授予请求。即使命令本身是 `git status`，也不得用命令分类覆盖额外文件系统或网络授权。
- 对 Codex `fileChange` 以活动 item 的完整 diff 为依据；合并同一 item 的多文件决策。缺少对应 item、文件路径或变更类型时仍要求用户；删除和移动继续按高风险处理，后续仅在有完整目标、可恢复性及风险证明时再讨论放宽。
- `item/permissions/requestApproval` 与未知 MCP elicitation 继续要求用户；只自动接受由当前 Run 创建并绑定的 Ragent 管理 MCP 工具请求。

Linux 继续复用 `classifyRisk` / `decideRiskGate` 的通用安全、谨慎、危险分级；Windows 保留独立的 PowerShell/路径实现。Linux 的 `sudo`、root 执行器与策略不应直接搬到 Windows；复用的是风险语义、审批聚合、审计字段与拒绝理由。

### 4. 统一 Ragent 风险档位语义

| Ragent 决策档位 | Safe | Caution | Danger / 未知 | 额外权限或用户提问 |
|---|---|---|---|---|
| safe | 自动放行 | 用户审批 | 用户审批 | 用户审批；问题/计划确认原样交给用户 |
| recommended | 自动放行 | 自动放行 | 用户审批 | 用户审批；问题/计划确认原样交给用户 |
| full-auto | 自动放行 | 自动放行 | 自动拒绝，不等待用户 | 自动拒绝未授权能力；问题/计划按产品的无人值守策略结束为需用户处理 |
| conservative-auto | 在 workspace-write/no-network sandbox 内自动放行可证明的安全操作 | 按无人值守策略拒绝需要升级的请求，不能等待用户 | 不得因 sandbox 允许写工作区就把危险操作算安全 | 保持权限边界；网络/外部路径升级应明确拒绝并写入原因 |

“自动放行”必须有静态分析结果、有效 run context 与匹配的活动 item；无证据时落到用户路径或无人值守拒绝。用户审批响应只对当前操作或用户明确选择的持久范围有效，不能把一次批准隐式记成整个 session 的 allow rule。

### 5. 减少重复提示并补足可解释性

- 请求 `approvalId` 与 provider request id 作幂等键；重复事件只保留一个待审批记录和一张卡片。
- 对同时到达、目标完全相同的网络请求可按 Codex 的 host/protocol/port 分组合并显示；不同端口、不同授权范围不得合并。
- 对不同请求 id 但同一危险命令，只有在 payload、cwd、权限范围都一致且仍处于同一活动 turn 时才合并为一组；用户决定要逐个映射回原始 JSON-RPC 请求。
- 自动批准/拒绝记录 `policyVersion`、风险 tier、原因码与响应成功状态；日志只保存经过脱敏的命令摘要，不保存 token、命令敏感参数或认证数据。
- 用户卡片显示“为什么需要你”，例如额外网络授权、目标在工作区外、删除动作、分类器无法确认 shell 身份；不显示笼统的“Codex 请求批准”。

### 6. 不把 Codex Auto-review 当作 Ragent 自动审批

Ragent 管理审批的 Run 继续使用 `approvalsReviewer="user"`，让尚未由 Ragent 自动处理的请求回到 Ragent owner 界面。Codex `auto_review` 可作为独立可选 Harness 功能研究，但不能默认开启来掩盖 Ragent 分类失败，也不能把其批准视为 Ragent 审批记录。官方文档明确指出 reviewer 只处理已经需要审批的动作，不改变 sandbox 内已允许动作的执行策略。

## 实施顺序

1. **观测先行：** 对每个进入 owner 流程的 Claude/Codex 请求记录脱敏的 `providerMethod`、risk mode、`policyVersion`、分类结果、提示原因码、权限增量及是否自动响应失败。增加仪表字段统计每 Run 的总请求、自动放行、自动拒绝、人工提示和重复请求数。
2. **Codex 策略兼容：** 已实现 Windows gate Run 的进程级项目 trust 覆盖、有效策略回读与 prompt 前 fail-closed；没有在新版拒绝后静默降级或重试。当前本机 `0.147.0` 真实 CLI 已验直接策略路径；需在当前 Codex 版本和受管策略环境上验证派生审批响应、项目配置跳过行为与策略限制。
3. **Windows Codex 命令分类：** 从本机真实 app-server 事件中采样命令形状，按实际 argv 与 shell 解析扩充分类，新增每类的 allow/prompt/deny 测试。任何无法静态解释的情况仍保持 fail-closed。
4. **跨平台策略一致性：** 为 Linux/macOS 的 safe、recommended、full-auto、conservative-auto 采用同样可验证的项目级请求入口，并由 POSIX 风险分类器答复；保留 sandbox 写入/网络边界。若某个 Codex 版本或 managed requirement 不允许此入口，就明确退回 Codex 原生 sandbox/升级审批并标示未经过 Ragent 全量分类，不得伪称同档位策略一致。评估 `granular` 作为类别级拒绝补充，不将它当作逐命令 gate。
5. **审批聚合与 UI：** 增加重复请求幂等、明确原因码与风险摘要；不要延长“批准一次”的范围，除非用户明确选择。
6. **分层验收：** 先跑规范化 adapter / policy tests，再用 Codex 官方账号 provider 和 Claude CLI 在本机 Windows 做真实命令回归，最后由荣耀手机通过 Ragent UI 验证自动操作不弹卡、危险动作只弹一张可解释审批卡、拒绝后未执行。OAuth refresh 问题修复前，Codex 真机验收项保持未完成。

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

- 本机 Windows Codex CLI `0.147.0`：启动参数只设置当前 cwd 项目 trust，不发送审批枚举；真实 `thread/start` 返回 `approvalPolicy=untrusted`、reviewer=user、正确 sandbox 和 workspace root。
- 本机真实 CLI fixture：推荐档 `git status --short` 无 owner prompt 自动执行；推荐档危险 `winget uninstall` 进入一个 owner 审批后拒绝；full-auto 对同一危险动作自动拒绝且无 owner prompt。
- 本机真实 managed Hook：Ragent hook 通过 App Server 注册和信任校验，执行 preToolUse 并改写安装命令；由于当前 Codex shell argv 缺少 `-NoProfile`，sidecar 将改写后的命令保留为 owner-gated，没有自动执行。
- Codex 0.149 的退役行为及当前 `granular` 能力依据官方文档与合并记录；新版真实 CLI 不在当前机器上，尚未验证它的 App Server 响应字段。
- 最近荣耀手机 Codex Official OAuth 运行在审批事件产生前因 refresh token 已使用而失败。手机端完整 OAuth → Ragent UI → 审批事件验收仍未完成；没有把 provider 的“可用”状态当作授权成功。
- 审批原因聚合、owner UI 原因呈现、跨平台逐命令策略及更广的 Windows shell 识别仍按上方实施顺序推进；当前不把它们记为完成。

## 外部依据

- [Codex 配置参考：approval_policy 与项目 trust_level](https://developers.openai.com/codex/config-reference/)
- [Codex 合并记录：移除 `approval_policy="untrusted"`](https://github.com/openai/codex/pull/39630)
- [Codex 审批与安全：从已废弃的 untrusted approval policy 迁移](https://learn.chatgpt.com/codex/agent-approvals-security)
- [Codex App Server：审批请求与响应协议](https://developers.openai.com/codex/app-server/)
- [Codex App Server README：managed human command checkpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
