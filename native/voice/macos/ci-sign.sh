#!/bin/bash
# Secrets are scoped to the protected voice-release environment; never enable shell tracing.
set -euo pipefail
: "${VOICE_CERTIFICATE_BASE64:?}"
: "${VOICE_CERTIFICATE_PASSWORD:?}"
: "${VOICE_APPLE_ID:?}"
: "${VOICE_APP_PASSWORD:?}"
: "${VOICE_TEAM_ID:?}"
VOICE_TEMP="$(mktemp -d)"
export VOICE_KEYCHAIN="$VOICE_TEMP/voice.keychain-db"
VOICE_KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
trap 'security delete-keychain "$VOICE_KEYCHAIN" >/dev/null 2>&1 || true; rm -rf "$VOICE_TEMP"' EXIT
printf '%s' "$VOICE_CERTIFICATE_BASE64" | base64 --decode > "$VOICE_TEMP/identity.p12"
security create-keychain -p "$VOICE_KEYCHAIN_PASSWORD" "$VOICE_KEYCHAIN"
security set-keychain-settings -lut 21600 "$VOICE_KEYCHAIN"
security unlock-keychain -p "$VOICE_KEYCHAIN_PASSWORD" "$VOICE_KEYCHAIN"
security import "$VOICE_TEMP/identity.p12" -k "$VOICE_KEYCHAIN" -P "$VOICE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$VOICE_KEYCHAIN_PASSWORD" "$VOICE_KEYCHAIN" >/dev/null
security list-keychains -d user -s "$VOICE_KEYCHAIN" login.keychain-db
export VOICE_NOTARY_PROFILE=beaver-voice-release
xcrun notarytool store-credentials "$VOICE_NOTARY_PROFILE" --keychain "$VOICE_KEYCHAIN" --apple-id "$VOICE_APPLE_ID" --team-id "$VOICE_TEAM_ID" --password "$VOICE_APP_PASSWORD" >/dev/null
# Pass the temporary keychain explicitly to the notarization client.
bash native/voice/macos/sign-release.sh
