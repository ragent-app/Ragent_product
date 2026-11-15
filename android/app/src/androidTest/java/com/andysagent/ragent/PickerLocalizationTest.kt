package com.andysagent.ragent

import android.content.res.Configuration
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class PickerLocalizationTest {
    @Test fun composerSupportCountsResolveSingularAndPluralInSevenLanguages() {
        val expected = mapOf(
            "en" to listOf("1 message queued", "2 messages queued", "1 attachment", "2 attachments"),
            "zh-CN" to listOf("1 条待发消息", "2 条待发消息", "1 个附件", "2 个附件"),
            "zh-TW" to listOf("1 則待傳送訊息", "2 則待傳送訊息", "1 個附件", "2 個附件"),
            "ja" to listOf("1 件のメッセージが送信待ち", "2 件のメッセージが送信待ち", "添付ファイル 1 件", "添付ファイル 2 件"),
            "ko" to listOf("대기 중인 메시지 1개", "대기 중인 메시지 2개", "첨부파일 1개", "첨부파일 2개"),
            "fr" to listOf("1 message en attente", "2 messages en attente", "1 pièce jointe", "2 pièces jointes"),
            "es" to listOf("1 mensaje en espera", "2 mensajes en espera", "1 archivo adjunto", "2 archivos adjuntos"))
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        expected.forEach { (tag, strings) ->
            val resources = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(tag))
            }).resources
            assertEquals(tag, strings, listOf(
                resources.getQuantityString(WorkbenchR.plurals.composer_queued_messages, 1, 1),
                resources.getQuantityString(WorkbenchR.plurals.composer_queued_messages, 2, 2),
                resources.getQuantityString(WorkbenchR.plurals.composer_queued_attachments, 1, 1),
                resources.getQuantityString(WorkbenchR.plurals.composer_queued_attachments, 2, 2)))
        }
    }

    @Test fun goalPanelResolvesInEverySupportedLanguage() {
        val titles = mapOf("en" to "Session goal", "zh-CN" to "会话目标", "zh-TW" to "對話目標",
            "ja" to "会話の目標", "ko" to "대화 목표", "fr" to "Objectif de la session", "es" to "Objetivo de la sesión")
        val ids = listOf(WorkbenchR.string.goal_title, WorkbenchR.string.goal_close,
            WorkbenchR.string.goal_input, WorkbenchR.string.goal_placeholder, WorkbenchR.string.goal_unsaved,
            WorkbenchR.string.goal_running, WorkbenchR.string.goal_saved, WorkbenchR.string.goal_empty_hint,
            WorkbenchR.string.goal_pause, WorkbenchR.string.goal_start, WorkbenchR.string.goal_clear,
            WorkbenchR.string.goal_disable, WorkbenchR.string.goal_save)
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        titles.forEach { (tag, title) ->
            val context = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(tag))
            })
            assertEquals(tag, title, context.getString(WorkbenchR.string.goal_title))
            ids.forEach { id ->
                org.junit.Assert.assertTrue("$tag / $id", context.getString(id).isNotBlank())
                if (tag != "en") org.junit.Assert.assertNotEquals("$tag / $id",
                    base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                        setLocale(Locale.ENGLISH)
                    }).getString(id), context.getString(id))
            }
        }
    }

    @Test fun hierarchyHeadingsAndApprovalCountsResolveInEverySupportedLanguage() {
        val expected = mapOf(
            "en" to listOf("Choose runtime", "Choose provider", "Choose model", "1 approval waiting", "2 approvals waiting"),
            "zh-CN" to listOf("选择运行环境", "选择服务提供方", "选择模型", "1 项审批待处理", "2 项审批待处理"),
            "zh-TW" to listOf("選擇執行環境", "選擇服務提供者", "選擇模型", "1 項審批待處理", "2 項審批待處理"),
            "ja" to listOf("実行環境を選択", "プロバイダーを選択", "モデルを選択", "承認待ち 1 件", "承認待ち 2 件"),
            "ko" to listOf("실행 환경 선택", "제공업체 선택", "모델 선택", "승인 대기 1건", "승인 대기 2건"),
            "fr" to listOf("Choisir un environnement", "Choisir un fournisseur", "Choisir un modèle", "1 approbation en attente", "2 approbations en attente"),
            "es" to listOf("Elegir entorno", "Elegir proveedor", "Elegir modelo", "1 aprobación pendiente", "2 aprobaciones pendientes"),
        )
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        expected.forEach { (tag, text) ->
            val context = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(tag))
            })
            val actual = listOf(
                context.getString(AgentUiR.string.agentui_choose_runtime),
                context.getString(AgentUiR.string.agentui_choose_provider),
                context.getString(AgentUiR.string.agentui_choose_model),
                context.resources.getQuantityString(WorkbenchR.plurals.home_approvals_waiting, 1, 1),
                context.resources.getQuantityString(WorkbenchR.plurals.home_approvals_waiting, 2, 2),
            )
            assertEquals(tag, text, actual)
        }
    }
}
