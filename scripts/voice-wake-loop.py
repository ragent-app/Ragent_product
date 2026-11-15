#!/usr/bin/env python3

import argparse
import os
import signal
import sys
import time
import uuid

from voice_audio_common import (
    DEFAULT_MODEL,
    SounddeviceInputUnavailableError,
    default_input_backend,
    emit_json,
    format_sounddevice_device,
    make_temp_wav,
    normalize_for_match,
    play_ack_sound,
    probe_sounddevice_input,
    record_audio,
    resolve_trigger_transcript,
    transcribe_audio,
    trim,
)


def now_iso():
    import datetime as _datetime
    return _datetime.datetime.now(_datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args():
    parser = argparse.ArgumentParser(description="Always-on microphone wake loop using ffmpeg + MLX Whisper")
    parser.add_argument("--phrase", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default="")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--chunk-seconds", type=float, default=2.8)
    parser.add_argument("--cooldown-ms", type=int, default=3000)
    parser.add_argument("--input-backend", default="")
    parser.add_argument("--input-source", default="")
    parser.add_argument("--transcript-mode", choices=["full", "after-wake"], default="full")
    parser.add_argument("--ack-sound-path", default="")
    parser.add_argument("--connector-id", default=os.environ.get("RAGENT_VOICE_CONNECTOR_ID", ""))
    parser.add_argument("--room-name", default=os.environ.get("RAGENT_VOICE_ROOM_NAME", ""))
    parser.add_argument("--test-trigger", action="store_true")
    parser.add_argument("--test-file", default="")
    return parser.parse_args()


def build_event(args, transcript, *, source, recognition_mode, raw_transcript):
    return {
        "eventId": f"voice-{uuid.uuid4().hex}",
        "wakeWord": args.phrase,
        "transcript": transcript,
        "detectedAt": now_iso(),
        "connectorId": trim(args.connector_id),
        "roomName": trim(args.room_name),
        "source": source,
        "metadata": {
            "rawTranscript": raw_transcript,
            "transcriptMode": args.transcript_mode,
            "locale": trim(args.language),
            "captureNeeded": transcript == "",
            "recognitionMode": recognition_mode,
        },
    }


def main():
    args = parse_args()
    running = True
    last_trigger_at = 0.0
    normalized_phrase = normalize_for_match(args.phrase)
    active_backend = trim(args.input_backend) or default_input_backend()

    print(
        f"[voice-wake-loop] listening for {args.phrase} via {active_backend} + mlx_whisper"
        f" (chunk={args.chunk_seconds}s, mode={args.transcript_mode})",
        file=sys.stderr,
    )

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    if active_backend == "sounddevice":
        probe = probe_sounddevice_input(args.input_source)
        if probe.get("ok") and probe.get("selectedDevice"):
            print(
                f'[voice-wake-loop] input device: {format_sounddevice_device(probe["selectedDevice"])}',
                file=sys.stderr,
            )

    if args.test_trigger:
        play_ack_sound(args.ack_sound_path)
        emit_json(build_event(args, "", source="wake_test", recognition_mode="test", raw_transcript=args.phrase))
        return

    if trim(args.test_file):
        result = transcribe_audio(
            args.test_file,
            model=args.model,
            language=args.language,
            initial_prompt=args.initial_prompt,
        )
        raw_text = trim(result["text"])
        if normalized_phrase in normalize_for_match(raw_text):
            transcript = resolve_trigger_transcript(raw_text, args.phrase, args.transcript_mode)
            print(f"[voice-wake-loop] detected wake phrase: {raw_text}", file=sys.stderr)
            play_ack_sound(args.ack_sound_path)
            emit_json(build_event(args, transcript, source="wake_test_file", recognition_mode="file", raw_transcript=raw_text))
        return

    while running:
        audio_path = make_temp_wav("voice-wake-")
        try:
            record_audio(
                audio_path,
                duration_seconds=args.chunk_seconds,
                backend=args.input_backend,
                source=args.input_source,
            )
            result = transcribe_audio(
                audio_path,
                model=args.model,
                language=args.language,
                initial_prompt=args.initial_prompt,
            )
            raw_text = trim(result["text"])
            if not raw_text:
                continue
            if normalized_phrase not in normalize_for_match(raw_text):
                continue
            now = time.time()
            if now - last_trigger_at < args.cooldown_ms / 1000.0:
                continue
            last_trigger_at = now

            transcript = resolve_trigger_transcript(raw_text, args.phrase, args.transcript_mode)
            print(f"[voice-wake-loop] detected wake phrase: {raw_text}", file=sys.stderr)
            play_ack_sound(args.ack_sound_path)
            emit_json(build_event(args, transcript, source="mlx_whisper_wake", recognition_mode="loop", raw_transcript=raw_text))
        except KeyboardInterrupt:
            running = False
        except SounddeviceInputUnavailableError as error:
            print(f"[voice-wake-loop] {error}", file=sys.stderr)
            time.sleep(5.0)
        except Exception as error:
            print(f"[voice-wake-loop] {error}", file=sys.stderr)
            time.sleep(0.3)
        finally:
            try:
                os.remove(audio_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
