import {
    VOICE_FORMAT, type CaptureEvent, type TranscriptEvent, type VoiceCapture,
    type VoiceControl, type VoiceEnvelope, type VoiceFrame, type VoiceTranscription,
} from './contracts';

/** Manually driven fake: no microphone, provider, timers, or retained audio. */
export class FakeVoiceCapture implements VoiceCapture {
    get disposed(): boolean { return this.disposeCount > 0; }
    disposeCount = 0;
    finishCount = 0;
    sequence = 0;
    tailSamples = 640;
    constructor(readonly session: VoiceEnvelope, readonly emit: (event: CaptureEvent) => void) {}
    async start(): Promise<void> {
        if (!this.disposed) this.emit({ ...this.session, type: 'ready', format: VOICE_FORMAT });
    }
    frame(sampleCount = 1600): void {
        if (this.disposed) return;
        this.emit({ ...this.session, type: 'frame', frame: {
            ...this.session, sequence: this.sequence++, sampleCount, format: VOICE_FORMAT,
            pcm: new Uint8Array(sampleCount * 2),
        } });
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

/** Script transcript events explicitly; finish optionally emits a complete acknowledgement. */
export class FakeVoiceTranscription implements VoiceTranscription {
    get disposed(): boolean { return this.disposeCount > 0; }
    disposeCount = 0;
    sendCount = 0;
    sampleCount = 0;
    sequence = 0;
    autoComplete = true;
    endAudio?: VoiceControl & { type: 'end_audio' };
    constructor(readonly session: VoiceEnvelope, readonly emit: (event: TranscriptEvent) => void) {}
    async start(_credential: string): Promise<void> {}
    async send(frame: VoiceFrame): Promise<void> {
        if (this.disposed) return;
        this.sendCount++;
        this.sampleCount += frame.sampleCount;
    }
    text(type: 'interim' | 'segment_final', segmentId: number, text: string): void {
        if (!this.disposed) this.emit({ ...this.session, type, segmentId, text, sequence: this.sequence++ });
    }
    complete(): void {
        if (!this.disposed) this.emit({ ...this.session, type: 'complete', sequence: this.sequence++ });
    }
    async finish(control: VoiceControl & { type: 'end_audio' }): Promise<void> {
        if (this.disposed) return;
        this.endAudio = control;
        if (this.autoComplete) this.complete();
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposeCount++;
    }
}
