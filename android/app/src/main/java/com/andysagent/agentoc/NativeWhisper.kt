package com.andysagent.agentoc

import androidx.annotation.Keep

/** Small JNI boundary around the pinned official whisper.cpp CPU build. */
@Keep
internal object NativeWhisper {
    init {
        System.loadLibrary("ragent_whisper")
    }

    @Keep
    external fun transcribeFile(modelPath: String, audioPath: String, threads: Int, language: String): String

    @Keep
    external fun supportedLanguageCodes(): Array<String>
}
