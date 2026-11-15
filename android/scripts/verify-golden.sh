#!/usr/bin/env bash
# Golden screenshot diff gate for the Ragent Android client.
#
# Renders the Workbench states on a connected emulator (debug APK + androidTest),
# pulls the captures, and diffs them against the committed baselines in
# app/screenshots/. Fails (exit 1) if any image's pixel diff exceeds the
# approved threshold.
#
# Usage:
#   GOLDEN_THRESHOLD=0.10 scripts/verify-golden.sh            # default threshold 0.10%
#   ADB=/path/to/adb DEVICE=emulator-5554 scripts/verify-golden.sh
#
# Threshold value: same-device noise floor is 0.00% (deterministic states);
# 0.10% catches any visible regression with margin for cross-device AA drift.
set -euo pipefail

cd "$(dirname "$0")/.."
ADB="${ADB:-/opt/android-sdk/platform-tools/adb}"
DEVICE="${DEVICE:-emulator-5554}"
THRESHOLD="${GOLDEN_THRESHOLD:-0.10}"
PKG="com.agentoncloud.android"

echo "==> building debug APKs"
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -q

echo "==> installing on ${DEVICE}"
"$ADB" -s "$DEVICE" install -r -t app/build/outputs/apk/debug/app-debug.apk >/dev/null
"$ADB" -s "$DEVICE" install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null

echo "==> capturing golden states"
"$ADB" -s "$DEVICE" shell rm -rf /sdcard/Android/data/${PKG}/files/screenshots
"$ADB" -s "$DEVICE" shell am instrument -w \
  -e class com.andysagent.ragent.WorkbenchScreenshotBaselineTest \
  com.agentoncloud.android.test/androidx.test.runner.AndroidJUnitRunner >/dev/null

echo "==> pulling captures"
rm -rf build/golden-capture
mkdir -p build/golden-capture
"$ADB" -s "$DEVICE" pull /sdcard/Android/data/${PKG}/files/screenshots build/golden-capture/ >/dev/null
mv build/golden-capture/screenshots/*.png build/golden-capture/ 2>/dev/null || true

echo "==> diffing against baselines (threshold ${THRESHOLD}%)"
python3 scripts/golden_diff.py \
  --baseline app/screenshots \
  --candidate build/golden-capture \
  --threshold "${THRESHOLD}" \
  --out build/golden-diff
