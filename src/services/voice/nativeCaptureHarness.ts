import {
    isBusyPhase,
    VOICE_FORMAT,
    VOICE_LIMITS,
    type CaptureEvent,
    type VoiceEnvelope,
} from "@beaver/agent-core/voice/contracts";
import { microphoneHelp, type NativeVoice } from "./nativeVoice";
import type { VoiceService } from "./voiceService";

function recordingFormat() {
    const bytesPerSample = { pcm_s16le: 2 }[VOICE_FORMAT.encoding];
    const blockAlign = VOICE_FORMAT.channels * bytesPerSample;
    const byteRate = VOICE_FORMAT.sampleRate * blockAlign;
    return {
        blockAlign,
        byteRate,
        bitsPerSample: bytesPerSample * 8,
        retentionLimit: byteRate * (VOICE_LIMITS.durationMs / 1000),
    };
}

export type NativeCaptureHost = Pick<
    NativeVoice,
    | "available"
    | "permission"
    | "prepareMicrophone"
    | "explain"
    | "createCapture"
>;

interface CaptureMetrics {
    startedAt: number;
    readyMs?: number;
    firstFrameMs?: number;
    lastFrameSamples?: number;
    stopMs?: number;
}

/** Native test capture shares the application's controller and ownership rules. */
export class NativeCaptureHarness {
    private admitting = false;
    private settingUp = false;
    private sessionId?: string;
    private retained?: Uint8Array[];
    private retainedBytes = 0;
    private metrics?: CaptureMetrics;

    constructor(
        private readonly service: VoiceService,
        private readonly native: NativeCaptureHost,
    ) {}

    get activating() {
        return this.admitting;
    }
    get preparingPermission() {
        return this.settingUp;
    }
    ownsSession(sessionId: string) {
        return this.sessionId === sessionId;
    }

    async start(win: Window, retainAudio = false) {
        if (!this.native.available)
            throw new Error("Configure the development helper first");
        // Guard before setup or changing the recording buffers of an existing session.
        if (
            this.settingUp ||
            isBusyPhase(this.service.controller.getSnapshot().phase)
        )
            return { error: { code: "busy" as const } };
        if (
            this.native.permission === "unknown" ||
            this.native.permission === "not_determined"
        ) {
            this.settingUp = true;
            try {
                const permission = await this.native.prepareMicrophone(win);
                if (permission === "unknown")
                    return { error: { code: "unavailable" as const } };
                return {
                    setup: true,
                    permission,
                    help:
                        permission === "granted"
                            ? "Microphone permission is ready. Start again to record."
                            : microphoneHelp("permission_denied"),
                };
            } catch {
                return {
                    error: { code: "unavailable" as const },
                    help: microphoneHelp("unavailable"),
                };
            } finally {
                this.settingUp = false;
            }
        }
        if (!this.native.explain(win))
            return { error: { code: "unavailable" as const } };
        // Capability is checked synchronously; admission never enables later synthetic starts.
        this.admitting = true;
        try {
            const result = this.service.start(
                win,
                { kind: "draft", id: "native-capture-test" },
                async () => ({
                    userId: "local-capture-test",
                    credential: "fake-only",
                }),
                "local-capture-test",
            );
            if ("sessionId" in result) {
                this.sessionId = result.sessionId;
                this.retained = retainAudio ? [] : undefined;
                this.retainedBytes = 0;
                this.metrics = { startedAt: Cu.now() };
            }
            return result;
        } finally {
            this.admitting = false;
        }
    }

    getState() {
        const state = this.service.controller.getSnapshot();
        return {
            state,
            permission: this.native.permission,
            metrics: { ...this.metrics },
            help: state.error
                ? microphoneHelp(state.error.code)
                : state.clipping
                  ? "Your microphone is clipping. Lower the microphone input level or move farther away."
                  : null,
            retainedBytes: this.retainedBytes,
        };
    }

    createCapture(session: VoiceEnvelope, emit: (event: CaptureEvent) => void) {
        const metrics = this.metrics!;
        const { retentionLimit } = recordingFormat();
        const capture = this.native.createCapture(session, (event) => {
            const elapsed = Cu.now() - metrics.startedAt;
            if (event.type === "ready") metrics.readyMs = elapsed;
            if (event.type === "frame") {
                if (metrics.firstFrameMs === undefined)
                    metrics.firstFrameMs = elapsed;
                metrics.lastFrameSamples = event.frame.sampleCount;
                if (
                    this.retained &&
                    this.retainedBytes + event.frame.pcm.length <=
                        retentionLimit
                ) {
                    this.retained.push(new Uint8Array(event.frame.pcm));
                    this.retainedBytes += event.frame.pcm.length;
                }
            }
            emit(event);
        });
        return {
            start: () => capture.start(),
            dispose: () => capture.dispose(),
            finish: async () => {
                const at = Cu.now();
                await capture.finish();
                metrics.stopMs = Cu.now() - at;
            },
        };
    }

    /** Opt-in, bounded local recording for listening checks; no upload or default persistence. */
    async saveRecording(path: string) {
        if (
            !this.retained ||
            isBusyPhase(this.service.controller.getSnapshot().phase)
        )
            throw new Error("No completed opt-in recording");
        const retained = this.retained;
        const { blockAlign, byteRate, bitsPerSample } = recordingFormat();
        const wav = new Uint8Array(44 + this.retainedBytes);
        const view = new DataView(wav.buffer);
        const text = (at: number, value: string) => {
            for (let i = 0; i < value.length; i++)
                wav[at + i] = value.charCodeAt(i);
        };
        text(0, "RIFF");
        view.setUint32(4, wav.length - 8, true);
        text(8, "WAVEfmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, VOICE_FORMAT.channels, true);
        view.setUint32(24, VOICE_FORMAT.sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        text(36, "data");
        view.setUint32(40, this.retainedBytes, true);
        let offset = 44;
        for (const pcm of retained) {
            wav.set(pcm, offset);
            offset += pcm.length;
        }
        await IOUtils.write(path, wav);
        if (this.retained === retained) {
            this.retained = undefined;
            this.retainedBytes = 0;
        }
    }
}
