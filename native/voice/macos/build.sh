#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then
  VOICE_BUILD_DIR="${VOICE_BUILD_DIR:-$PWD/build/tests}"
else
  VOICE_BUILD_DIR="${VOICE_BUILD_DIR:-$PWD/build}"
fi
VOICE_APP="$VOICE_BUILD_DIR/Beaver Voice Input.app"
mkdir -p "$VOICE_APP/Contents/MacOS" "$VOICE_BUILD_DIR/module-cache"
VOICE_FLAGS=(-DVOICE_PRODUCTION)
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then VOICE_FLAGS=(-DVOICE_TESTING); fi
xcrun swiftc "${VOICE_FLAGS[@]}" -swift-version 5 -O -target "$(uname -m)-apple-macosx14.0" -module-cache-path "$VOICE_BUILD_DIR/module-cache" \
  Sources/PCMConverter.swift Sources/VoiceHTTPClient.swift Sources/main.swift -o "$VOICE_APP/Contents/MacOS/BeaverVoice" \
  -framework AppKit -framework AVFoundation
cp Info.plist "$VOICE_APP/Contents/Info.plist"
if [[ "${VOICE_TESTING:-0}" == "1" ]]; then
  /usr/libexec/PlistBuddy -c 'Set CFBundleIdentifier ai.beaverapp.voice.tests' "$VOICE_APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Set CFBundleName Beaver Voice Tests' "$VOICE_APP/Contents/Info.plist"
fi
codesign --force --sign - --options runtime --entitlements entitlements.plist "$VOICE_APP"
codesign --verify --strict "$VOICE_APP"
printf '%s\n' "$VOICE_APP"
