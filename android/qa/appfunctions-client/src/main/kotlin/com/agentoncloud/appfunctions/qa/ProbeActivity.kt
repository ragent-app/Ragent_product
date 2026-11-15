package com.agentoncloud.appfunctions.qa

import android.app.Activity
import android.app.appfunctions.*
import android.content.*
import android.os.*
import android.widget.TextView

/** Unprivileged, different-UID probe. It only attempts the read-only computer-discovery function. */
class ProbeActivity : Activity() {
    private lateinit var output: TextView
    private var bind = "PENDING"
    private var execute = "PENDING"
    private var bound = false
    private val cancellation = CancellationSignal()
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) { bind = "UNEXPECTED_ALLOWED"; render() }
        override fun onServiceDisconnected(name: ComponentName) = Unit
    }
    private fun render() {
        val targetUid = packageManager.getApplicationInfo(TARGET, 0).uid
        output.text = "callerUid=${Process.myUid()}; targetUid=$targetUid; bind=$bind; execute=$execute"
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply { textSize = 18f; setPadding(24,24,24,24) }
        setContentView(output)
        try {
            bound = bindService(Intent().setComponent(ComponentName(TARGET, SERVICE)), connection, BIND_AUTO_CREATE)
            bind = if (bound) "UNEXPECTED_BIND_REQUEST" else "NOT_BOUND"
        } catch (_: SecurityException) { bind = "DENIED" }
        val manager = getSystemService(AppFunctionManager::class.java)
        val request = ExecuteAppFunctionRequest.Builder(TARGET, "$SERVICE_BASE#listComputers").build()
        try {
            manager.executeAppFunction(request, mainExecutor, cancellation,
                object : OutcomeReceiver<ExecuteAppFunctionResponse, AppFunctionException> {
                    override fun onResult(result: ExecuteAppFunctionResponse) { execute = "UNEXPECTED_ALLOWED"; render() }
                    override fun onError(error: AppFunctionException) {
                        execute = if (error.errorCode == AppFunctionException.ERROR_DENIED) "DENIED" else "ERROR_${error.errorCode}"
                        render()
                    }
                })
        } catch (_: SecurityException) { execute = "DENIED" }
        render()
    }
    override fun onDestroy() {
        cancellation.cancel()
        if (bound) unbindService(connection)
        super.onDestroy()
    }
    private companion object {
        const val TARGET = "com.agentoncloud.android"
        const val SERVICE_BASE = "com.andysagent.ragent.integration.appfunctions.BaseRagentAppFunctionService"
        const val SERVICE = "com.andysagent.ragent.integration.appfunctions.RagentAppFunctionService"
    }
}
