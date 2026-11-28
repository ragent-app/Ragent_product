# Ragent Android UI 全面升级方案（Expressive Workspace）

> **更新日期**：2026-11-28  
> **目标模块**：`android/core/designsystem`、`android/core/agentui`、`android/feature/organization`、`android/feature/workbench`  
> **融合来源**：Gemini Android（Material 3 Expressive / Neural Expressive）交互与视觉范式 + 光学渲染与 `0fps` 省电工程理念 + Ragent 原有 One UI / Apple HIG 磨砂玻璃底座。  
> **开源合规红线**：本方案涉及的光学渲染与动效思路仅为图形学原理参考，严禁直接复制或移植任何 `GPL-3.0` 第三方源码；所有着色器、状态机、弹簧参数与 UI 组件均由 Ragent 以 Kotlin + Android AGSL 进行 **100% 洁净室原生实现**。

---

## 一、顶层设计原则：保留什么 vs 改造什么

### 1. 坚决保留（Ragent 已有强优势，不推倒重来）

1. **纯色底布 + AGSL 磨砂前景体系**：保留 `AgentoFrostedTokens` 与 `RagentTheme` 的 OLED 纯黑 `#000000` / 冷静浅灰 `#F4F4F7` 底布、`#566DD0` / `#8EA8FF` 蓝紫品牌色及 `LiquidGlassShaderSource` 折射玻璃层次。
2. **底部 3-Tab 透镜导航**：保留 `Chat` / `Home` / `Settings` 导航架构（`AgentoNavigation`），贴合多主机监控、多项目切换与跨会话审批工作台心智。
3. **Chat 页现有浮层框架**：保留顶部默认折叠为标题胶囊、点击才展开的 `RunDetailsIsland`，以及普通运行态隐藏、仅在待审批 / 异步追问 / 排队消息 / Goal 模式时互斥出现的 `RunDock`。
4. **输入栏纯图标与紧凑静息高度**：维持 `AgentComposer` 静息态 `48dp` 紧凑胶囊，展开态保留纯图标 `AgentoSpeedometerIcon`，不在底部轨额外塞入文字胶囊，也不引入过度留白导致可视高度受损。
5. **中英混排正文可读性**：保留 `RagentonversationTypography`（`15.5sp / 25sp`、`FontWeight(450)`）阅读韵律。

### 2. 核心改造目标（5 大升级支柱）

1. **原生 AGSL 动态粒子感光晕（`AgentoHorizonAura`）**：局部地平线 FBM 极光场 + 透视半调微粒点阵 + 胶片微粒与 TPDF 防色带抖动 + 6 态 Agent 语义生命周期 + 空闲/定格 `0fps` 休眠。
2. **全 App 设计语言收口 +「Ragent Live」沉浸语音**：清零 `feature:organization` 中大量原生 Material 3 组件漂移，将 `ButlerVoiceSheet` 重塑为语音优先的沉浸交互层。
3. **对话流内容质感升维**：运行期 `ThinkingRow` 精简为默认 1–2 行实时微摘要（点击展开全文），升级 4 类内联 Artifact 富卡片，增强流式柔淡入、长代码块折叠、空会话欢迎态与上下文容量轻液面指示。
4. **`+` 动作面板去重与配置衔接**：保持底部输入栏纯图标不变，重组去重 `ComposerActionSheet`，并优化 `EffortSliderPopover` 与模型选择器衔接。
5. **首屏态势焦点、短路径触达与设置收口**：升级 `HomeSurface` 静默 Hero/1 步快启入口与 2 列项目磁贴，在 `ProjectsSessionsSurface` L1 顶层增加最近对话快捷区，并将 `SettingsOverviewContent` 由 6 组收敛为 4 组高内聚结构及可视化主题色卡。

---

## 二、分模块详细规格

### 模块 0：设计系统底座与动态粒子感光晕（`core:designsystem`）

**涉及文件**：
- `core/designsystem/.../AgentoHorizonAura.kt`（新增）
- `core/designsystem/.../AgentoExpressiveComponents.kt`（新增）
- `core/designsystem/.../MotionPolicy.kt`、`RagentTheme.kt`
- `core/designsystem/src/test/.../AgentoHorizonAuraTest.kt`（新增）

#### 0.1 原生 AGSL 动态粒子感光晕（`AgentoHorizonAura`）

1. **5 层单 Pass AGSL 着色器（Android 13+ / API 33+）**：
   - **局部地平线极光场**：仅渲染在底部约 `32%` 视口高度域（`reach`），超出顶部羽化边界像素直接 Early-Return 透明；由双频正弦幕布 + 3 阶 FBM 域扭曲（Domain Warping）+ 高斯纵向衰减 + 边缘柔羽化合成。
   - **透视半调微粒点阵（粒子感核心）**：基于伪 3D 透视坐标投影（近大远密）与双正弦缓流波纹计算细微点阵；通过中强过渡能量带遮罩（band mask）与推进波峰约束，使发光微粒仅在极光能量过渡带中自然浮现，并带轻度色散提亮。
   - **胶片微颗粒 + TPDF 防色带抖动**：叠加轻量化动态噪点颗粒与三角分布交错梯度噪声（TPDF Interleaved Gradient Noise），彻底消除 OLED 纯黑渐变常见的暗部色带。
   - **深浅双光学分支**：Dark 模式走自发光与色散提亮路线；Light 模式走高饱和水彩/墨染光学混合分支（锚定 Ragent 蓝紫与冷青），保证浅色主题下依然清透干净。
   - **API 26–32 优雅降级**：使用轻量 `Canvas` 多层柔光渐变实现同一套语义色与 `0fps` 休眠纪律。
2. **Agent 语义生命周期与 `0fps` 省电休眠**：
   - `Start`（任务发出）：底部向上涌起推进光浪（~1.1s，~60fps）；
   - `Running`（执行中）：稳态呼吸涌动 + 柔和色散（自动限频 **~30fps**）；
   - `WaitingApproval`（待审批/追问）：切语义琥珀色温和脉冲 ~1.6s 后**静态定格进入 `0fps` 休眠**；
   - `Completed`（任务完成）：中心向两侧荡开水平完成涟漪 ~1.2s 后进入 **`0fps` 休眠**；
   - `Error`（失败/断连）：短暂错误警示脉冲后收束归零并进入 **`0fps` 休眠**；
   - `Idle`（空闲）：短暂过渡后静态定格或归零进入 **`0fps` 休眠**；
   - `Listening` / `Thinking` / `Speaking`（Ragent Live 语音）：响应 `voiceLevel`（`0f..1f`）实时起伏。
3. **移动端性能与无障碍硬护栏**：
   - **0.7x 降采样渲染**：以 `0.7f` 缩放分辨率计算片元再平滑拉伸；
   - **严格限定 3 处场景**：Chat 底部地平线（位于 `AgentComposer` 后方底层）、`ButlerVoiceSheet`（Ragent Live 语音层）、`Home` 静默/空态底部氛围带；
   - **无障碍响应**：`LocalMotionPolicy` 为 `Reduced` 时渲染静态单帧快照，`None` 时关闭动态与颗粒；页面后台化时停止帧循环。

#### 0.2 共享基础控件与 6 档语义弹簧

- **新增 4 个共享控件**：
  - `AgentoFilterPill`（替代原生 `FilterChip`）
  - `AgentoSegmentedTabs`（胶囊分段切换，复用导航透镜语言）
  - `AgentoProgressBar`（替代原生 `LinearProgressIndicator`，圆角胶囊轨）
  - `AgentoArtifactSurface`（交付物专用容器：`18dp` 圆角、淡品牌色头栏、`0.75dp` 细描边）
- **完善语义弹簧体系**：在 `AgentoSprings` 与 `AgentoMotion` 中补齐 `bouncy / gentle / micro / indicator` 及 `ExpressiveSpatial / ExpressiveSnappy` 阻尼弹簧曲线。

---

### 模块 1：`feature:organization` 视觉统一与「Ragent Live」语音重塑

**涉及文件**：
- `ButlerVoiceSheet.kt`、`ButlerOverviewScreen.kt`、`FactoryWorkScreen.kt`、`FactoryTeamWorkspace.kt`
- `ButlerVisualApprovalCard.kt`、`OrganizationBottomSheet.kt`、`OwnerReportNodeScreen.kt`、`TeamMessagesScreen.kt`

**具体改造**：
1. **全面清零原生 Material 3 控件漂移**：将 `ModalBottomSheet`、`FilterChip`、`OutlinedTextField`、`LinearProgressIndicator` 及常规 `Icons.Rounded.*` 统一收口为 `core:designsystem` 对应组件与 `AgentoWebIcon`。
2. **将 `ButlerVoiceSheet` 升级为「Ragent Live」沉浸语音层**：
   - 底部挂载随 `ButlerVoicePhase` 与 `rmsLevel` 联动的 `AgentoHorizonAura` 动态粒子声波光晕；
   - 顶栏精简为标题 + 职责副标题 + `⚙` 控制面板按钮 + 刷新 + 关闭；
   - 将工程诊断信息（如 `session.id / turnSeq / playbackGeneration`）、连续对话开关、历史语音会话恢复、模型引擎适配器选择以及跨设备接力面板收进 `⚙` 设置抽屉；
   - 跨设备接力增加一键点选设备胶囊（desktop / web / android 快速预设）并保留精确字段；
   - 默认语音优先，文字输入框默认收起，点击左下角键盘按钮展开（若已有草稿则自动保持展开）。

---

### 模块 2：Chat 对话流质感升维（保持现有岛架构不变）

**涉及文件**：
- `WorkbenchScreen.kt`、`TurnTimeline.kt`、`RunDetailsIsland.kt`、`RunDock.kt`
- `core/agentui/.../AgentUiComponents.kt`、`AgentMarkdown.kt`

**具体改造**：
1. **Chat 底部语义光晕挂载 + 清理死代码**：在 `ChatSurface` 底层挂载随 `(runStatus, approval, error, isEmptySession)` 驱动的 `AgentoHorizonAura`；清理 `RunDock.kt` 中未被引用的 `ActiveExecutingDock`。
2. **收紧运行期 `ThinkingRow` 占比**：活跃思考期间默认以紧凑的 1–2 行实时微摘要胶囊展示当前思考首/末句进展，点击后原地展开完整的 `220dp` 可滚动推理内容，保持 `thinking-row` / `thinking-content` 测试契约清晰。
3. **升级 4 类内联 Artifact 富卡片**：
   - **代码变更成果卡（`FileChangeSummaryCard`）**：头部增加彩色 `+N / -M` 增删统计胶囊与清晰文件计数，默认预览前 3 个变更文件；
   - **计划书卡片（`PlanArtifactCard` & `PlanBlock`）**：接入 `AgentoArtifactSurface` 视觉层级与 `AgentoProgressBar` 步骤完成进度条；
   - **交付附件 / Markdown 预览**：强化头栏图标、扩展名徽章与轻量化预览层次；
   - **命令卡（`ToolCallCard` / `CommandCard`）**：成功命令安静收拢，失败命令突出错误徽章并支持一键复制诊断。
4. **阅读与流式精修**：
   - `AgentStreamingMessage` 增加尾部轻量透明度平滑过渡；
   - `AgentMarkdown` 为已完成且 `>= 48` 行的超长代码块提供顶部语言栏复制 + 手动折叠/展开（显示首屏前段与总行数提示）；
   - `RunDetailsIsland` 展开态指标区增加轻量化上下文 Token 容量进度胶囊。
5. **空会话欢迎态焕新**：优化 `EmptyConversationSuggestionRail`，加入项目/主机语境化问候与轻量化磨砂建议胶囊。

---

### 模块 3：Composer `+` 面板去重（严格保持底部栏纯图标）

**涉及文件**：
- `ChatComposerAddons.kt`（`ComposerActionSheet`）
- `core/agentui/.../AgentUiComponents.kt`（`EffortSliderPopover`）

**具体改造**：
1. **严格维持输入栏纯图标与紧凑高度**：保留 `AgentoSpeedometerIcon` 与 `48dp` 静息胶囊不变，不增加任何额外文字标签胶囊。
2. **`+` 动作面板（`ComposerActionSheet`）去重重组**：
   - 顶部双格快捷操作卡（`图片`、`文件`）；
   - 工作模式组（`Plan`、`Goal`）；
   - 扩展能力组（`Agents`、`Connectors`）与去重后的独立斜杠命令栏（移除与上方模式开关重复的 `/plan`、`/goal`，保留 `/schedule`、`/grill-me`、`/learn`）。
3. **优化 `EffortSliderPopover` 内部模型入口**：在强度浮层顶部提供更清晰的当前模型徽章与切换箭头，一跳进入 `ComposerRuntimePickerPopover`。

---

### 模块 4：Home 首屏、Projects 快捷路径与 Settings 收口

**涉及文件**：
- `HomeSurface.kt`、`ProjectsSessionsSurface.kt`、`WorkbenchScreen.kt`（`SettingsOverviewContent` & 主题页）

**具体改造**：
1. **`HomeSurface` 首屏分层与 1 步快启**：
   - 静默状态（`summary.focus.isEmpty()`）升级为带 **1 步快启行动条** 的欢迎 Hero 卡（保留 `home-quiet` 标识），一键进入最近活跃项目开启新对话；
   - `NeedsAttentionSection` 增加语义琥珀细边提示；
   - `RecentProjectsSection` 升级为 **2 列紧凑项目磁贴网格**（最多 4 项），拉开与列表项的视觉节奏差。
2. **`ProjectsSessionsSurface` L1 顶层提效**：
   - 在 L1 项目列表顶部新增可折叠 **「最近对话（默认 3–5 条 + 展开更多）」** 快捷区块（无搜索词时展示），一步直达高频会话；
   - 优化 `SessionsHeader` 顶栏搜索收放体验，保持 `ProjectSearchDisclosureTest` 兼容。
3. **`SettingsOverviewContent` 6 组并 4 组 + 主题可视化色卡**：
   - 将现有 6 个分组收敛为：`账号与权限`、`设备与工作区`、`模型、工具与语音`、`外观与系统`，保留全部既有 `testTag`；
   - 主题设置页增加横向可视化色卡预览（Light / Dark / OLED / Amber / Monet）。

---

## 三、分阶段实施路线与验证门禁

| 阶段 | 核心交付 | 验证门禁 |
|---|---|---|
| **Phase 1A** | `core:designsystem` 原生 AGSL `AgentoHorizonAura` + 4 个共享控件 + 弹簧体系 | `:core:designsystem:testDebugUnitTest` |
| **Phase 1B** | `feature:organization` 清零原生 M3 漂移 + Ragent Live `ButlerVoiceSheet` | `:feature:organization:testDebugUnitTest` + 源码原生 M3 零残留扫描 |
| **Phase 2** | Chat 语义光晕 + `ThinkingRow` 微摘要 + 4 类 Artifact 卡 + 流式/长代码块优化 + 空会话欢迎态 + 清理 `ActiveExecutingDock` | `:core:agentui:testDebugUnitTest` + `:feature:workbench:testDebugUnitTest` |
| **Phase 3** | Composer `+` 面板去重 + `Home` Hero/2列磁贴 + L1 最近对话 + `Settings` 6并4与主题色卡 | `:feature:workbench:testDebugUnitTest` + `:app:compileDebugKotlin` + `public-boundary` 检查 |
| **Phase 4（后续可选）** | 独立评估升级 `composeBom`，补充共享元素转场 | 独立分支验证 |
