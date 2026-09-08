# Packaged macOS voice helper

Voice remains disabled by default (`extensions.zotero.beaver.voice.nativeEnabled`).
The native service object is plugin-owned; constructing it opens no socket, extracts no
files, and launches no process. `ensurePackagedHelper()` performs installation on the first
explicit native activation. Product dictation and the backend adapter are separate work.
The development harness can use this same packaged path without `setDevelopmentHelper()`.

## Compatibility and release status

| Component       | Target compatibility                  | Validation                                                                            |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| macOS           | 14.0 or later                         | Local checks on 14.7; macOS 15 CI configured                                          |
| Zotero          | 7.x–10.x                              | Live packaged checks on 10.0.1-beta.1; older majors still require release-matrix runs |
| CPU             | arm64 and x86_64 in one universal app | Local arm64 and forced Intel/Rosetta microphone capture; native Intel CI configured   |
| Windows / Linux | Disabled                              | No packaged adapter                                                                   |

This is a target compatibility matrix, not evidence that every combination has passed.
Production enablement must wait for the unverified combinations, Developer ID signing,
notarization, and the remaining voice product integration. An OS below macOS 14, an
unlisted CPU, or a Zotero major outside 7–10 is rejected before extraction or launch.

## Build and package

On macOS with Xcode command-line tools:

```sh
npm run voice:build
npm run voice:package:dev
npm run build:dev
```

The generated XPI includes `content/voice/manifest.json` and `content/voice/macos.zip`.
There is no manual app placement. The inner zip is made with `ditto`, preserving bundle
contents, executable modes, symlinks, resources, and signatures. Both scaffold assembly and
`pack-xpi.mjs` verify that the archive digest/length match its manifest. Production builds
reject a development package. Ordinary builds can omit voice assets while the feature is
unreleased; `VOICE_PACKAGE_REQUIRED=1` makes missing assets a build failure.

`build.sh` cleans the app directory, builds arm64 and x86_64 slices with a macOS 14.0
minimum, combines them using `lipo`, and ad-hoc signs the app with hardened runtime and
the microphone entitlement. `VOICE_TESTING=1` builds a separate fixture identity in
`build/tests/`; packaging rejects fixture helpers. `--voice-info` reads protocol metadata
without initializing AppKit or requesting microphone access.

`package.mjs` verifies the signature and app identity before executing metadata inspection,
requires both slices and the supported protocol, and records SHA-256 hashes for the archive,
executable, and plist. `VOICE_APP` and `VOICE_PACKAGE_DIR` select staging inputs/outputs.
Archive bytes are preserved unchanged through XPI assembly. Signed artifacts contain
signing timestamps and notarization tickets; reproduce the build recipe and retain its
manifest/digests, rather than expecting separately signed builds to be byte-identical.

The manifest retains schema, protocol/helper versions, and bundle identity as compatibility
assertions so incompatible artifacts can be rejected before extraction or execution. The
OS/Zotero/CPU matrix is installer policy in `native/voice/macos/contract.json`, not per-build
manifest configuration. That contract also supplies the shared signing requirement and build
constants; `build.sh` generates Swift protocol constants from it. A unit check keeps the
native protocol version aligned with the portable voice contract.

## Installation, upgrades, and recovery

The installer uses the current Zotero profile's `beaver/voice/<archive-sha256>/` directory.
Each profile has an independent cache. It verifies the packaged manifest, platform, archive
size and SHA-256, then extracts into a private staging directory. It checks executable/plist
hashes, all signature slices, the expected bundle identity, and the executable's protocol.
Production requires the expected Developer ID team and Gatekeeper assessment. Only a
verified staging directory is atomically moved into its immutable destination.

Every launch revalidates executable/plist hashes and the complete code signature. Successful
Gatekeeper assessment and protocol metadata checks are cached per exact artifact and path for
the plugin lifetime; OS/CPU discovery is also cached. Directory timestamps are not treated as proof that bundle contents are unchanged.
All native utility calls, including LaunchServices and development signature checks, drain
both output pipes and have a 15-second kill deadline. Concurrent install requests share one promise;
failed attempts clean staging and leave older versions intact. Plugin disposal prevents a
late install from activating native resources. Runtime hello validation independently checks
the IPC protocol and helper version. Capture still launches through `/usr/bin/open`, not the
inner executable; the direct executable invocation is metadata-only.

Plugin replacement revokes the active native lease synchronously. The old helper exits on
its next control contact or its independent watchdog. A replacement plugin owns a new service,
resets permission to unknown, and lazily installs its own artifact. Registration cannot replace
a helper during an active native lease. Recent versions remain available for rollback;
cleanup removes only recognized cache entries unused for seven days, far beyond a native
lease's maximum lifetime. Reinstalling an identical XPI reuses and verifies the same directory.
A rollback XPI selects its original digest without modifying the newer directory.

A corrupt cached version triggers one fresh extraction and verification attempt. The damaged
directory is removed only after the staged replacement passes verification; a failed repair
never launches it. Installing a new artifact uses a different directory automatically. A changed
artifact detected during launch refreshes the selected path and requires a fresh activation,
including permission setup. Disabling the preference
prevents subsequent packaged launches; plugin disable/uninstall revokes active capture.

## Verification

```sh
npx vitest run tests/unit/voice
native/voice/macos/test.sh
python3 native/voice/macos/Tests/packaging.py
VOICE_TESTING=1 native/voice/macos/build.sh
python3 native/voice/macos/Tests/lifecycle.py
# In the isolated Zotero instance: generated capture beyond the launcher timeout
python3 native/voice/tests/zotero-native.py --long
```

The packaging test uses real codesign and ditto, round-trips through the actual XPI packer,
checks executable and resource modes and symlinks, and rejects tampered content and ad-hoc
production packages. CI runs native build/converter/packaging checks on `macos-15` (arm64)
and `macos-15-intel`, uploading explicitly labeled development archives. Those jobs do not
claim microphone or Zotero validation on a hosted runner.

After installing the generated development XPI into an isolated, logged-in worktree Zotero:

```sh
# Fresh plugin, no helper registered:
python3 native/voice/tests/zotero-process.py
python3 native/voice/tests/zotero-packaging.py
# Rejects deliberately corrupted/incompatible packaged XPIs, then restores the original:
python3 native/voice/tests/zotero-invalid-packages.py
# Creates an upgraded artifact, installs/reinstalls it, then restores the original XPI:
python3 native/voice/tests/zotero-upgrades.py
# Optional actual microphone: includes replacement during active capture; saves no audio:
python3 native/voice/tests/zotero-upgrades.py --microphone
# Real microphone PCM, normal launch and forced Intel slice (Rosetta on Apple Silicon):
python3 native/voice/tests/zotero-packaged-capture.py
python3 native/voice/tests/zotero-packaged-capture.py --intel
ZOTERO_HTTP_PORT=<isolated-port> npm run test:live -- tests/live/voice.live.test.ts
```

These scripts validate the worktree metadata and operate only on its RDP port/profile.
The packaging test corrupts the extracted test executable and verifies automatic repair, and
creates disposable cache entries. The microphone upgrade test uses a synthetic focus owner
in the development harness so RDP can drive it without stealing desktop focus; it does not
validate physical focus interaction. The original XPI is restored in a `finally` block.
No recording or transcript is persisted or sent to a provider.

## Local verification record (2026-09-08)

On macOS 14.7 / Apple Silicon with an isolated Zotero 10.0.1-beta.1 profile:

- Full unit suite: 419 files passed, 6,947 tests passed, three existing skips. An initial
  duplicate-detection timing assertion failed under concurrent load; its isolated rerun and
  the full suite with four workers passed. Two additional feature-revocation race tests were
  then added; the final voice suite passed all 184 tests.
- Development and production builds passed typechecks, both package closure gates, and the
  production bundle guard. Changed TypeScript files passed ESLint and formatting checks.
- Installed production XPI: native service present, development harness absent, no listener,
  and missing optional voice assets rejected safely.
- Converter checks, 19 microphone-free lifecycle scenarios, real Zotero IPC, three generated
  audio sessions, and originating-window unload passed. The three live fake-controller tests
  passed against the explicitly selected isolated HTTP port.
- Generated-XPI extraction, concurrent activation, cache verification, corruption/recovery,
  old-cache cleanup, identical reinstall, upgrade, and rollback passed. Replacing the XPI
  during real packaged capture terminated the previous helper. Four deliberately invalid
  XPIs failed before native listener construction.
- XPI/archive round-trip preserved modes, symlinks, bundle resources, and signatures.
  Corruption and ad-hoc production packaging were rejected.
- Actual packaged microphone sessions passed on arm64 and forced x86_64 through LaunchServices
  under Rosetta, without saving or uploading audio. Native startup was 289–406 ms, first PCM
  561–901 ms, and stop 126–156 ms in three repeated sessions. The first forced Intel session
  started in 1,535 ms, delivered PCM in 1,827 ms, and stopped in 85 ms.
- These quiet-room captures exercised the expected `no_speech` result. A spoken-speech quality
  check, native Intel hardware, other target OS/Zotero combinations, and actual GitHub CI runs
  remain unverified. Developer ID, notarization, stapling, and downloaded/offline Gatekeeper
  validation are pending the Apple setup below.

Subsequent cleanup verification passed 6,957 unit tests (three existing skips), including
192 voice tests, with no ESLint errors. The regenerated universal helper passed archive
round-trip and converter checks, 19 native lifecycle scenarios, live invalid-artifact and
cache-corruption checks, and three live controller tests. An 18-second generated capture
also completed successfully, verifying that the utility timeout does not end a healthy
recording. The rebuilt ad-hoc helper requires renewed macOS microphone permission before
repeating physical-microphone checks; permission results and signed distribution validation
must not be inferred from generated capture.

A further review regression run passed 6,964 unit tests (three existing skips), including
199 voice tests, and the development build, typechecks, bundle isolation, ESLint, and changed-file
formatting checks. In isolated Zotero, the utility runner drained 300,000 stdout characters
alongside stderr, enforced its output bound, and killed a stalled utility at 15 seconds.
Automatic corrupt-install repair, reinstall/upgrade/rollback, five invalid-XPI cases (including
a malformed version), three generated captures (one lasting 18 seconds), and originating-window
unload passed. Physical microphone and signed distribution checks remain pending as above.

## Apple release setup (pending)

1. Enroll the distributing person or organization in the
   [Apple Developer Program](https://developer.apple.com/programs/enroll/).
2. Create a **Developer ID Application** certificate, retain its private key, and export a
   password-protected `.p12`. Keep the stable `ai.beaverapp.voice` bundle identity and team.
3. Create a protected GitHub environment named `voice-release`. Add secrets:
   `VOICE_CERTIFICATE_BASE64`, `VOICE_CERTIFICATE_PASSWORD`, `VOICE_SIGNING_IDENTITY`,
   `VOICE_TEAM_ID`, `VOICE_APPLE_ID`, and an app-specific `VOICE_APP_PASSWORD` for notarytool.
   The signing identity is the full Developer ID Application certificate name.
4. Set repository variable `VOICE_RELEASE_ENABLED=true` only after credentials and release
   validation are ready. Until then the ordinary release omits the helper. The runtime
   preference stays disabled independently of this release variable.
5. Run the signed release workflow and validate a downloaded, quarantined XPI on fresh Macs
   across the supported matrix, including offline launch, first-use permission, upgrade,
   rollback, and microphone release. Do not enable the product until these checks pass.

The macOS release job builds the universal app, imports credentials into a temporary keychain,
signs with hardened runtime/entitlements and a secure timestamp, submits to notarytool,
staples and validates the ticket, assesses with Gatekeeper, then packages the finalized app.
Only that archive is passed to the Linux XPI assembly job. A failed native release blocks
publication; temporary keychains and certificate files are removed on exit. This workflow is
implemented but cannot be validated without the Apple account and certificate.

For local signed release preparation, configure a notarytool keychain profile, export
`VOICE_SIGNING_IDENTITY`, `VOICE_TEAM_ID`, and `VOICE_NOTARY_PROFILE`, then run
`bash native/voice/macos/sign-release.sh` after the build. See Apple's
[notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
