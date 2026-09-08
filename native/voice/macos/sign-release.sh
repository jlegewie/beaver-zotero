#!/bin/bash
# Run only in the configured macOS release environment, before package.mjs.
set -euo pipefail
cd "$(dirname "$0")"
: "${VOICE_SIGNING_IDENTITY:?Developer ID Application identity required}"
: "${VOICE_NOTARY_PROFILE:?notarytool keychain profile required}"
VOICE_APP="${VOICE_APP:-$PWD/build/Beaver Voice Input.app}"
codesign --force --sign "$VOICE_SIGNING_IDENTITY" --timestamp --options runtime --entitlements entitlements.plist "$VOICE_APP"
codesign --verify --strict --all-architectures "$VOICE_APP"
VOICE_SUBMISSION="$(mktemp -d)"
trap 'rm -rf "$VOICE_SUBMISSION"' EXIT
ditto -c -k --sequesterRsrc --keepParent "$VOICE_APP" "$VOICE_SUBMISSION/voice.zip"
VOICE_NOTARY_ARGS=()
if [[ -n "${VOICE_KEYCHAIN:-}" ]]; then VOICE_NOTARY_ARGS=(--keychain "$VOICE_KEYCHAIN"); fi
xcrun notarytool submit "$VOICE_SUBMISSION/voice.zip" --keychain-profile "$VOICE_NOTARY_PROFILE" "${VOICE_NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$VOICE_APP"
xcrun stapler validate "$VOICE_APP"
node package.mjs
