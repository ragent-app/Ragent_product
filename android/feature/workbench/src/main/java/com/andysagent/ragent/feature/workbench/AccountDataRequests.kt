package com.andysagent.ragent.feature.workbench

import androidx.compose.material3.ButtonDefaults

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.AgentoDialog
import com.andysagent.ragent.core.designsystem.LocalRagentColors

internal const val ACCOUNT_DELETION_REQUEST_URL = "https://support.agentoncloud.com/account-deletion/"
internal const val ACCOUNT_PRIVACY_URL = "https://support.agentoncloud.com/privacy/"

/** Public instructions only: no account identifier, credential or request is sent here. */
@Composable
internal fun AccountDataRequests(showTitle: Boolean = true) {
    val uriHandler = LocalUriHandler.current
    val colors = LocalRagentColors.current
    var showRequestInstructions by rememberSaveable { mutableStateOf(false) }
    var failedUrl by rememberSaveable { mutableStateOf<String?>(null) }
    fun open(url: String) {
        failedUrl = null
        try {
            uriHandler.openUri(url)
        } catch (_: IllegalArgumentException) {
            failedUrl = url
        } catch (_: SecurityException) {
            failedUrl = url
        }
    }

    Column(Modifier.fillMaxWidth().testTag("account-data-requests"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (showTitle) Text(stringResource(R.string.account_data_title), style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
        TextButton(onClick = { open(ACCOUNT_PRIVACY_URL) }, modifier = Modifier.testTag("account-privacy-open"), colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
            Text(stringResource(R.string.account_privacy_open))
        }
        TextButton(onClick = { showRequestInstructions = true }, modifier = Modifier.testTag("account-deletion-request"), colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
            Text(stringResource(R.string.account_deletion_request))
        }
        failedUrl?.let { url ->
            Text(stringResource(R.string.account_data_browser_unavailable), color = colors.stateError, modifier = Modifier.testTag("account-data-browser-error"))
            SelectionContainer { Text(url, color = colors.secondaryContent, modifier = Modifier.testTag("account-data-failed-url")) }
        }
    }
    if (showRequestInstructions) {
        AgentoDialog(
            modifier = Modifier.testTag("account-deletion-instructions"),
            onDismiss = { showRequestInstructions = false },
            title = stringResource(R.string.account_deletion_request),
            confirmLabel = stringResource(R.string.account_deletion_open_web),
            dismissLabel = stringResource(R.string.settings_cancel),
            confirmModifier = Modifier.testTag("account-deletion-open-web"),
            onConfirm = {
                showRequestInstructions = false
                open(ACCOUNT_DELETION_REQUEST_URL)
            },
        ) {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.account_deletion_request_detail))
                    SelectionContainer { Text(ACCOUNT_DELETION_REQUEST_URL) }
                }
        }
    }
}

@Preview(showBackground = true, widthDp = 320, heightDp = 568)
@Composable
private fun AccountDataRequestsPreview() {
    RagentTheme { AccountDataRequests() }
}
