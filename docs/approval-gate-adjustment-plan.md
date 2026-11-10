# Ragent 审批链路调整方案：Claude Code 与 Codex

日期：2026-11-10  
状态：方案；尚未实现本文件中的新增兼容性调整

## 结论

现在的审批请求过多，不宜简单归因于“自动审批器坏了”。Ragent 已有自动决策和自动响应路径；问题主要在于 Harness 是否会把动作送到该路径、Ragent 能否识别请求，以及识别失败时的保守回退。Claude Code 与 Codex 的权限协议不同，不能用一个 Harness 档位名假定它们会产生相同的审批事件。

Codex 有一个明确的兼容性风险：Ragent 当前在 Windows 的受控档位中显式发送 `approvalPolicy=untrusted`。本机已安装的 Codex CLI 是 `0.147.0`，该版本的命令行帮助仍接受它；当前 Codex 官方配置文档已说明 `approval_policy="untrusted"` 不再支持，较新版本可能在运行开始时拒绝此值。官方迁移方式是设置项目 `trust_level="untrusted"`，并省略显式 `approval_policy`。因此应改成每个 Ragent Run 的项目级信任配置，不能继续依赖已废弃的审批枚举。

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

| Ragent 档位 | 当前 Codex Windows Harness | 当前非 Windows Harness | 结果与限制 |
|---|---|---|---|
| safe / recommended | `untrusted` + `danger-full-access`，`approvalsReviewer=user` | `on-request` + `danger-full-access` | Windows 旧版 Codex 会为非 trusted 命令发请求，Ragent 再分类；非 Windows `on-request` 只覆盖 Codex 自己决定升级的动作，Ragent 看不到每条普通命令 |
| full-auto | Windows 仍强制使用 `untrusted` 以便 Ragent 拦截；非 Windows 当前默认为 `never` + `danger-full-access` | Codex 请求不能由分类器自动放行时会自动拒绝 | Windows 旧版链路能实现“安全自动、风险拒绝”；非 Windows 当前无普通命令审批入口，不能宣称危险命令由 Ragent 拒绝；新 Codex 版本还需解决 `untrusted` 兼容性 |
| conservative-auto | `on-request` + `workspace-write` | 同左 | 沙箱限制工作区与网络，但普通工作区命令不会全部经过 Ragent 分类；如果档位承诺逐命令风险审核，这个映射不够 |

此处 `danger-full-access`、`workspace-write` 是 Harness sandbox，不等于 Ragent 的风险档位。Ragent 不应把 `approvalPolicy=never` 或绕过审批作为消除提示的办法；这样会让危险操作绕过审批事件入口。

### 为什么 Codex 仍可能产生多张人工审批卡

1. **请求触发面不同。** `on-request` 只覆盖 Codex 要求升级权限的动作。它不会保证所有命令都到 Ragent 风险分类器。Codex 不发请求时，Ragent 无法替它审查该动作。
2. **Windows 分类器只对可证明的命令自动放行。** `windows-approval-gate.mjs` 目前要求 Codex 命令能被还原为受信任的 PowerShell 可执行文件、`-NoProfile` 参数及可静态分析脚本。未知 shell、非 PowerShell 命令、工作目录/路径上下文缺失、额外权限、未知工具、没有对应活动项的文件变更都会保守地转人工审批。这个 fail-closed 行为安全，但覆盖面不足会表现为大量提示。
3. **Codex `untrusted` 的旧语义本身会发出较多请求。** 在仍支持该枚举的 Codex 版本中，它会对非内置 trusted 命令请求审批。Ragent 必须成功自动答复这些请求，用户才不会看到卡片。
4. **有些请求应保留人工确认。** `item/permissions/requestApproval`、MCP elicitation、额外文件系统/网络权限、信息不完整的文件变更、Codex 删除/移动请求目前不能只凭命令文本证明安全，不能为了降提示量而放宽。
5. **当前真机复现被 OAuth 阻断。** 荣耀手机最近一次 Codex Official Account 只读运行在执行命令前报 refresh token 已使用，未到审批阶段。本机 Windows Codex CLI 的本地 fixture 已验证 `git status --short` 自动通过、危险 `winget uninstall` 在执行前进入拒绝/审批路径；这证明了该 fixture 的 gate 行为，但还不能证明手机实际会话中的提示数量。

## 调整目标

让 Ragent 风险档位决定“哪些动作自动放行、哪些动作需要用户、无人值守时如何拒绝”；让 Codex sandbox 继续限制进程可触达的范围；让所有应进入 Ragent 决策的动作都能被同一套策略识别。提示卡必须给出明确原因，并且同一请求的重放不能产生重复卡片。

## 完整调整方案

### 1. 移除对 Codex `approvalPolicy=untrusted` 的直接依赖

为需要 Ragent 逐命令决策的 Codex 档位，给当前 Run 的工作目录配置 `projects.<cwd>.trust_level="untrusted"`，不写入用户的全局 Codex 配置、不改项目文件；同时在 Codex `thread/start`、`thread/resume`、`thread/fork` 与 `turn/start` 中省略显式 `approvalPolicy`。官方文档指出显式 `on-request` 会覆盖项目派生策略，因此只改项目 trust 而仍发送 `on-request` 不会生效。

优先验证能否通过 App Server 进程的配置覆盖参数设置此项目级值。`codex app-server` 支持 `-c/--config key=value`，但含 Windows 路径的项目键如何转义、进程级覆盖是否只作用于当前 Run，须在 fixture 中验证后才能采用。禁止为试验改写用户的 `~/.codex/config.toml`，也不复制或迁移 OAuth 凭据。

在首个 thread 响应中校验有效 `approvalPolicy`、`approvalsReviewer`、sandbox 与目标 cwd。若没有取得受控审批策略，或 Codex 版本/组织 requirements 不允许项目级策略，就在送入用户 prompt 前中止该 Run 并显示兼容性错误；不得悄悄退回 `on-request` 后仍声称 Ragent 会逐命令风险审查。

项目 `trust_level="untrusted"` 会跳过仓库内 `.codex/` 层的配置、hooks 与 rules。需要在方案实施时确认 Ragent 对应配置来自进程/用户层而不是项目层，并明确告知这一差异；如果会破坏现有用户工作流，应改用经验证的进程级审批策略方案，不可静默覆盖。

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
2. **Codex 策略兼容：** 实现并验证进程级项目 trust 设置、`approvalPolicy` 省略行为、有效策略回读和错误提示。先覆盖本机 `0.147.0`，再覆盖当前不支持直接 `approval_policy="untrusted"` 的版本；同时验证 managed requirements 限制。
3. **Windows Codex 命令分类：** 从本机真实 app-server 事件中采样命令形状，按实际 argv 与 shell 解析扩充分类，新增每类的 allow/prompt/deny 测试。任何无法静态解释的情况仍保持 fail-closed。
4. **跨平台策略一致性：** 让 Linux Codex 的逐命令 gate 使用同样可验证的项目级请求入口；若无法获取全量请求，就明确标注该档位只依赖 Codex 的 sandbox/升级审批，不能宣称 Ragent 分类过所有命令。
5. **审批聚合与 UI：** 增加重复请求幂等、明确原因码与风险摘要；不要延长“批准一次”的范围，除非用户明确选择。
6. **分层验收：** 先跑规范化 adapter / policy tests，再用 Codex 官方账号 provider 和 Claude CLI 在本机 Windows 做真实命令回归，最后由荣耀手机通过 Ragent UI 验证自动操作不弹卡、危险动作只弹一张可解释审批卡、拒绝后未执行。OAuth refresh 问题修复前，Codex 真机验收项保持未完成。

## 验收用例

| 用例 | 预期 |
|---|---|
| Codex `git status --short`、工作区内只读查看 | 单个请求自动响应；owner 提示为 0 |
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

- 本机 Windows Codex CLI：`0.147.0`；其 `codex --help` 仍列出 `untrusted`。Codex 官方当前配置文档已标记该枚举 unsupported，因此必须覆盖版本迁移。
- 现有本地真实 CLI fixture：Codex `git status --short` 自动通过；危险 `winget uninstall` 在执行前被拦截。该结果不能替代通过荣耀手机走完整服务与 Ragent UI 的验收。
- 最近荣耀手机 Codex 官方 OAuth 运行在审批事件产生前因 refresh token 已使用而失败；目前不能用这次运行判断审批提示量。
- 在方案第 2 步前需要确认运行中的 Codex App Server 是否为每 Run 独立进程，以及 `-c projects."<cwd>".trust_level="untrusted"` 是否能对 thread 返回预期的有效 `approvalPolicy`。未通过前不应修改已通过的 Claude/Codex gate 源码。

## 外部依据

- [Codex 配置参考：approval_policy 与项目 trust_level](https://developers.openai.com/codex/config-reference/)
- [Codex 审批与安全：从已废弃的 untrusted approval policy 迁移](https://learn.chatgpt.com/codex/agent-approvals-security)
- [Codex App Server：审批请求与响应协议](https://developers.openai.com/codex/app-server/)
- [Codex App Server README：managed human command checkpoints](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
