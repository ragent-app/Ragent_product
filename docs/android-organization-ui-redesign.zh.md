# Android 团队协作页 UI 实施规格 v3

设计负责人：主代理。2026-11-16。用户已授权恢复 UI 实现。

本规格取代 v2；设计与具体参数由主代理确定。参考 [Google Design 关于 Gemini 插画系统的说明](https://design.google/library/gemini-ai-visual-design)，其讨论渐变、圆形和有意图的动效；本项目选用安静的单层微渐变，以保持节点可读和界面稳定，不采用塑料高光、多色流动或持续呼吸动画。下列颜色和参数是本项目设计，不是 Google 官方数值。

## 1. 整页排版

- 使用 `LocalRagentColors` 和 `RagentUiFont`，支持原应用所有主题，不引入新全局主题或字体。
- 页面背景 `colors.canvas`；浅色原主题 #F4F4F7、深色原主题 #000000。内容宽度上限 600dp，宽屏居中；手机左右 20dp。
- 页面使用纵向正常布局：导航、任务摘要、图形区域、动态卡。不能把导航/卡片绝对覆盖在图上。
- 状态栏与导航栏 inset 仅消费一次；导航实际高度 56dp，顶部/底部额外间距 8dp。
- 返回与更多按钮各 48dp 触摸区、20dp 图标，圆形低对比背景 `quietSurface`。
- 中央标题胶囊高 48dp，最大宽 216dp；标题 15sp/20sp、Medium，副标题 11sp/15sp、Regular。标题“团队协作”，副标题“n 位成员”；不出现 Revision、Radar、内部 ID。
- 中央胶囊用现有轻玻璃组件的静态 fallback，保留可读性；不添加新的实时模糊或阴影渲染依赖。主图与节点不加玻璃。
- 菜单只放真实可用的“查看任务”“成员消息”“重置视图”；无回调就不显示对应操作。演示重排另见第 7 节。
- 任务区顶部 20dp、底部 12dp。第一行 12sp/18sp 次要色“当前任务”，演示页同一行带“演示”小胶囊（10dp 横向/4dp 纵向内边距）。
- 任务标题 26sp/34sp、Medium，最多 2 行省略；空值“团队工作空间”。状态说明 13sp/20sp、次要色，顶部 6dp，最多 2 行。只映射真实状态，未知写“等待状态更新”。不无条件宣称正在工作。
- 图形区域占剩余可用高度，理想 360dp，最小 280dp，最大 460dp；内部裁剪。紧凑横屏或大字体导致可用高度不足时，整页纵向滚动且图高 300dp，不压扁节点，不裁掉底部内容。
- 动态卡与图间距 12dp，页面底部间距 16dp + 导航栏 inset。无真实发送回调不显示输入框；本轮不添加假的输入框。

## 2. 节点参数

- 中心负责人直径 64dp，其余节点 56dp；触摸容器统一 64dp，中心与布局坐标一致。
- 单层线性微渐变圆面，无描边、额外高光、纹理、光晕或投影。中心使用 Google Material Symbols Rounded 图标，画布色呈镂空观感，负责人 28dp，其余 24dp；数字簇仍为 20sp。圆外不追加文字。
- 图内所有节点下方、旁边均不显示姓名、角色、状态文字。无障碍仍读完整名字、状态、任务和阻塞信息。
- 职责优先：组织负责人 explore、规划管理 route、阶段负责人 flag、审核 find_in_page；专家/执行者/编写者及未知职责优先使用可识别的专业图标，否则分别回退 psychology/construction/edit_note/person。簇显示 +n。
- 专业图标键共有32个有限视觉类别，不是专业白名单：backend=dns、mobile=smartphone、web=web、runtime=terminal、architecture=schema、database=database、data=analytics、ai=auto_awesome、cloud=cloud、network=hub、hardware=memory、security=shield、testing=bug_report、design=palette、product=category、research=science、writing=edit_note、translation=translate、education=school、business=work、finance=account_balance、legal=balance、health=medical_services、marketing=campaign、sales=storefront、people=groups、operations=settings_suggest、logistics=local_shipping、media=movie、environment=eco、engineering=precision_manufacturing、general=person。android/ios 图标键别名为 mobile。
- 负责人可自由指定任意语言的专业名称。领导 Agent 可在原有分工输出中附加可选 iconKey，不额外调用模型；客户端仅识别明确键，不从名称关键词猜测。未知键回退职责或通用图标，详情和无障碍保留真实名称。图标与许可证来源见 Android 模块 third_party/material-symbols-rounded。
- 三色 stop 为 0、0.55、1，起点 `(0.12W, 0.08H)`，终点 `(0.88W, 0.92H)`；按尺寸缓存画刷。色族浅色 / 深色色表：紫 `#657AA5 #6E76A6 #7B73A1` / `#ADC1E5 #BAC1E9 #C5BEE5`；蓝灰 `#6F8997 #798696 #838293` / `#95B2BE #9EB0BC #A8ADBB`；蓝 `#6487A8 #6E84A6 #7A80A1` / `#92B6D5 #9FB2D4 #AEAED0`；绿 `#64887F #6E887C #7A8A78` / `#98BCAF #A6BCAB #B2BCA8`；暖 `#958263 #9B846C #A08776` / `#C5B58F #CBB69B #D0B7A8`。以 canvas 的相对亮度判断深浅；其他主题不据此宣称对比度全面达标。
- 上述五组依次称紫、蓝灰、蓝、绿、暖色；专业视觉色族为蓝：mobile/web/data/ai/hardware/cloud/network/backend/runtime；紫：architecture/security/design/product/education/legal；绿：database/people/operations/logistics/environment/engineering/general；蓝灰：research/writing/translation/business；暖：testing/finance/health/marketing/sales/media。职责优先或回退时，负责人/专家用紫、管理/阶段负责人用蓝灰、执行者/未知用绿、编写者用蓝、审核用暖色。
- 状态点直径 7dp，外侧画布色隔离环 2dp，圆心在本节点半径的右下 45° 位置。IDLE 不显示；WORKING/REVIEWING 使用主题 running；WAITING/PROVISIONING/PAUSED 用 secondaryContent；BLOCKED/FAILED 用 error；DONE 用 success。静态状态点，不无限闪烁。
- 按压复用原聊天页 `rememberAgentoPressScale`；不叠加第二套按压动画。
- 单击打开成员详情 sheet，双击保留聚焦；簇点击展开。聚焦尺度 1.06，其他节点透明度 0.50；聚焦中心节点时全体维持 1.0。无焦点默认 1.0。

## 3. 非对称放射布局

坐标计算统一采用实际图区域的 px，所有 dp 参数乘 density；不使用整屏尺寸作为图区域尺寸。

- 中心：`(W*0.50, H*0.46)`。
- 先保留真实节点、真实边和既有簇展开语义，再为可见非中心节点稳定排序：层级前序，兄弟按 role 次序（manager、worker、expert、reviewer）再按 domain 与 id；同一投影反复刷新不随机排位。遍历需 visited 防循环，孤立成员仍可见。
- 非中心可见数 1：角度 [35°]；2：[-145°,35°]；3：[-125°,-15°,110°]；4：[-155°,-37°,100°,160°]。角度 0 在右，90 在下。
- 对应半径倍数循环 [0.88,1.00,0.92,1.08]。
- 第一圈基础半径 `R = min(132dp, (W/2-44dp)/1.08, (min(centerY,H-centerY)-40dp)/1.08)`。正常手机最小图高280dp时保证可读；极端小宽度由可平移画布容纳，R 下限 84dp，绝不缩小节点字。
- 5–6 个非中心成员第一圈均分角度，从 -145° 开始，偶数槽 +5°、奇数槽 -5°；保持上述半径倍数。超过6个时按第一圈6个、后续每圈8个，第二圈基础半径 R+100dp，后续每圈+100dp；第二圈起始角 -120°，与内圈错开。保持已有平移缩放供查看外圈。
- 不把所有兄弟摆成同一水平线，不强制层级等距。连线仍显示真实关系，不为外观伪造中心到所有人的关系。
- 聚焦非中心成员时，该成员沿本身中心射线外移 10dp，其他成员目标不变；取消聚焦回原位。选中 sheet 不改变图布局。
- `previousPositions` 不可覆盖新目标坐标而冻结布局；连续运动由 UI 内以 node.id 为 key 的动画状态承接。

## 4. 边与阻尼弹簧

- 成员位置弹簧：归一化质量 1，刚度 k=140，阻尼比 ζ=0.74（等效 c≈17.51）。中心：质量1，k=260，ζ=0.92（c≈29.67）。Compose 使用 stiffness/dampingRatio，不把 c 填成阻尼比。
- 节点中途换目标承接当前位置和速度；以 node.id 保留状态，不按列表索引重建。无需持续物理循环；到达目标后静止。
- 边端点每帧取同一份动画节点坐标。起终点裁至节点当前可见圆周，包含焦点缩放；不能另建不同步 tween。
- 边为连接真实关系的直线，起终点裁至当前动画节点的圆周；不再进行曲线候选搜索或弯曲偏移动画。
- 当前五节点静态几何检查仅覆盖该布局，不能证明任意拓扑均不穿越无关节点，也不能代表真机动画性能。
- 普通边 1.25dp，secondaryContent 基色 alpha=0.22；审核边同宽、alpha=0.28，虚线 4dp 实/5dp 空，端帽 Round。再乘焦点产生的 edge.alpha，普通默认 edge.alpha=1。
- 本轮不创造后台不存在的通信事件。已有真实粒子不新增随机路径；Reduced/None 下不显示移动粒子。
- 当前 `ParticleUiState` 缺少关联边标识，不能可靠绑定新的动态路径，本轮先不渲染这类游离粒子。保留已有事件和活动数据；真实通信路径接入不作为本轮已完成能力。
- Full：上述弹簧；首次整幅图透明度 0→1，180ms，不把所有节点从同一点弹出。
- 焦点缩放Full使用320/.88弹簧，透明度120ms；Reduced缩放立即到位、透明度100ms；None全部立即。连线裁圆半径使用同一动画缩放值。首次淡入等实际非空节点到达后开始。
- Reduced（主题偏好或 uiState.reduceMotion）：位置立即到位，无回弹；首次淡入 100ms；None：全部立即到位，0ms。不可留下全局动画设置关闭后仍在跑的图动画。
- 图区域缩放/平移复用原能力；不添加单节点拖拽功能。本轮不承诺该功能已存在。

## 5. 动态卡与成员详情

- 动态卡圆角26dp、背景quietSurface、内边距18dp，无边框和重阴影。
- 标题“协作动态”15sp/20sp Medium；右侧展开/收起按钮至少48dp触摸区。
- 收起显示最多2条，展开最多6条；每条正文13sp/20sp，最多2行；行间距12dp。只有源数据存在可信时间才显示时间。
- 无事件显示“还没有协作动态”，13sp/20sp 次要色；不显示运行绿点暗示团队正忙。
- 卡片展开 Full 使用尺寸弹簧 stiffness320、dampingRatio0.88；Reduced 100ms淡入且无尺寸弹簧；None立即。尺寸变化自然影响图区域的可用空间与目标坐标。
- 成员 sheet 使用原有胶囊玻璃外壳；顶部圆角28dp，横向24dp内边距，底部16dp+导航栏inset。拖拽柄36x4dp，上12dp下16dp。
- 名字22sp/28sp Medium，角色及状态13sp/20sp；任务与活动采用直接文字分段、间距16dp，不堆叠多层小卡片。只有实际有值的进度、文件、阻塞数据才显示。
- 详情可滚动，长名字可换行，状态不能挤出屏幕。操作高度48dp，使用已有按钮样式；无真实回调不显示指令/审批操作。
- 中文/英文文案进入资源，禁止在真实页面凭空补文件、检查点、活动或成功状态。
- 全屏成员详情沿用canvas、最大600dp居中、横20dp，返回触摸48dp/图标20dp，名字22sp/28sp Medium；角色状态13sp/20sp本地化。内容可滚动，段间距24dp，段标题12sp/18sp次要色，正文15sp/24sp，不堆叠卡片。Session ID不占主视图，缺失字段不生成占位事实；无任务显示“暂无任务”。系统返回应先退出详情回到图。

## 6. 包装层与数据

- 真实页、离线页、演示页视觉采用同一导航与内容间距。
- 无快照的离线/错误页复用同一导航：人数未知时不显示人数副标题；无菜单动作时右侧保留48dp空位，不显示无效按钮。该分支自身消费一次系统inset，内容最大600dp居中、横20dp。
- 离线/错误使用quietSurface圆角26dp、24dp内边距；主提示16sp/24sp，辅助13sp/20sp，不在产品UI泄露异常栈。
- 保留认证失效清除缓存、owner/target/session隔离、授权快照只读访问。不得改网络、代理或配对。
- 演示为独立内存数据，不写真实缓存、不发后台请求，继续清晰标注演示。
- 只有一层页面 inset、一层导航；禁止再次在原聊天标题上叠加入口。

## 7. 现有演示的有限交互

- 继续使用用户已授权的5个演示成员，不添加测试数据集或业务测试。
- 演示菜单可放“展开成员 / 收起成员”：复用真实簇/聚焦行为，或提供本地演示视图变化用于观察弹簧；不自动循环、不假装执行后台任务。
- 优先采用双击成员聚焦外移10dp、重置归位展示弹簧；若足够则不增加演示专用控制。
- 不新增人为假动态，只展示已有演示投影的真实字段。空动态就使用空态。

## 8. 执行与验收

- 主代理负责设计参数、审查和最终视觉判断；Terra负责实现。遇到参数冲突回报主代理，不自行换风格。
- 三名代理分开文件；main共享树，不新建worktree，不纳入并发任务改动。
- 静态检查与直接相关编译先行。不新增测试、测试脚本或无意义探针。
- 复用已有Android工具链/缓存；打包交用户指定线程。真实UI验收使用已授权设备与演示入口，检查布局、触摸、详情、聚焦/重置的连续运动。
- 编译通过不代表视觉或帧率验收通过；未观察的主题/尺寸/性能明确报告。
