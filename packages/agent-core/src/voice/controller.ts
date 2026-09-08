import {
    VOICE_FORMAT,
    VOICE_LIMITS,
    VOICE_VERSION,
    idleVoiceSnapshot,
    defaultVoiceOptions,
    validVoiceQuality,
    type VoiceOptions,
    type CaptureEvent,
    type VoiceCapture,
    type VoiceDependencies,
    type VoiceErrorCode,
    type VoiceFrame,
    type VoiceOwner,
    type VoiceSnapshot,
    type VoiceTranscription,
} from "./contracts";

interface Session {
    id: string;
    userId?: string;
    capture?: VoiceCapture;
    transcription?: VoiceTranscription;
    timers: unknown[];
    buffer?: Uint8Array;
    options: Readonly<VoiceOptions>;
    energySamples: number;
    windowSamples: number;
    windowSquares: number;
    captureDone: boolean;
    tailSeen: boolean;
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
        return () => {
            this.listeners.delete(listener);
        };
    };

    start(
        owner: VoiceOwner,
        expectedUserId: string,
        options: VoiceOptions = defaultVoiceOptions(),
    ): { sessionId: string } | { error: { code: VoiceErrorCode } } {
        if (this.active) return { error: { code: "busy" } };
        const capability = this.deps.capability();
        if (this.disposed || !capability.enabled)
            return { error: { code: "disabled" } };
        if (!capability.available) return { error: { code: "unavailable" } };
        if (
            !options ||
            typeof options.language !== "string" ||
            !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.language) ||
            ![options.biasTerms, options.correctionVocabulary].every(
                (terms) =>
                    Array.isArray(terms) &&
                    terms.length <= VOICE_LIMITS.vocabularyTerms &&
                    terms.every(
                        (term) => typeof term === "string" && term.length > 0,
                    ) &&
                    terms.reduce((n, term) => n + term.length, 0) <=
                        VOICE_LIMITS.vocabularyCharacters,
            )
        ) {
            return { error: { code: "protocol_error" } };
        }
        const session: Session = {
            id: this.deps.createId(),
            userId: expectedUserId,
            timers: [],
            options: Object.freeze({
                language: options.language,
                biasTerms: Object.freeze([...options.biasTerms]),
                correctionVocabulary: Object.freeze([
                    ...options.correctionVocabulary,
                ]),
            }),
            energySamples: 0,
            windowSamples: 0,
            windowSquares: 0,
            captureDone: false,
            tailSeen: false,
        };
        this.active = session;
        this.state = idleVoiceSnapshot();
        const frozenOwner = Object.freeze({
            windowId: owner.windowId,
            output: Object.freeze({ ...owner.output }),
        });
        this.update({
            sessionId: session.id,
            owner: frozenOwner,
            phase: "starting",
        });
        // Listeners may cancel synchronously when an owning surface disappears.
        if (this.isActive(session)) {
            this.deadline(session, VOICE_LIMITS.startupMs, "startup_timeout");
            void this.setup(session);
        }
        return { sessionId: session.id };
    }

    finish(sessionId: string): void {
        const s = this.active;
        if (!s || s.id !== sessionId || this.state.phase === "finalizing")
            return;
        // Releasing activation during permission/setup requires a fresh activation.
        if (this.state.phase === "starting") {
            this.cancel(sessionId);
            return;
        }
        this.clearTimers(s);
        this.update({ phase: "finalizing" });
        if (!this.isActive(s)) return;
        this.deadline(s, VOICE_LIMITS.finalizationMs, "finalization_timeout");
        void this.finishCapture(s);
    }

    cancel(sessionId: string): void {
        if (this.active?.id === sessionId)
            this.terminate(this.active, "canceled");
    }

    windowUnloaded(windowId: string): void {
        if (this.active && this.state.owner?.windowId === windowId)
            this.cancel(this.active.id);
    }

    /** Call on logout/account replacement, including while credentials are still being resolved. */
    authChanged(userId: string | null): void {
        if (this.active && (!userId || this.active.userId !== userId)) {
            this.terminate(this.active, "canceled");
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.active) this.terminate(this.active, "canceled");
        this.listeners.clear();
    }

    private isActive(s: Session): boolean {
        return this.active === s;
    }

    private update(patch: Partial<VoiceSnapshot>): void {
        this.state = Object.freeze({ ...this.state, ...patch });
        if (patch.error) Object.freeze(patch.error);
        // A view failing to render must not prevent resource disposal or another view's update.
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                /* Isolated observer. */
            }
        }
    }

    private deadline(s: Session, ms: number, code: VoiceErrorCode): void {
        s.timers.push(this.deps.clock.setTimeout(() => this.fail(s, code), ms));
    }

    private clearTimers(s: Session): void {
        for (const timer of s.timers) this.deps.clock.clearTimeout(timer);
        s.timers = [];
    }

    private async setup(s: Session): Promise<void> {
        let failureCode: VoiceErrorCode = "unauthenticated";
        try {
            const auth = await this.deps.getAuth();
            if (!this.isActive(s)) return;
            if (!auth?.credential || !auth.userId) {
                this.fail(s, "unauthenticated");
                return;
            }
            if (s.userId && s.userId !== auth.userId) {
                this.terminate(s, "canceled");
                return;
            }
            s.userId = auth.userId;
            const envelope = { version: VOICE_VERSION, sessionId: s.id };
            failureCode = "transcription_failed";
            const transcription = this.deps.createTranscription(envelope);
            if (!this.isActive(s)) {
                transcription.dispose();
                return;
            }
            s.transcription = transcription;
            failureCode = "capture_failed";
            const capture = this.deps.createCapture(envelope, (event) =>
                this.capture(s, event),
            );
            if (!this.isActive(s)) {
                capture.dispose();
                return;
            }
            s.capture = capture;
            await capture.start();
            if (!this.isActive(s)) return;
            if (!this.state.captureReady) {
                this.fail(s, "protocol_error");
                return;
            }
            this.clearTimers(s);
            this.update({ phase: "listening" });
            if (this.isActive(s))
                this.deadline(s, VOICE_LIMITS.durationMs, "duration_limit");
        } catch {
            this.fail(s, failureCode);
        }
    }

    private capture(s: Session, event: CaptureEvent): void {
        if (!this.isActive(s) || event.sessionId !== s.id) return;
        if (event.version !== VOICE_VERSION) {
            this.fail(s, "protocol_error");
            return;
        }
        if (event.type === "error") {
            this.fail(s, event.error.code);
            return;
        }
        if (event.type === "quality") {
            if (
                s.captureDone ||
                !validVoiceQuality(event.quality, this.state.quality)
            ) {
                this.fail(s, "protocol_error");
                return;
            }
            this.update({
                quality: Object.freeze({ ...event.quality }),
                clipping: event.quality.clippedSamples > 0,
            });
            return;
        }
        if (event.type === "ready") {
            if (this.state.captureReady || !this.validFormat(event.format)) {
                this.fail(s, "protocol_error");
                return;
            }
            this.update({ captureReady: true });
            return;
        }
        const f = event.frame;
        if (
            !this.state.captureReady ||
            s.captureDone ||
            s.tailSeen ||
            f.version !== VOICE_VERSION ||
            f.sessionId !== s.id ||
            f.sequence !== this.state.frameCount ||
            !Number.isInteger(f.sampleCount) ||
            f.sampleCount <= 0 ||
            f.sampleCount > VOICE_LIMITS.frameSamples ||
            f.pcm.byteLength !== f.sampleCount * 2 ||
            !this.validFormat(f.format) ||
            (f.sampleCount < VOICE_LIMITS.frameSamples &&
                this.state.phase !== "finalizing")
        ) {
            this.fail(s, "protocol_error");
            return;
        }
        const offset = this.state.sampleCount * 2;
        if (offset + f.pcm.byteLength > VOICE_LIMITS.bufferBytes) {
            this.fail(s, "duration_limit");
            return;
        }
        s.tailSeen = f.sampleCount < VOICE_LIMITS.frameSamples;
        s.buffer ??= new Uint8Array(VOICE_LIMITS.bufferBytes);
        s.buffer.set(f.pcm, offset);
        const pcm = s.buffer.subarray(offset, offset + f.pcm.byteLength);
        let squares = 0;
        for (let i = 0; i < pcm.length; i += 2) {
            const unsigned = pcm[i] | (pcm[i + 1] << 8);
            const sample =
                (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
            squares += sample * sample;
            s.windowSquares += sample * sample;
            if (++s.windowSamples === VOICE_LIMITS.energyWindowSamples) {
                if (
                    s.windowSquares / s.windowSamples >=
                    VOICE_LIMITS.energyRms ** 2
                )
                    s.energySamples += s.windowSamples;
                s.windowSamples = 0;
                s.windowSquares = 0;
            }
        }
        this.update({
            audioStarted: true,
            frameCount: f.sequence + 1,
            sampleCount: this.state.sampleCount + f.sampleCount,
            level: Math.sqrt(squares / f.sampleCount),
        });
    }

    private validFormat(format: VoiceFrame["format"]): boolean {
        return (
            format.encoding === VOICE_FORMAT.encoding &&
            format.sampleRate === VOICE_FORMAT.sampleRate &&
            format.channels === VOICE_FORMAT.channels
        );
    }

    private async finishCapture(s: Session): Promise<void> {
        let failureCode: VoiceErrorCode = "capture_failed";
        try {
            await s.capture!.finish();
            if (!this.isActive(s)) return;
            s.captureDone = true;
            // Release the microphone/lease before authentication, encoding or network work.
            s.capture!.dispose();
            if (!this.isActive(s)) return;
            if (
                this.state.sampleCount < VOICE_LIMITS.minimumSamples ||
                s.energySamples < VOICE_LIMITS.minimumEnergySamples
            ) {
                this.fail(s, "no_speech");
                return;
            }
            this.clearTimers(s);
            this.deadline(
                s,
                VOICE_LIMITS.transcriptionMs,
                "transcription_timeout",
            );
            failureCode = "unauthenticated";
            const auth = await this.deps.getAuth();
            if (!this.isActive(s)) return;
            if (!auth?.credential || !auth.userId) {
                this.fail(s, "unauthenticated");
                return;
            }
            if (auth.userId !== s.userId) {
                this.terminate(s, "canceled");
                return;
            }
            failureCode = "transcription_failed";
            const result = await s.transcription!.transcribe(
                {
                    version: VOICE_VERSION,
                    sessionId: s.id,
                    format: VOICE_FORMAT,
                    pcm: s.buffer!.subarray(0, this.state.sampleCount * 2),
                    sampleCount: this.state.sampleCount,
                    options: s.options,
                },
                auth.credential,
            );
            if (!this.isActive(s)) return;
            if (
                !result ||
                result.version !== VOICE_VERSION ||
                result.sessionId !== s.id
            ) {
                this.fail(s, "protocol_error");
                return;
            }
            if ("error" in result) {
                this.fail(s, result.error.code);
                return;
            }
            if (typeof result.text !== "string") {
                this.fail(s, "protocol_error");
                return;
            }
            if (result.text.length > VOICE_LIMITS.transcriptCharacters) {
                this.fail(s, "overflow");
                return;
            }
            this.terminate(s, "completed", undefined, result.text);
        } catch {
            this.fail(s, failureCode);
        }
    }

    private fail(s: Session, code: VoiceErrorCode): void {
        if (this.isActive(s)) this.terminate(s, "error", code);
    }

    private terminate(
        s: Session,
        phase: "completed" | "canceled" | "error",
        code?: VoiceErrorCode,
        text = "",
    ): void {
        if (!this.isActive(s)) return;
        this.active = undefined;
        this.clearTimers(s);
        s.buffer?.fill(0);
        s.buffer = undefined;
        // Revocation precedes disposal: adapters may synchronously deliver their last callback.
        try {
            s.capture?.dispose();
        } catch {
            /* Still dispose the transport. */
        }
        try {
            s.transcription?.dispose();
        } catch {
            /* Terminal state is authoritative. */
        }
        this.update({
            phase,
            committedText: text,
            level: 0,
            error: code ? { code } : null,
        });
    }
}
