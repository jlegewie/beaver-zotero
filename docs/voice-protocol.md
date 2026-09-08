# Voice protocol v1

Voice support provides a portable batch session controller, a synthetic development harness,
and a macOS capture adapter with a local capture harness. Production activation remains
feature-disabled. Backend transcription, compression/upload, vocabulary collection, preferences,
editor insertion, shortcuts, billing, and submission are not enabled. See
[native capture](../native/voice/README.md) for build and IPC verification.

## Ownership and lifecycle

Create exactly one `VoiceController` (`@beaver/agent-core/voice/controller`) per application
instance. In Zotero, `Zotero.Beaver.voice` owns it in the plugin realm. Views subscribe and use
`projectVoice` to identify the originating window/output. Only `ownsOutput` may insert a result;
other mounted views observe the busy state. Outputs are immutable `{kind: "composer" | "draft",
id}` identities. The controller never writes editor or chat state.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> starting: enabled + available + lock acquired
    starting --> listening: auth + capture ready
    starting --> canceled: finish / cancel / owner lost
    starting --> error: setup failure / startup deadline
    listening --> finalizing: finish
    listening --> canceled: cancel / owner lost
    listening --> error: capture failure / duration bound
    finalizing --> completed: capture flushed + energy gate + batch result
    finalizing --> canceled: cancel / owner lost
    finalizing --> error: no speech / failure / deadline
    completed --> starting: fresh activation
    canceled --> starting: fresh activation
    error --> starting: fresh activation
```

Ready means setup succeeded, not that audio flowed. `audioStarted` becomes true on the first
valid frame, including silence. Silence never implies denied permission. Finishing while starting
cancels; late permission/setup results require fresh activation. `start()` returns the allocated
session ID, not a readiness guarantee. The snapshot remains authoritative if a synchronous
observer cancels before `start()` returns. Repeated finish/cancel and old-session commands are
harmless. Session IDs must be unique per activation.

The service accepts activation only from a focused window and cancels on that window's unload
or top-level blur. Internal focus movement is ignored. Logout/account replacement cancels,
including while authentication is unresolved. The expected user ID is required at activation;
resolved credentials must match. Same-user token refresh does not cancel. Credentials are
reacquired before upload, checked again against the same user, and never stored in public state
or passed to the native helper. Plugin shutdown disposes the service. System timers remain
active independently of window realms. Closing the last macOS window cancels its session
without destroying app-lifetime services.

## Capture and batch adapters

Factories synchronously return owned handles before asynchronous setup. They must not start
network work in their constructors. Capture `start()` emits `ready` with the format and resolves;
frames may follow readiness. `finish()` stops capture, flushes a possible short final frame, and
resolves only after all callbacks. No frame or quality event may follow its resolution.

The controller copies incoming PCM into a bounded private buffer. No audio leaves the plugin
while listening. On finish it releases capture, applies the duration/energy gate, refreshes auth,
and calls `VoiceTranscription.transcribe(recording, credential)` exactly once. `VoiceRecording`
contains the session envelope, format, total sample count, borrowed PCM, and immutable options.
The future backend adapter must compress before its authenticated POST and return the corrected
transcript. Codec, provider, and network details belong in that adapter, not native capture or
portable state. There is no transcription WebSocket, frame-send method, segment stream, or
separate completion acknowledgement.

`VoiceTranscript` returns `{version, sessionId, text}` or `{version, sessionId, error: {code}}`.
A valid result atomically sets `committedText` and completes the session. Empty text is valid and
must not trigger insertion/countdown/submission in consumers. While listening/finalizing there
is no provisional text. Wrong-session/version or malformed results fail; canceled sessions
ignore late promise settlements. Failed sessions have no partial transcript. Existing composer
text remains owned by the editor and must be preserved by the future insertion integration.

`dispose()` is idempotent, even during setup. Capture revokes callbacks and stops its resources;
transcription aborts encoding/upload and releases all borrowed bytes. The controller revokes the
session first, clears timers, zeroes/releases its audio buffer, and disposes both handles even
if one throws. Adapters must release any derived encoded buffers on disposal and must not retain,
log, or persist audio by default. No transparent replay/reconnect is permitted.

## Activation options

`VoiceOptions` contains an explicit language (default `en`), provider bias terms, and a larger
correction vocabulary. The controller copies/freezes both arrays at activation; later selection
or preference changes cannot alter the utterance's context. Hosts must filter excluded libraries
before constructing these lists. Each list is bounded to 1,000 nonempty terms and 32,000 UTF-16
code units; adapters must apply their provider's smaller token/term budget. Library discovery,
term selection, language preference UI, and backend correction are integration responsibilities.
Options, credentials, vocabulary, and PCM are absent from snapshots and telemetry.

## Frames and quality

Every event has `{version: 1, sessionId}`. Capture frame sequences are zero-based and contiguous;
transcription has no segment identities or sequence counters. IPC adapters validate unknown
input, negotiate versions, and enforce bounds before decoding/allocating. Wrong-session capture
callbacks are ignored; a mismatched version fails the active session.

Audio is **16,000 Hz, mono, signed PCM16 little-endian** (`pcm_s16le`). `VoiceFrame` carries
`sequence`, `sampleCount`, `format`, and `pcm` (`Uint8Array`, two bytes/sample). Frames normally
contain 1,600 samples (100 ms). Finish permits one shorter, nonempty tail. Empty tails emit no
frame. Gaps, duplicates, wrong lengths/formats, early short frames, and frames after a short tail
are protocol errors. Native IPC keeps its own ordering, backpressure, and watchdogs.

`quality` capture events carry cumulative `inputPeak`, `clippedSamples` (input sample positions
where any channel approaches full scale), and `discontinuityCount`. Values must be finite,
nonnegative, and nondecreasing; counts must be safe integers. Snapshots expose immutable quality
and a session-latched `clipping` flag for warning UI. Counts remain available after termination
for content-free telemetry. A discontinuity can still fail capture; counting it does not authorize
silently dropping speech. Silence remains valid audio during capture.

The macOS converter downmixes and applies bounded gain before conversion. It preserves ordinary
speech levels, avoids boosting near-silence, caps quiet-speech amplification at 4×, and limits
peaks with headroom for resampling. Input clipping is measured before processing; already-clipped
microphone audio cannot be repaired. Audio sample timestamps detect missing/repeated input.
The development native harness exposes clipping recovery text and quality through `nativeState()`.

## Limits and energy gate

| Limit                                                  |                                             Value |
| ------------------------------------------------------ | ------------------------------------------------: |
| Frame samples / bytes                                  |                                     1,600 / 3,200 |
| Full recording buffer                                  |                       3,840,000 bytes (120 s PCM) |
| Authentication + capture startup                       |                                              30 s |
| Native finish + tail flush                             |                                              10 s |
| Auth refresh + compression + upload + corrected result |                                              30 s |
| Listening duration                                     |              120 s, also enforced by sample count |
| Minimum recording                                      |                            4,800 samples (300 ms) |
| Energy window                                          |                               320 samples (20 ms) |
| Required energy                                        | 3,200 samples (200 ms) in windows with RMS ≥ 0.01 |
| Final transcript                                       |                          64,000 UTF-16 code units |

Energy windows span frame boundaries and include complete windows in the final tail. The gate
rejects short, muted, near-silent, and isolated-click captures with `no_speech`, without invoking
transcription. RMS 0.01 is −40 dBFS. This is a conservative energy gate, not a speech classifier;
thresholds require real-microphone validation and cannot distinguish sustained noise from speech.
The 300 ms check is independent of the future keyboard hold threshold.

`VOICE_LIMITS` defines client bounds. Native and backend adapters independently enforce their
applicable bounds; client limits are not an authorization boundary. Recording past either duration
bound fails with `duration_limit`, without silently truncating or uploading a partial recording.

Errors contain named codes only: `disabled`, `unavailable`, `busy`, `unauthenticated`,
`permission_denied`, `device_unavailable`, `capture_failed`, `discontinuity`,
`transcription_failed`, `disconnected`, `protocol_error`, `overflow`, `startup_timeout`,
`finalization_timeout`, `transcription_timeout`, `duration_limit`, `no_speech`.

## Reproducible synthetic harness

Use a development build in a logged-in Zotero instance. The endpoint is absent in production
and rejects production invocation. The harness starts disabled and cannot open a microphone
or provider connection. Its synthetic owner makes HTTP tests independent of desktop focus;
service tests separately cover real-window lifecycle. Determine the actual port from worktree
metadata or `Zotero.Server.port`.

```sh
voice() {
  curl --fail -sS -X POST "http://127.0.0.1:$VOICE_HTTP_PORT/beaver/test/voice" \
    -H 'Content-Type: application/json' -d "$1"
}
voice '{"command":"enable","enabled":true}'
voice '{"command":"start"}'
voice '{"command":"state"}' # wait for listening
voice '{"command":"frame"}'
voice '{"command":"frame"}'
voice '{"command":"frame"}'
voice '{"command":"transcript","text":"A short voice test."}' # stages the fake response only
voice '{"command":"finish"}'
voice '{"command":"state"}' # completed: 4 frames, 5440 samples, 1 request, handles disposed
voice '{"command":"enable","enabled":false}'
```

`tests/fixtures/voice/session.json` is the handoff fixture. Fake frames contain a deterministic
440 Hz tone at amplitude 0.2, followed by a 640-sample tail. Fakes record request/sample counts
without retaining audio. Unit tests replay the fixture; live tests replay it through both Zotero
bundles and check that thread/run IDs remain unchanged. Nothing is submitted as chat.

```sh
npx vitest run tests/unit/voice
ZOTERO_HTTP_PORT="$VOICE_HTTP_PORT" npx vitest run --config vitest.live.config.ts tests/live/voice.live.test.ts
native/voice/macos/test.sh
npm run typecheck:core
npm run typecheck:ui
npm run check:bundle
npx tsc --noEmit
```
