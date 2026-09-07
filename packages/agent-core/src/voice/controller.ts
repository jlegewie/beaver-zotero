import {
    VOICE_FORMAT, VOICE_LIMITS, VOICE_VERSION, idleVoiceSnapshot,
    type CaptureEvent, type TranscriptEvent, type VoiceCapture, type VoiceDependencies,
    type VoiceErrorCode, type VoiceFrame, type VoiceOwner, type VoiceSnapshot, type VoiceTranscription,
} from './contracts';

interface Session {
    id: string;
    userId?: string;
    capture?: VoiceCapture;
    transcription?: VoiceTranscription;
    timers: unknown[];
    queue: VoiceFrame[];
    queuedBytes: number;
    draining: boolean;
    captureDone: boolean;
    endSent: boolean;
    tailSeen: boolean;
    transcriptSequence: number;
    nextSegment: number;
}

/** One controller per host instance, owned outside UI realms. All terminal paths revoke first. */
export class VoiceController {
    private state = idleVoiceSnapshot();
    private active?: Session;
    private listeners = new Set<() => void>();
    private disposed = false;

    constructor(private readonly deps: VoiceDependencies) {}

    getSnapshot = (): VoiceSnapshot => this.state;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    start(owner: VoiceOwner, expectedUserId: string): { sessionId: string } | { error: { code: VoiceErrorCode } } {
        if (this.active) return { error: { code: 'busy' } };
        const capability = this.deps.capability();
        if (this.disposed || !capability.enabled) return { error: { code: 'disabled' } };
        if (!capability.available) return { error: { code: 'unavailable' } };
        const session: Session = {
            id: this.deps.createId(), userId: expectedUserId, timers: [], queue: [], queuedBytes: 0, draining: false,
            captureDone: false, endSent: false, tailSeen: false, transcriptSequence: -1, nextSegment: 0,
        };
        this.active = session;
        this.state = idleVoiceSnapshot();
        const frozenOwner = Object.freeze({ windowId: owner.windowId, output: Object.freeze({ ...owner.output }) });
        this.update({ sessionId: session.id, owner: frozenOwner, phase: 'starting' });
        // Listeners may cancel synchronously when an owning surface disappears.
        if (this.isActive(session)) {
            this.deadline(session, VOICE_LIMITS.startupMs, 'startup_timeout');
            void this.setup(session);
        }
        return { sessionId: session.id };
    }

    finish(sessionId: string): void {
        const s = this.active;
        if (!s || s.id !== sessionId || this.state.phase === 'finalizing') return;
        // Releasing activation during permission/setup requires a fresh activation.
        if (this.state.phase === 'starting') { this.cancel(sessionId); return; }
        this.clearTimers(s);
        this.update({ phase: 'finalizing' });
        if (!this.isActive(s)) return;
        this.deadline(s, VOICE_LIMITS.finalizationMs, 'finalization_timeout');
        void this.finishCapture(s);
    }

    cancel(sessionId: string): void {
        if (this.active?.id === sessionId) this.terminate(this.active, 'canceled');
    }

    windowUnloaded(windowId: string): void {
        if (this.active && this.state.owner?.windowId === windowId) this.cancel(this.active.id);
    }

    /** Call on logout/account replacement, including while credentials are still being resolved. */
    authChanged(userId: string | null): void {
        if (this.active && (!userId || this.active.userId !== userId)) {
            this.terminate(this.active, 'canceled');
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.active) this.terminate(this.active, 'canceled');
        this.listeners.clear();
    }

    private isActive(s: Session): boolean { return this.active === s; }

    private update(patch: Partial<VoiceSnapshot>): void {
        this.state = Object.freeze({ ...this.state, ...patch });
        if (patch.error) Object.freeze(patch.error);
        // A view failing to render must not prevent resource disposal or another view's update.
        for (const listener of [...this.listeners]) { try { listener(); } catch { /* Isolated observer. */ } }
    }

    private deadline(s: Session, ms: number, code: VoiceErrorCode): void {
        s.timers.push(this.deps.clock.setTimeout(() => this.fail(s, code), ms));
    }

    private clearTimers(s: Session): void {
        for (const timer of s.timers) this.deps.clock.clearTimeout(timer);
        s.timers = [];
    }

    private async setup(s: Session): Promise<void> {
        let failureCode: VoiceErrorCode = 'unauthenticated';
        try {
            const auth = await this.deps.getAuth();
            if (!this.isActive(s)) return;
            if (!auth?.credential || !auth.userId) { this.fail(s, 'unauthenticated'); return; }
            if (s.userId && s.userId !== auth.userId) { this.terminate(s, 'canceled'); return; }
            s.userId = auth.userId;
            const envelope = { version: VOICE_VERSION, sessionId: s.id };
            failureCode = 'transcription_failed';
            const transcription = this.deps.createTranscription(envelope, event => this.transcript(s, event));
            if (!this.isActive(s)) { transcription.dispose(); return; }
            s.transcription = transcription;
            await transcription.start(auth.credential);
            if (!this.isActive(s)) return;
            failureCode = 'capture_failed';
            const capture = this.deps.createCapture(envelope, event => this.capture(s, event));
            if (!this.isActive(s)) { capture.dispose(); return; }
            s.capture = capture;
            await capture.start();
            if (!this.isActive(s)) return;
            if (!this.state.captureReady) { this.fail(s, 'protocol_error'); return; }
            this.clearTimers(s);
            this.update({ phase: 'listening' });
            if (this.isActive(s)) this.deadline(s, VOICE_LIMITS.durationMs, 'duration_limit');
        } catch {
            this.fail(s, failureCode);
        }
    }

    private capture(s: Session, event: CaptureEvent): void {
        if (!this.isActive(s) || event.sessionId !== s.id) return;
        if (event.version !== VOICE_VERSION) { this.fail(s, 'protocol_error'); return; }
        if (event.type === 'error') { this.fail(s, event.error.code); return; }
        if (event.type === 'ready') {
            if (this.state.captureReady || !this.validFormat(event.format)) { this.fail(s, 'protocol_error'); return; }
            this.update({ captureReady: true });
            return;
        }
        const f = event.frame;
        if (!this.state.captureReady || s.captureDone || s.tailSeen || f.version !== VOICE_VERSION
            || f.sessionId !== s.id || f.sequence !== this.state.frameCount
            || !Number.isInteger(f.sampleCount) || f.sampleCount <= 0 || f.sampleCount > VOICE_LIMITS.frameSamples
            || f.pcm.byteLength !== f.sampleCount * 2 || !this.validFormat(f.format)
            || (f.sampleCount < VOICE_LIMITS.frameSamples && this.state.phase !== 'finalizing')) {
            this.fail(s, 'protocol_error'); return;
        }
        if (s.queuedBytes + f.pcm.byteLength > VOICE_LIMITS.queuedBytes) { this.fail(s, 'overflow'); return; }
        s.tailSeen = f.sampleCount < VOICE_LIMITS.frameSamples;
        const pcm = new Uint8Array(f.pcm);
        s.queue.push({ ...f, format: VOICE_FORMAT, pcm });
        s.queuedBytes += pcm.byteLength;
        let squares = 0;
        for (let i = 0; i < pcm.length; i += 2) {
            const unsigned = pcm[i] | (pcm[i + 1] << 8);
            const sample = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
            squares += sample * sample;
        }
        this.update({ audioStarted: true, frameCount: f.sequence + 1,
            sampleCount: this.state.sampleCount + f.sampleCount, level: Math.sqrt(squares / f.sampleCount) });
        if (this.isActive(s)) void this.drain(s);
    }

    private validFormat(format: VoiceFrame['format']): boolean {
        return format.encoding === VOICE_FORMAT.encoding && format.sampleRate === VOICE_FORMAT.sampleRate
            && format.channels === VOICE_FORMAT.channels;
    }

    private async drain(s: Session): Promise<void> {
        if (s.draining || !this.isActive(s)) return;
        s.draining = true;
        try {
            while (this.isActive(s) && s.queue.length) {
                const frame = s.queue.shift()!;
                await s.transcription!.send(frame);
                if (!this.isActive(s)) return;
                s.queuedBytes -= frame.pcm.byteLength;
            }
            if (this.isActive(s) && s.captureDone && !s.endSent) {
                s.endSent = true;
                await s.transcription!.finish({ type: 'end_audio', version: VOICE_VERSION, sessionId: s.id,
                    frameCount: this.state.frameCount, sampleCount: this.state.sampleCount });
            }
        } catch { this.fail(s, 'transcription_failed'); }
        finally { s.draining = false; }
    }

    private async finishCapture(s: Session): Promise<void> {
        try {
            await s.capture!.finish();
            if (!this.isActive(s)) return;
            s.captureDone = true;
            void this.drain(s);
        } catch { this.fail(s, 'capture_failed'); }
    }

    private transcript(s: Session, event: TranscriptEvent): void {
        if (!this.isActive(s) || event.sessionId !== s.id) return;
        if (event.version !== VOICE_VERSION) { this.fail(s, 'protocol_error'); return; }
        if (event.type === 'error') { this.fail(s, event.error.code); return; }
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) { this.fail(s, 'protocol_error'); return; }
        if (event.sequence <= s.transcriptSequence) return;
        if (event.sequence !== s.transcriptSequence + 1) { this.fail(s, 'protocol_error'); return; }
        s.transcriptSequence = event.sequence;
        if (event.type === 'complete') {
            if (!s.endSent || this.state.provisionalText) { this.fail(s, 'protocol_error'); return; }
            this.terminate(s, 'completed');
            return;
        }
        if (typeof event.text !== 'string' || !Number.isSafeInteger(event.segmentId) || event.segmentId < 0) { this.fail(s, 'protocol_error'); return; }
        if (event.segmentId < s.nextSegment) return;
        if (event.segmentId !== s.nextSegment) { this.fail(s, 'protocol_error'); return; }
        if (s.nextSegment >= VOICE_LIMITS.segments
            || this.state.committedText.length + event.text.length > VOICE_LIMITS.transcriptCharacters) {
            this.fail(s, 'overflow'); return;
        }
        if (event.type === 'interim') this.update({ provisionalText: event.text });
        else {
            s.nextSegment++;
            this.update({ committedText: this.state.committedText + event.text, provisionalText: '' });
        }
    }

    private fail(s: Session, code: VoiceErrorCode): void {
        if (this.isActive(s)) this.terminate(s, 'error', code);
    }

    private terminate(s: Session, phase: 'completed' | 'canceled' | 'error', code?: VoiceErrorCode): void {
        if (!this.isActive(s)) return;
        this.active = undefined;
        this.clearTimers(s);
        s.queue = [];
        s.queuedBytes = 0;
        // Revocation precedes disposal: adapters may synchronously deliver their last callback.
        try { s.capture?.dispose(); } catch { /* Still dispose the transport. */ }
        try { s.transcription?.dispose(); } catch { /* Terminal state is authoritative. */ }
        this.update({ phase, provisionalText: '', level: 0, error: code ? { code } : null });
    }
}
