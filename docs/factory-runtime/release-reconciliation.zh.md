# GitHub 发布中断后的对账

此流程只针对已配置且已授权的 GitHub Release。它不证明外部请求已停止，也不自动重发创建或上传。当前没有可跨进程重启证明原 `gh` 子进程及其外部请求均已结束的持久事实；不能以 TTL、父进程消失或共享 broker 状态代替。

1. 由已认证 owner 读取 `GET /api/organizations/{org}/factory/releases/operations/{operationId}`，保存返回的 operation ID、`persistedState`、冻结的 repository/tag/commit/asset digest、producer 状态、`recoveryGuidance` 和时间。不要记录凭据或产物正文。`state: unknown` 可能对应持久的 `sending`、`recovering` 或 `unknown`，不能把它当失败。条件性 resume 提示不代表授权或当前 draft 已验证。
2. 使用现有 `POST /api/organizations/{org}/factory/releases/operations/{operationId}/reconcile` 查询 provider。这个动作会访问 GitHub；有完整已发布事实时可记录发布事实和符合当前条件的里程碑。核对返回的 `currentObservation` 与历史回执，不把某次查询结果视作永久当前状态；查询失败仍是 unknown。
3. 若观察为 `published`，保存实际 release/asset 身份、tag 对应 commit 和资产 digest，与冻结输入逐项比对。已有已发布回执是历史事实；后续外部变更需单独记录。原 producer 未有完成回执或有恢复历史时，数据库备份仍可能阻断，不能仅凭发布成功解除该阻断。
4. 若持久状态为 `unknown` 且 observation 为 `draft_verified`，owner 可在授权仍有效、目标与资产未变时使用现有 `resume` 路由和新的稳定幂等键，显式尝试完成该唯一完整 draft。该路径会重新校验，不补传、不覆盖资产；同键重试不重复发送。
5. 如果持久状态仍是 `sending`/`recovering`，或远端不存在、draft 空/部分、资产集合或 tag 不符、查询不可用：保持阻断，保留操作 ID、冻结输入和已观察事实，交由实例管理员及发布负责人核查原实际 producer 的退出及外部请求是否确实结束。必要证据须能覆盖原 producer incarnation 和其直接命令/外部请求；当前产品未提供足够的持久完成证明或安全解除此类阻断的入口。不要改数据库状态、按时间猜测、重复发起创建/上传，或把人工判断写成已验证结果。完成证据和支持安全恢复的产品能力到位前，仍需人工处置，不能承诺该状态自动恢复。

这是一份处置指南，未执行实际 GitHub 查询或发布。已有实现及未完成项见 [实施状态](implementation-status.zh.md)、[阶段 4](phase-4-delivery.zh.md)。
