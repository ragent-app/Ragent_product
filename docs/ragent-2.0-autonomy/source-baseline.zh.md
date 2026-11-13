# 工作区来源基线

本轮开始时所在分支为 `main`，HEAD 为 `64014e687407514f57856a6e7005a1c505483a3e`。以下为开始实施前观察到的已有工作区改动；本轮不将其归因于自治升级，也不覆盖或清理。当前状态应以 `git status --short` 为准，多人并行后不能用当前差异反推初始状态。

实施期间只读观察到 HEAD 前进至 `b6f8b681b68176383b2ff7b875cfd2f109dd535a`（`feat: add Android PRoot account linking and remote access`）；从起始 HEAD 至此另有五个提交，其中包括 Factory acceptance/checks 和 reminder 恢复相关变更。自治方案目录和本轮新增责任、设备与连接器源码未在该段提交中，交付前应以当时 HEAD 和工作区重新审阅。

随后 HEAD 曾前进至 `1a251cc1`（`Accept strictly fenced approval review JSON`）；实际交付提交仍须在提交时重新确认 HEAD 和 index。期间已有 Factory steering、evidence retention、部分 Factory 视图及其他并行工作进入历史，不能将这些已提交内容重复归因或覆盖。

已修改：

```text
android/app/src/main/AndroidManifest.xml
android/app/src/main/java/com/andysagent/agentoc/AgentoCApplication.kt
android/app/src/main/java/com/andysagent/agentoc/MainActivity.kt
android/app/src/main/java/com/andysagent/agentoc/TargetRuntime.kt
android/app/src/main/res/values-zh-rCN/strings.xml
android/app/src/main/res/values/strings.xml
android/core/auth/src/main/kotlin/com/andysagent/agentoc/core/auth/AccountSessionManager.kt
android/core/auth/src/main/kotlin/com/andysagent/agentoc/core/auth/AndroidTemporaryEncryptedStore.kt
android/core/auth/src/main/kotlin/com/andysagent/agentoc/core/auth/PairingAuthenticator.kt
android/core/datastore/src/main/kotlin/com/andysagent/agentoc/core/datastore/ClientConfigStore.kt
android/core/network/src/main/kotlin/com/andysagent/agentoc/core/network/OkHttpAgentoCTransport.kt
android/feature/workbench/src/main/java/com/andysagent/agentoc/feature/workbench/GoogleSignInGuideScreen.kt
android/feature/workbench/src/main/java/com/andysagent/agentoc/feature/workbench/WelcomeScreen.kt
android/feature/workbench/src/main/java/com/andysagent/agentoc/feature/workbench/WorkbenchScreen.kt
android/feature/workbench/src/main/res/values-zh-rCN/strings.xml
android/feature/workbench/src/main/res/values/strings.xml
chat-server.mjs
chat/account-pairing-service.mjs
chat/organization-session-lifecycle.mjs
chat/organization-store.mjs
chat/router-control-routes.mjs
chat/router-public-routes.mjs
chat/run-execution-boundary.mjs
chat/run-launcher.mjs
chat/session-api-scope-routes.mjs
chat/session-manager.mjs
chat/triggers.mjs
chat/trusted-devices.mjs
chat/ws.mjs
lib/auth.mjs
lib/binding-authority-runtime.mjs
lib/config.mjs
lib/owner-account-auth.mjs
lib/owner-auth-instance-poller.mjs
lib/p2p-host-agent.mjs
lib/p2p-host-registry.mjs
scripts/stage-runtime-payload.mjs
tests/test-chat-add-menu-panels-visual.mjs
tests/test-chat-add-menu-panels.mjs
tests/test-desktop-service-probe.mjs
tests/test-session-api-scope.mjs
```

未跟踪：

```text
android/app/src/main/java/com/andysagent/agentoc/LocalAccountLink.kt
android/app/src/main/java/com/andysagent/agentoc/LocalRuntime.kt
android/app/src/main/res/xml/network_security_config.xml
chat/proot-account-link-routes.mjs
docs/android-proot-account-remote-plan.md
docs/android-proot.md
docs/ragent-2.0-autonomy-revised-plan-2026-11-13.zh.md
docs/ragent-2.0-autonomy/
infrastructure/admin-console/__pycache__/
lib/proot-account-link-state.mjs
lib/proot-local-pairing.mjs
packaging/proot/
scripts/archive-proot.py
scripts/build-proot-p2p-host.sh
scripts/build-proot-release.sh
scripts/stage-proot-snapshot.mjs
scripts/write-proot-identity.py
```
