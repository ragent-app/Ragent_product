package com.andysagent.ragent

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.PeerConnectionFactory

/** Verifies that the final app can initialize the packaged WebRTC native runtime. */
@RunWith(AndroidJUnit4::class)
class RagentWebRtcRuntimeSmokeTest {

    @Test
    fun realWebRtcRuntimeInitializesAndCreatesFactory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val options = PeerConnectionFactory.InitializationOptions
            .builder(context)
            .createInitializationOptions()

        PeerConnectionFactory.initialize(options)
        val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()

        assertNotNull("WebRTC PeerConnectionFactory must initialize from the packaged AAR", factory)
        factory?.dispose()
    }
}
