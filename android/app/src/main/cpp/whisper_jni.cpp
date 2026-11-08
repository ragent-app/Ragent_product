#include <jni.h>

#include "whisper.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxAudioBytes = 44 + 16'000 * 2 * 20;

void throwJava(JNIEnv *env, const char *message) {
    jclass type = env->FindClass("java/lang/IllegalStateException");
    if (type != nullptr) env->ThrowNew(type, message);
}

uint16_t readU16(const unsigned char *bytes) {
    return static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
}

uint32_t readU32(const unsigned char *bytes) {
    return static_cast<uint32_t>(bytes[0]) |
           (static_cast<uint32_t>(bytes[1]) << 8) |
           (static_cast<uint32_t>(bytes[2]) << 16) |
           (static_cast<uint32_t>(bytes[3]) << 24);
}

bool hasTag(const unsigned char *bytes, const char *tag) {
    return bytes[0] == static_cast<unsigned char>(tag[0]) &&
           bytes[1] == static_cast<unsigned char>(tag[1]) &&
           bytes[2] == static_cast<unsigned char>(tag[2]) &&
           bytes[3] == static_cast<unsigned char>(tag[3]);
}

bool readPcmWav(const std::string &path, std::vector<float> &samples) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) return false;
    const auto end = input.tellg();
    if (end < 44 || static_cast<uint64_t>(end) > kMaxAudioBytes) return false;
    const size_t length = static_cast<size_t>(end);
    std::vector<unsigned char> wav(length);
    input.seekg(0);
    input.read(reinterpret_cast<char *>(wav.data()), static_cast<std::streamsize>(length));
    if (!input || !hasTag(wav.data(), "RIFF") || !hasTag(wav.data() + 8, "WAVE")) return false;

    uint16_t format = 0;
    uint16_t channels = 0;
    uint16_t bits = 0;
    uint32_t sampleRate = 0;
    size_t dataOffset = 0;
    size_t dataLength = 0;
    size_t offset = 12;
    while (offset + 8 <= length) {
        const uint32_t chunkSize = readU32(wav.data() + offset + 4);
        const size_t content = offset + 8;
        if (chunkSize > length - content) return false;
        if (hasTag(wav.data() + offset, "fmt ")) {
            if (chunkSize < 16) return false;
            format = readU16(wav.data() + content);
            channels = readU16(wav.data() + content + 2);
            sampleRate = readU32(wav.data() + content + 4);
            bits = readU16(wav.data() + content + 14);
        } else if (hasTag(wav.data() + offset, "data")) {
            dataOffset = content;
            dataLength = chunkSize;
            break;
        }
        offset = content + chunkSize + (chunkSize & 1U);
    }
    if (format != 1 || channels != 1 || sampleRate != 16'000 || bits != 16 || dataOffset == 0 || dataLength == 0 || dataLength % 2 != 0) {
        return false;
    }

    samples.resize(dataLength / 2);
    for (size_t i = 0; i < samples.size(); ++i) {
        const int16_t pcm = static_cast<int16_t>(readU16(wav.data() + dataOffset + i * 2));
        samples[i] = static_cast<float>(pcm) / 32768.0f;
    }
    return true;
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_andysagent_agentoc_NativeWhisper_transcribeFile(
    JNIEnv *env,
    jobject /* thiz */,
    jstring modelPathValue,
    jstring audioPathValue,
    jint threads) {
    if (modelPathValue == nullptr || audioPathValue == nullptr) {
        throwJava(env, "Whisper model or audio path is missing");
        return nullptr;
    }
    const char *modelPathChars = env->GetStringUTFChars(modelPathValue, nullptr);
    const char *audioPathChars = env->GetStringUTFChars(audioPathValue, nullptr);
    if (modelPathChars == nullptr || audioPathChars == nullptr) {
        if (modelPathChars != nullptr) env->ReleaseStringUTFChars(modelPathValue, modelPathChars);
        if (audioPathChars != nullptr) env->ReleaseStringUTFChars(audioPathValue, audioPathChars);
        return nullptr;
    }
    const std::string modelPath(modelPathChars);
    const std::string audioPath(audioPathChars);
    env->ReleaseStringUTFChars(modelPathValue, modelPathChars);
    env->ReleaseStringUTFChars(audioPathValue, audioPathChars);

    std::vector<float> samples;
    if (!readPcmWav(audioPath, samples)) {
        throwJava(env, "Audio must be mono 16-bit PCM WAV at 16 kHz");
        return nullptr;
    }

    whisper_context_params contextParams = whisper_context_default_params();
    contextParams.use_gpu = false;
    whisper_context *context = whisper_init_from_file_with_params(modelPath.c_str(), contextParams);
    if (context == nullptr) {
        throwJava(env, "The multilingual Whisper model could not be loaded");
        return nullptr;
    }

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = std::clamp(static_cast<int>(threads), 1, 6);
    const int requestedAudioContext = static_cast<int>(std::ceil(samples.size() / 320.0));
    params.audio_ctx = std::clamp(requestedAudioContext, 256, whisper_n_audio_ctx(context));
    params.language = "auto";
    params.translate = false;
    params.no_context = true;
    params.print_realtime = false;
    params.print_progress = false;
    params.print_timestamps = false;
    params.print_special = false;

    const int result = whisper_full(context, params, samples.data(), static_cast<int>(samples.size()));
    std::string transcript;
    if (result == 0) {
        const int segments = whisper_full_n_segments(context);
        for (int i = 0; i < segments; ++i) {
            const char *segment = whisper_full_get_segment_text(context, i);
            if (segment != nullptr) transcript.append(segment);
        }
    }
    whisper_free(context);
    if (result != 0) {
        throwJava(env, "Whisper could not transcribe the phone recording");
        return nullptr;
    }
    return env->NewStringUTF(transcript.c_str());
}
