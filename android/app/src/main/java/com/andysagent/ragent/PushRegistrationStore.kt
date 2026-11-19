package com.andysagent.ragent

import android.content.Context
import com.andysagent.ragent.core.auth.AndroidTemporaryEncryptedStore
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64

/** Registration capabilities are stored separately from account credentials so logout can retry. */
internal class PushRegistrationStore(context: Context) {
    companion object { private val messageLock = Any() }
    private val encrypted = AndroidTemporaryEncryptedStore(context, "ragent-push-registration", "ragent_push_registration_v1", maxPlaintextBytes = 131040)

    @Synchronized fun read(): JSONObject = encrypted.read("state")?.let(::JSONObject) ?: JSONObject()
    @Synchronized fun write(value: JSONObject) { encrypted.write("state", value.toString()) }

    private fun writeBounded(key: String, values: JSONArray) {
        var start = 0
        while (start < values.length()) {
            val kept = JSONArray()
            for (index in start until values.length()) kept.put(values.getJSONObject(index))
            val raw = kept.toString()
            if (raw.toByteArray(Charsets.UTF_8).size <= 120_000) { encrypted.write(key, raw); return }
            start++
        }
        encrypted.write(key, "[]")
    }

    fun enqueueMessage(data: Map<String, String>, title: String, body: String) = synchronized(messageLock) {
        val old = encrypted.read("messages")?.let(::JSONArray) ?: JSONArray()
        val next = JSONArray()
        for (index in maxOf(0, old.length() - 19) until old.length()) next.put(old.getJSONObject(index))
        val id = java.util.UUID.randomUUID().toString()
        next.put(JSONObject().put("id", id).put("data", JSONObject(data)).put("title", title).put("body", body))
        writeBounded("messages", next)
        id
    }
    fun pendingMessages(): JSONArray = synchronized(messageLock) { encrypted.read("messages")?.let(::JSONArray) ?: JSONArray() }
    fun removeMessage(id: String) = synchronized(messageLock) {
        val old = encrypted.read("messages")?.let(::JSONArray) ?: JSONArray()
        val next = JSONArray()
        for (index in 0 until old.length()) if (old.getJSONObject(index).optString("id") != id) next.put(old.getJSONObject(index))
        writeBounded("messages", next)
    }
    fun enqueueReceipt(accountId: String, instanceId: String, eventId: String, kind: String, stage: String) = synchronized(messageLock) {
        val old = encrypted.read("receipts")?.let(::JSONArray) ?: JSONArray()
        val next = JSONArray()
        for (index in maxOf(0, old.length() - 499) until old.length()) {
            val item = old.getJSONObject(index)
            if (item.optString("accountId") != accountId || item.optString("instanceId") != instanceId ||
                item.optString("eventId") != eventId || item.optString("kind") != kind || item.optString("stage") != stage) next.put(item)
        }
        next.put(JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("accountId", accountId)
            .put("instanceId", instanceId).put("eventId", eventId).put("kind", kind).put("stage", stage))
        writeBounded("receipts", next)
    }
    fun pendingReceipts(): JSONArray = synchronized(messageLock) { encrypted.read("receipts")?.let(::JSONArray) ?: JSONArray() }
    fun removeReceipt(id: String) = synchronized(messageLock) {
        val old = encrypted.read("receipts")?.let(::JSONArray) ?: JSONArray()
        val next = JSONArray()
        for (index in 0 until old.length()) if (old.getJSONObject(index).optString("id") != id) next.put(old.getJSONObject(index))
        writeBounded("receipts", next)
    }

    fun wasProcessed(accountId: String, instanceId: String, kind: String, eventId: String): Boolean = synchronized(messageLock) {
        val key = eventKey(accountId, instanceId, kind, eventId)
        val records = encrypted.read("processed")?.let(::JSONObject) ?: JSONObject()
        records.optLong(key, 0L) > System.currentTimeMillis()
    }

    fun markProcessed(accountId: String, instanceId: String, kind: String, eventId: String, expiresAt: Long) = synchronized(messageLock) {
        val records = encrypted.read("processed")?.let(::JSONObject) ?: JSONObject()
        val now = System.currentTimeMillis()
        val retained = records.keys().asSequence().toList().filter { records.optLong(it, 0L) > now }
            .sortedByDescending { records.optLong(it, 0L) }.take(499)
        val next = JSONObject()
        retained.forEach { next.put(it, records.getLong(it)) }
        next.put(eventKey(accountId, instanceId, kind, eventId), expiresAt)
        encrypted.write("processed", next.toString())
    }

    private fun eventKey(accountId: String, instanceId: String, kind: String, eventId: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(JSONArray(listOf(accountId, instanceId, kind, eventId)).toString().toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }

    fun newRegistration(token: String, instances: List<String>, version: String, enabled: Boolean, accountId: String): JSONObject {
        val random = SecureRandom()
        val id = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        val capability = ByteArray(32).also(random::nextBytes)
        return JSONObject().put("registrationId", "preg_$id")
            .put("revokeCapability", Base64.getUrlEncoder().withoutPadding().encodeToString(capability))
            .put("token", token).put("instanceIds", JSONArray(instances.sorted()))
            .put("appVersion", version).put("notificationsEnabled", enabled).put("accountId", accountId)
    }
}
