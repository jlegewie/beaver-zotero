# Native voice capture

Native capture implementations live with their consuming plugin. macOS source is in
`macos/`; a future Windows implementation can live in `windows/`. They share the
[portable capture contract](../../docs/voice-protocol.md), PCM format, and acceptance
fixtures, but have independent launch mechanisms, transports, and build tools.

The helper does not contain backend credentials, transcription, billing, or editor code.
The plugin owns those responsibilities and the active-session lock. Production voice
activation remains disabled. Native adapters exist only in development builds. The loopback listener opens after
a helper is verified and registered; production opens no voice port.

## macOS development

Requirements: macOS, Xcode command-line tools (Swift and the macOS SDK), and a development
Zotero instance. The build uses system frameworks only, targets the build machine's
architecture with a macOS 14.0 deployment target, and creates an ad-hoc-signed local app. This is not a distribution artifact.
Developer ID signing, notarization, universal builds, verified extraction and upgrades are
separate release work.

```sh
native/voice/macos/build.sh
native/voice/macos/test.sh
```

The app is `native/voice/macos/build/Beaver Voice Input.app`. Its stable identity is
`ai.beaverapp.voice`, its usage description names dictation in Beaver, and it carries the
microphone entitlement. Generated apps, module caches, and recordings are not checked in.

In the **intended isolated Zotero instance's** async Run JavaScript window:

```js
await Zotero.Beaver.voiceNative.setDevelopmentHelper(
    "/absolute/path/Beaver Voice Input.app",
);
```

From privileged development tooling, invoke the following with a focused originating
Zotero window. A Run JavaScript dialog itself owns focus; use its actual window as the
owner or invoke from the main window after the dialog closes. Do not disable the focus
check in product code.

```js
await Zotero.Beaver.voiceHarness.startNative(originatingWindow);
Zotero.Beaver.voiceHarness.nativeState();
const { sessionId } = Zotero.Beaver.voice.controller.getSnapshot();
Zotero.Beaver.voice.controller.finish(sessionId); // stop + tail + completion
// Or: Zotero.Beaver.voice.controller.cancel(sessionId);
```

Registering a helper always clears cached permission, including when a rebuild uses the
same path. The next activation runs permission-only setup again.

The first-use explanation identifies the companion app before macOS asks for permission.
The initial `startNative` runs a separate permission-only lease, returning `{setup: true,
permission, help}`. Setup tolerates focus transfer to the system prompt, but window unload,
plugin shutdown, and the 30-second startup deadline still revoke it. First permission setup cannot record: even an affirmative response requires another
activation. A canceled activation cannot later open the microphone. Denial/restriction is
reported explicitly; silence is valid PCM and is never diagnosed as a permission failure.
`nativeState()` supplies permission state and actionable recovery text. For denied access,
allow **Beaver Voice Input** in System Settings → Privacy & Security → Microphone; for a
missing device, check System Settings → Sound → Input.

No audio is saved by default. For an explicitly agreed local listening check only:

```js
await Zotero.Beaver.voiceHarness.startNative(originatingWindow, true);
// Finish first, then save a bounded 16 kHz mono PCM16 WAV:
await Zotero.Beaver.voiceHarness.saveRecording("/absolute/path/voice-test.wav");
```

The retention bound is 120 seconds. Saving clears the retained buffers. A fresh activation
also replaces them. No backend connection or transcription occurs: this harness uses the
scripted transcription adapter to acknowledge completion. Native recording/metrics/export
live in `NativeCaptureHarness`, composed with the synthetic harness around one shared
`VoiceService`. Session IDs select the capture adapter; a native activation does not enable
subsequent synthetic sessions. Do not log or publish recordings.

## Local IPC

The development plugin owns a dedicated loopback-only HTTP listener, bound by Gecko to an OS-assigned
port. This is intentionally separate from `Zotero.Server`'s generic request handler, which
logs headers/bodies and does not expose a pre-read per-endpoint body limit. The actual
allocated voice port is supplied to the helper; neither a voice port nor Zotero's connector
port is hard-coded. No development HTTP endpoints are enabled in production.

Launch is `/usr/bin/open -n -g <app> --args --port <allocated> --token <random> --session <id>`.
The inner executable must not be launched directly for microphone capture. A 256-bit
cryptographic token authorizes one session and is revoked synchronously on disposal.
Only `POST /voice HTTP/1.1`, exact `Host: 127.0.0.1:<port>`, JSON, and a bounded explicit
Content-Length are accepted. Browser Origin/fetch metadata, chunked requests, duplicate
headers, pipelining, oversized input, and unsupported methods are rejected. Requests and
responses use `Connection: close`; this small, private protocol is not a general HTTP server.

Bounds: 4 KiB headers, 6 KiB JSON body, 8 simultaneous connections, 2-second request lifetime.
The socket limits reads before allocating/decoding the body. Responses do not include audio
or tokens. Authentication precedes JSON parsing. Invalid tokens cannot fail another session.
Authenticated malformed messages fail that lease. No request content reaches host debug logs.

Each body carries `version: 1` and `sessionId`. Helper event messages have contiguous
`eventSequence` starting at zero:

| Type              | Additional fields                                               |
| ----------------- | --------------------------------------------------------------- |
| `hello`           | `helperVersion: 1`, diagnostic process `pid`                    |
| `permission`      | `status: not_determined / granted / denied / restricted`        |
| `permission_done` | setup-only terminal permission status; no capture               |
| `ready`           | `format: {encoding: pcm_s16le, sampleRate: 16000, channels: 1}` |
| `frame`           | contiguous audio `sequence`, `sampleCount`, base64 `pcm`        |
| `error`           | a named capture error `code`                                    |
| `done`            | total `frameCount`, `sampleCount` after all frames              |

Control requests have `type: control` and their own contiguous `sequence`. They do not
share the event upload queue. Every successful response contains the session envelope
and `command: continue / finish / cancel / exit`. The helper bounds response reads to 1 KiB before retaining the body and refuses HTTP
redirects. A non-200 response, invalid response, or failed request terminates the helper. No audio replay or transparent reconnect occurs.

The launch flag `--permission-only` cannot open the audio engine, and its lease rejects
`ready` or audio frames. A normal capture lease rejects `permission_done`.

Control runs every 500 ms. An independent helper watchdog exits after 3 seconds without
control contact, after a 30-second startup/permission deadline, after a 10-second finish deadline, or after a 155-second absolute lifetime.
Cancellation exits from the receiving queue even if the main loop is stuck. Process exit
releases the microphone at the OS boundary. The plugin independently bounds startup to
30 seconds, capture stalls/control silence to 3 seconds, recording to 120 seconds, and
finalization to 10 seconds. App/window/identity/plugin lifecycle invalidates the capture
lease; the helper receives cancellation at its next contact or expires independently.

The audio tap copies into a bounded input queue (2 MiB), then performs arithmetic channel
averaging and stateful AVAudioConverter conversion on a serial queue. The event queue
retains at most 160,000 PCM bytes. Overflow fails instead of dropping speech. Finish stops
the engine, drains admitted input, signals end-of-stream to the converter, flushes the last
short frame, uploads it, and only then sends `done`. A device configuration change fails
with `discontinuity`, requiring a fresh activation.

## Verification

```sh
npx vitest run tests/unit/voice
# Separate fault-test app; this build does not access the microphone:
VOICE_TESTING=1 native/voice/macos/build.sh
python3 native/voice/macos/Tests/lifecycle.py
# After a plugin reload, check lazy startup and permission/setup failure recovery:
python3 native/voice/tests/zotero-setup.py
# Real socket + adapter, using this worktree's .worktree-meta.json (no microphone):
python3 native/voice/tests/zotero-ipc.py
python3 native/voice/tests/zotero-native.py
# Explicitly replaces the plugin and kills only the checked isolated profile:
python3 native/voice/tests/zotero-shutdown.py
```

Fixture builds default to `build/tests/`; ordinary builds default to `build/`.
`VOICE_BUILD_DIR` can explicitly override either destination.

The fault-test app has identity `ai.beaverapp.voice.tests`. Its generated PCM and faults
are compiled only with `VOICE_TESTING`; the production helper has no test-mode behavior.
These checks complement, and do not replace, physical microphone/permission/device tests.
The Zotero native/shutdown scripts accept `--microphone` to select the real helper instead
of the generated source; use that option only when real microphone testing is intended.
Those scripts never retain audio. `VOICE_LONG_TEST=1` also exercises the real 120-second
duration and 155-second absolute watchdog limits in the microphone-free lifecycle suite.
