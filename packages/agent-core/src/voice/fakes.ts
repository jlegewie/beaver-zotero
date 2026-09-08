import {
    VOICE_FORMAT,
    type CaptureEvent,
    type VoiceCapture,
    type VoiceEnvelope,
    type VoiceRecording,
    type VoiceTranscript,
    type VoiceTranscription,
} from "./contracts";

/** Manually driven fake: no microphone, provider, timers, or retained audio. */
export class FakeVoiceCapture implements VoiceCapture {
    get disposed(): boolean {
        return this.disposeCount > 0;
    }
    disposeCount = 0;
    finishCount = 0;
    sequence = 0;
    tailSamples = 640;
    constructor(
        readonly session: VoiceEnvelope,
        readonly emit: (event: CaptureEvent) => void,
    ) {}
    async start(): Promise<void> {
        if (!this.disposed)
            this.emit({ ...this.session, type: "ready", format: VOICE_FORMAT });
    }
    frame(sampleCount = 1600, amplitude = 0.2): void {
        if (this.disposed) return;
        const pcm = new Uint8Array(sampleCount * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < sampleCount; i++)
            view.setInt16(
                i * 2,
                Math.round(
                    Math.sin((2 * Math.PI * 440 * i) / 16000) *
                        amplitude *
                        32767,
                ),
                true,
            );
        this.emit({
            ...this.session,
            type: "frame",
            frame: {
                ...this.session,
                sequence: this.sequence++,
                sampleCount,
                format: VOICE_FORMAT,
                pcm,
            },
        });
    }
    async finish(): Promise<void> {
        if (this.disposed || this.finishCount) return;
        this.finishCount++;
        if (this.tailSamples) this.frame(this.tailSamples);
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposeCount++;
    }
}

/** Deterministic batch adapter. Retains counts only; callers may delay/replace transcribe in tests. */
export class FakeVoiceTranscription implements VoiceTranscription {
    get disposed(): boolean {
        return this.disposeCount > 0;
    }
    disposeCount = 0;
    requestCount = 0;
    sampleCount = 0;
    resultText = "";
    constructor(readonly session: VoiceEnvelope) {}
    async transcribe(
        recording: VoiceRecording,
        _credential: string,
    ): Promise<VoiceTranscript> {
        if (this.disposed) throw new Error("Transcription disposed");
        this.requestCount++;
        this.sampleCount = recording.sampleCount;
        return { ...this.session, text: this.resultText };
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposeCount++;
    }
}
