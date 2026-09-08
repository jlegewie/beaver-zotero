#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then
  VOICE_BUILD_DIR="${VOICE_BUILD_DIR:-$PWD/build/tests}"
else
  VOICE_BUILD_DIR="${VOICE_BUILD_DIR:-$PWD/build}"
fi
VOICE_APP="$VOICE_BUILD_DIR/Beaver Voice Input.app"
rm -rf "$VOICE_APP"
mkdir -p "$VOICE_APP/Contents/MacOS" "$VOICE_BUILD_DIR/module-cache"
VOICE_FLAGS=(-DVOICE_PRODUCTION)
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then VOICE_FLAGS=(-DVOICE_TESTING); fi
# Generate native protocol constants from the same contract consumed by packaging and Zotero.
python3 - "$VOICE_BUILD_DIR/VoiceContract.swift" <<'PYTHON'
import json, pathlib, sys
contract = json.loads(pathlib.Path("contract.json").read_text())
pathlib.Path(sys.argv[1]).write_text(
    f"let voiceProtocolVersion = {int(contract['protocolVersion'])}\n"
    f"let voiceHelperVersion = {int(contract['helperVersion'])}\n"
)
PYTHON
# Compile each slice separately; lipo retains both deployment targets.
VOICE_SLICES=()
for arch in arm64 x86_64; do
  slice="$VOICE_BUILD_DIR/BeaverVoice-$arch"
  xcrun swiftc "${VOICE_FLAGS[@]}" -swift-version 5 -O -target "$arch-apple-macosx14.0" -module-cache-path "$VOICE_BUILD_DIR/module-cache" \
    "$VOICE_BUILD_DIR/VoiceContract.swift" Sources/PCMConverter.swift Sources/VoiceHTTPClient.swift Sources/main.swift -o "$slice" \
    -framework AppKit -framework AVFoundation
  VOICE_SLICES+=("$slice")
done
xcrun lipo -create "${VOICE_SLICES[@]}" -output "$VOICE_APP/Contents/MacOS/BeaverVoice"
cp Info.plist "$VOICE_APP/Contents/Info.plist"
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c 'Set CFBundleIdentifier ai.beaverapp.voice.tests' "$VOICE_APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Set CFBundleName Beaver Voice Tests' "$VOICE_APP/Contents/Info.plist"
fi
codesign --force --sign - --options runtime --entitlements entitlements.plist "$VOICE_APP"
codesign --verify --strict "$VOICE_APP"
printf '%s\n' "$VOICE_APP"
