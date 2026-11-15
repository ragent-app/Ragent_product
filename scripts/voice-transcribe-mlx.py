#!/usr/bin/env python3

import argparse
import json
import os
import sys

from voice_audio_common import DEFAULT_MODEL, transcribe_audio, trim


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe one audio file with MLX Whisper")
    parser.add_argument("audio", nargs="?", default="")
    parser.add_argument("--audio-path", default="")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default="")
    parser.add_argument("--initial-prompt", default="")
    return parser.parse_args()


def main():
    args = parse_args()
    audio_path = trim(args.audio_path) or trim(args.audio) or trim(os.environ.get("RAGENT_VOICE_AUDIO_PATH"))
    if not audio_path:
        raise SystemExit("audio path is required")

    result = transcribe_audio(
        audio_path,
        model=args.model,
        language=args.language,
        initial_prompt=args.initial_prompt,
    )
    payload = {
        "transcript": result["text"],
        "text": result["text"],
        "language": result["language"],
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

