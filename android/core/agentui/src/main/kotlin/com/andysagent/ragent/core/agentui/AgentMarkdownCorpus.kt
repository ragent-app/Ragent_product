package com.andysagent.ragent.core.agentui

/**
 * Shared Markdown corpus for cross-end rendering baselines.
 *
 * The same source text is rendered by the web client (GFM `marked` pipeline)
 * and the native [AgentMarkdown] renderer. Contract tests assert the native
 * block model, and the reading sample drives screenshot baselines
 * (`MarkdownReadingScreenshotTest`, plus the weight comparison 400/450/500
 * recorded in `docs/markdown-rendering-contract.md`).
 *
 * Keep the samples deterministic: no timestamps, no random content, no
 * streaming-only constructs.
 */
object AgentMarkdownCorpus {
    /**
     * Full reading sample: mixed CJK/Latin prose with bold, inline code,
     * links, ordered/unordered/nested/task lists, a quote, a fenced code
     * block, a wide table (forces horizontal scroll on phones) and a divider.
     */
    val readingSample: String = """
        # 阅读基线样本

        这是一段中英混排的正文，用来核对视觉字重、行高与字面密度。ChatGPT 的正文笔画比我们更稳，
        所以这里同时放 400、450、500 三档对照。段落之间保持自然的呼吸感，The quick brown fox
        jumps over the lazy dog while agent streams tokens into the timeline.

        第二段继续检验长句：当 `InlineCode` 出现在中文句子里时，行内的垂直节奏不应抖动；链接如
        [Ragent 文档](https://example.com/docs) 与 **加粗强调** 混排时，基线也要保持稳定。

        ## 列表与任务

        - 一级列表项：验证项目符号与正文的字号对齐
          - 二级列表项：缩进节奏 20dp
        - [ ] 未完成任务：等待审批
        - [x] 已完成任务：连接电脑

        1. 第一步：打开 Workbench
        2. 第二步：选择 Project
        3. 第三步：创建 Session

        > 引用：设计目标是连续阅读，而不是文档堆叠。中文笔画应保持稳定密度，
        > 引用文字与正文保持一致的字重。

        ### 代码与表格

        ```kotlin
        val session = ragent.connect("workbench")
        session.stream { token -> render(token) }
        ```

        | 参数 | 说明 | 默认值 | 适用范围 | 备注 |
        | --- | --- | --- | --- | --- |
        | fontWeight | 正文字重基线 | 450 | 全部消息 | 由截图基线选定 |
        | lineHeight | 行高 | 25sp | 正文与列表 | CJK/Latin 混排锁定 |
        | letterSpacing | 字距 | 0.2sp | 正文 | 仅 Latin 微调 |
        | tableScroll | 宽表横滑 | enabled | 窄屏 | 尾部渐隐提示 |

        ---

        删除线 ~~旧方案~~ 与自动链接 https://example.com/release 也应保持一致表现。
    """.trimIndent()

    /** Heading-only sample for heading hierarchy baselines. */
    val headingSample: String = """
        # 一级标题 Heading 1
        ## 二级标题 Heading 2
        ### 三级标题 Heading 3
        #### 四级标题 Heading 4

        标题之后跟一段正文，用来检查层级间距与正文的视觉对比。
    """.trimIndent()
}
