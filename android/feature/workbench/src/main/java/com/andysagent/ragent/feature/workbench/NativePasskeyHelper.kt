package com.andysagent.ragent.feature.workbench

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import com.andysagent.ragent.core.protocol.WebAuthnProofDto
import com.andysagent.ragent.core.protocol.WebAuthnProofResponseDto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Bridges a server WebAuthn challenge to the phone's system passkey UI.
 *
 * The server remains the source of the RP id, challenge and allow-list. This
 * class does not create or select a local credential and does not turn a
 * Credential Manager result into approval by itself; it only returns the
 * assertion JSON that is subsequently verified by the server.
 */
class NativePasskeyHelper(context: Context) {
    // Credential Manager may need an Activity token to present the system
    // passkey sheet. MainActivity owns this helper for the lifetime of the
    // Compose host, so retain the UI context rather than downgrading it to an
    // application context.
    private val context = context
    private val credentialManager = CredentialManager.create(context)
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun getAssertion(publicKeyJson: String): WebAuthnProofDto {
        require(publicKeyJson.isNotBlank()) { "Passkey challenge is empty" }
        val response = credentialManager.getCredential(
            context,
            GetCredentialRequest(
                listOf(GetPublicKeyCredentialOption(publicKeyJson)),
            ),
        )
        val credential = response.credential as? PublicKeyCredential
            ?: error("The system did not return a passkey assertion")
        val root = json.parseToJsonElement(credential.authenticationResponseJson).jsonObject
        val assertion = root["response"]?.jsonObject
            ?: error("The passkey provider returned no assertion response")
        val id = root["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
        require(id.isNotBlank()) { "The passkey provider returned no credential id" }
        val rawId = root["rawId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: id
        return WebAuthnProofDto(
            id = id,
            rawId = rawId,
            response = WebAuthnProofResponseDto(
                clientDataJSON = assertion.required("clientDataJSON"),
                authenticatorData = assertion.required("authenticatorData"),
                signature = assertion.required("signature"),
                userHandle = assertion["userHandle"]?.jsonPrimitive?.contentOrNull,
            ),
        )
    }

    private fun kotlinx.serialization.json.JsonObject.required(name: String): String =
        this[name]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: error("The passkey provider returned no $name")
}
