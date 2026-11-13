# Factory 控制入口与当前限制

状态：源码接线，尚无真实运行或设备验收证据。此文不表示 Factory 已具备自动执行或发布能力。

服务端认证后的 owner 可以按 `organizationId` 读取任务、详情、目标、操作回执及岗位消息。操作通过 Work Graph 再次授权并检查版本；客户端显示的按钮不是授权证明。任务详情中的状态和请求回执是不同事实：收到暂停或取消请求并不证明活动 Run 已停止。

`AGENTOC_FACTORY_CONTROL_ENABLED=true` 显式开放一般 Factory 控制命令及岗位信息消息；默认关闭。关闭后仍可授权读取、请求暂停或取消存量任务。自动调度器未由这些路由启动；有效执行能力不能由此开关推断。`GET /api/organizations/{organizationId}/factory/status` 返回开关、观察能力及尚未验证的执行状态。

写请求要求 JSON 内容类型。携带浏览器 Origin 时必须与直接连接的协议和 Host 一致，或精确匹配 `AGENTOC_FACTORY_TRUSTED_ORIGINS` 中逗号分隔的完整 origin（例如 `https://factory.example`）；不接受通配符、路径、凭据或不受信的转发头。TLS 终止代理后的公开 origin 必须由实例管理员显式配置。没有 Origin 的已认证原生客户端仍可使用既有安全传输，服务端始终执行 owner 和领域授权。

岗位信息和必须答复请求与只含引用的 Typed Envelope 在同一数据库事务中保存；发送方保存为认证用户，不冒充 Agent 节点。目标岗位的有界上下文包含消息正文和稳定 ID。只有实际 Run 已被启动入口接受、持久输入包含同一 ID 和正文、且当前岗位绑定及工作代次匹配时，才记录“已交付到本次执行”；这不代表模型已阅读。Agent 可使用仅限本岗位/Run 的签名能力显式确认或回复，确认本身不代表已答复；到期时标记 overdue，不自动视为同意。实际多 Harness 投递、回复和期限升级尚未验证或接入。不要在消息中包含凭据；基本模式过滤不能替代凭据管理。

Web 和 Android 可查看任务及请求优先级、暂停、取消，并在请求结果未知时使用相同命令 ID 重试。列表当前仅展示第一页并提示有更多记录；Android 离线缓存、真实网络重连、活动 Run 控制和真机显示尚未验证。角色授权变更对正在运行的执行的撤销处理及跨 Harness 交接仍需真实证据。

团队生命周期提供两步请求与完成：先进入 pending 停止新准入，再检查未决操作、工作、Run 及岗位绑定，条件不足时保留 pending 并说明原因；可以取消 pending。根 Session 重绑定与岗位 Session 替换是不同操作，前者保留根绑定历史，后者检查旧执行并使用岗位 bindingGeneration。跨存储检查和实际恢复仍需真实运行验收。Web 提供入口；Android 生命周期管理当前仅通过 API。

发布 API 仅登记本地产物、目标授权和发布请求，必须匹配已集成候选和服务端配置的 `factoryReleaseOutputRoots`。当前没有发布 provider，请求返回 `unsupported`、`published:false`；构建来源尚未验证，不等同已发布。
