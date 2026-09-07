/** Transport-independent voice protocol. Adapters validate/decode their wire envelopes. */
export const VOICE_VERSION = 1 as const;
export const VOICE_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 } as const);
export const VOICE_LIMITS = {
    frameSamples: 1600,
    queuedBytes: 160000,
    startupMs: 30000,
    finalizationMs: 10000,
    durationMs: 120000,
    transcriptCharacters: 64000,
    segments: 1000,
} as const;

export type VoiceErrorCode = 'disabled' | 'unavailable' | 'busy' | 'unauthenticated'
    | 'permission_denied' | 'device_unavailable' | 'capture_failed' | 'discontinuity'
    | 'transcription_failed' | 'disconnected' | 'protocol_error' | 'overflow'
    | 'startup_timeout' | 'finalization_timeout' | 'duration_limit';
export interface VoiceError { code: VoiceErrorCode }
export interface VoiceEnvelope { version: typeof VOICE_VERSION; sessionId: string }
export interface VoiceFrame extends VoiceEnvelope {
    sequence: number;
    sampleCount: number;
    format: typeof VOICE_FORMAT;
    /** Owned bytes; the controller copies them before returning to the capture callback. */
    pcm: Uint8Array;
}
export type CaptureEvent =
    | (VoiceEnvelope & { type: 'ready'; format: typeof VOICE_FORMAT })
    | (VoiceEnvelope & { type: 'frame'; frame: VoiceFrame })
    | (VoiceEnvelope & { type: 'error'; error: VoiceError });
export type TranscriptEvent = VoiceEnvelope & (
    | { type: 'interim' | 'segment_final'; sequence: number; segmentId: number; text: string }
    | { type: 'complete'; sequence: number }
    | { type: 'error'; error: VoiceError }
);
export type VoiceControl = VoiceEnvelope & (
    | { type: 'finish' }
    | { type: 'cancel' }
    | { type: 'end_audio'; frameCount: number; sampleCount: number }
);
export interface VoiceCapture {
    /** Resolves only after ready; must not deliver frames before ready. */
    start(): Promise<void>;
    /** Stops, flushes a possible short final frame, then resolves. No more frames afterward. */
    finish(): Promise<void>;
    /** Synchronously revoke callbacks/setup and stop capture; idempotent, including before start. */
    dispose(): void;
}
export interface VoiceTranscription {
    /** Authenticate and become ready before capture starts. Never retain credentials in state. */
    start(credential: string): Promise<void>;
    /** Resolves when bounded transport capacity is available again, not merely after enqueue. */
    send(frame: VoiceFrame): Promise<void>;
    /** Complete is a separate event, emitted after all final segments. */
    finish(control: VoiceControl & { type: 'end_audio' }): Promise<void>;
    /** Close transport/provider; cancel setup and pending sends. Never reconnect/replay. */
    dispose(): void;
}
export interface VoiceClock {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface VoiceAuth { userId: string; credential: string }
export interface VoiceDependencies {
    clock: VoiceClock;
    createId(): string;
    getAuth(): Promise<VoiceAuth | null>;
    capability(): { enabled: boolean; available: boolean };
    createCapture(session: VoiceEnvelope, emit: (event: CaptureEvent) => void): VoiceCapture;
    createTranscription(session: VoiceEnvelope, emit: (event: TranscriptEvent) => void): VoiceTranscription;
}
export interface VoiceOwner {
    windowId: string;
    output: { kind: 'composer' | 'draft'; id: string };
}
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'finalizing' | 'completed' | 'canceled' | 'error';
export function isBusyPhase(phase: VoicePhase): boolean {
    return phase === 'starting' || phase === 'listening' || phase === 'finalizing';
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
    provisionalText: string;
    error: VoiceError | null;
}
export const idleVoiceSnapshot = (): VoiceSnapshot => ({
    sessionId: null, owner: null, phase: 'idle', captureReady: false, audioStarted: false,
    frameCount: 0, sampleCount: 0, level: 0, committedText: '', provisionalText: '', error: null,
});

/** A shared projection reserves transcript insertion for the originating output only. */
export function projectVoice(snapshot: VoiceSnapshot, owner: VoiceOwner) {
    const ownsOutput = snapshot.owner?.windowId === owner.windowId
        && snapshot.owner.output.kind === owner.output.kind && snapshot.owner.output.id === owner.output.id;
    return { ...snapshot, busy: isBusyPhase(snapshot.phase), ownsOutput };
}
