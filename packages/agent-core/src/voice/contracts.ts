/** Transport-independent voice protocol. Adapters validate/decode their wire envelopes. */
export const VOICE_VERSION = 1 as const;
export const VOICE_FORMAT = Object.freeze({
    encoding: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
} as const);
export const VOICE_LIMITS = {
    frameSamples: 1600,
    bufferBytes: 3840000,
    minimumSamples: 4800, // 300 ms
    energyWindowSamples: 320, // 20 ms, independent of capture callback size
    minimumEnergySamples: 3200, // 200 ms above the energy floor
    energyRms: 0.01, // -40 dBFS; a conservative energy gate, not speech recognition
    vocabularyCharacters: 32000,
    vocabularyTerms: 1000,
    startupMs: 30000,
    finalizationMs: 10000, // native stop + flush
    transcriptionMs: 30000, // auth refresh + compression + upload + corrected result
    durationMs: 120000,
    transcriptCharacters: 64000,
} as const;

export type VoiceErrorCode =
    | "insufficient_credits"
    | "source_ineligible"
    | "outcome_unknown"
    | "disabled"
    | "unavailable"
    | "busy"
    | "unauthenticated"
    | "permission_denied"
    | "device_unavailable"
    | "capture_failed"
    | "discontinuity"
    | "transcription_failed"
    | "disconnected"
    | "protocol_error"
    | "overflow"
    | "startup_timeout"
    | "finalization_timeout"
    | "transcription_timeout"
    | "duration_limit"
    | "no_speech";
export interface VoiceError {
    code: VoiceErrorCode;
}
export interface VoiceEnvelope {
    version: typeof VOICE_VERSION;
    sessionId: string;
}
export interface VoiceFrame extends VoiceEnvelope {
    sequence: number;
    sampleCount: number;
    format: typeof VOICE_FORMAT;
    /** Owned bytes; the controller copies them before returning to the capture callback. */
    pcm: Uint8Array;
}
export type CaptureEvent =
    | (VoiceEnvelope & { type: "ready"; format: typeof VOICE_FORMAT })
    | (VoiceEnvelope & { type: "frame"; frame: VoiceFrame })
    | (VoiceEnvelope & { type: "quality"; quality: VoiceQuality })
    | (VoiceEnvelope & { type: "error"; error: VoiceError });
/** Content-free, cumulative capture diagnostics. Clipping refers to input before gain control. */
export interface VoiceQuality {
    inputPeak: number;
    clippedSamples: number;
    discontinuityCount: number;
}
export const emptyVoiceQuality = (): VoiceQuality => ({
    inputPeak: 0,
    clippedSamples: 0,
    discontinuityCount: 0,
});
export function validVoiceQuality(
    value: VoiceQuality,
    previous = emptyVoiceQuality(),
): boolean {
    return (
        !!value &&
        Number.isFinite(value.inputPeak) &&
        value.inputPeak >= previous.inputPeak &&
        Number.isSafeInteger(value.clippedSamples) &&
        value.clippedSamples >= previous.clippedSamples &&
        Number.isSafeInteger(value.discontinuityCount) &&
        value.discontinuityCount >= previous.discontinuityCount
    );
}
/** Hosts filter excluded libraries before building this activation-time snapshot. */
export interface VoiceOptions {
    language: string;
    biasTerms: readonly string[];
    correctionVocabulary: readonly string[];
}
export const defaultVoiceOptions = (): VoiceOptions => ({
    language: "en",
    biasTerms: [],
    correctionVocabulary: [],
});
export interface VoiceRecording extends VoiceEnvelope {
    format: typeof VOICE_FORMAT;
    sampleCount: number;
    /** Borrowed until transcribe settles or disposal; never retain, log, or persist these bytes. */
    pcm: Uint8Array;
    options: Readonly<VoiceOptions>;
}
export type VoiceTranscript = VoiceEnvelope &
    ({ text: string } | { error: VoiceError });
export interface VoiceCapture {
    /** Resolves only after ready; must not deliver frames before ready. */
    start(): Promise<void>;
    /** Stops, flushes a possible short final frame, then resolves. No more frames afterward. */
    finish(): Promise<void>;
    /** Synchronously revoke callbacks/setup and stop capture; idempotent, including before start. */
    dispose(): void;
}
export interface VoiceTranscription {
    /** Called once, after capture is flushed and passes the energy gate. The adapter compresses
     * before the authenticated POST and returns the corrected transcript. No network during capture. */
    transcribe(
        recording: VoiceRecording,
        credential: string,
    ): Promise<VoiceTranscript>;
    /** Abort compression/upload, release borrowed audio, and revoke any pending result; idempotent. */
    dispose(): void;
}
export interface VoiceClock {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface VoiceAuth {
    userId: string;
    credential: string;
}
export interface VoiceDependencies {
    clock: VoiceClock;
    createId(): string;
    getAuth(): Promise<VoiceAuth | null>;
    capability(): { enabled: boolean; available: boolean };
    createCapture(
        session: VoiceEnvelope,
        emit: (event: CaptureEvent) => void,
    ): VoiceCapture;
    createTranscription(session: VoiceEnvelope): VoiceTranscription;
}
export interface VoiceOwner {
    windowId: string;
    output: { kind: "composer" | "draft"; id: string };
}
export type VoicePhase =
    | "idle"
    | "starting"
    | "listening"
    | "finalizing"
    | "completed"
    | "canceled"
    | "error";
export function isBusyPhase(phase: VoicePhase): boolean {
    return (
        phase === "starting" || phase === "listening" || phase === "finalizing"
    );
}

export interface VoiceSnapshot {
    sessionId: string | null;
    owner: VoiceOwner | null;
    phase: VoicePhase;
    captureReady: boolean;
    audioStarted: boolean;
    frameCount: number;
    sampleCount: number;
    level: number;
    committedText: string;
    quality: Readonly<VoiceQuality>;
    clipping: boolean;
    error: VoiceError | null;
}
export const idleVoiceSnapshot = (): VoiceSnapshot => ({
    sessionId: null,
    owner: null,
    phase: "idle",
    captureReady: false,
    audioStarted: false,
    frameCount: 0,
    sampleCount: 0,
    level: 0,
    committedText: "",
    quality: Object.freeze(emptyVoiceQuality()),
    clipping: false,
    error: null,
});

/** A shared projection reserves transcript insertion for the originating output only. */
export function projectVoice(snapshot: VoiceSnapshot, owner: VoiceOwner) {
    const ownsOutput =
        snapshot.owner?.windowId === owner.windowId &&
        snapshot.owner.output.kind === owner.output.kind &&
        snapshot.owner.output.id === owner.output.id;
    return { ...snapshot, busy: isBusyPhase(snapshot.phase), ownsOutput };
}
