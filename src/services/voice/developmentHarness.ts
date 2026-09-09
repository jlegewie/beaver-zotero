import {
    FakeVoiceCapture,
    FakeVoiceTranscription,
} from "@beaver/agent-core/voice/fakes";
import {
    VOICE_LIMITS,
    isBusyPhase,
    type VoiceAuth,
    type VoiceClock,
} from "@beaver/agent-core/voice/contracts";
import {
    NativeCaptureHarness,
    type NativeCaptureHost,
} from "./nativeCaptureHarness";
import {
    createVoiceService,
    type VoiceService,
    type VoiceAdapters,
    type VoiceWindow,
} from "./voiceService";

export interface VoiceHarnessRequest {
    command: string;
    text?: string;
    enabled?: boolean;
}

/** Synthetic adapters owned by the plugin realm; constructed only in development builds. */
export class DevelopmentVoiceHarness {
    readonly service: VoiceService;
    private readonly nativeHarness?: NativeCaptureHarness;
    // Synthetic ownership keeps HTTP-driven tests independent of desktop focus.
    private readonly owner: VoiceWindow = {
        closed: false,
        document: { hasFocus: () => true },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    private enabled = false;
    private capture?: FakeVoiceCapture;
    private transcription?: FakeVoiceTranscription;

    constructor(
        clock?: VoiceClock,
        native?: NativeCaptureHost,
        product?: VoiceAdapters,
    ) {
        this.service = createVoiceService(
            {
                capability: () => ({
                    enabled:
                        this.enabled ||
                        this.nativeHarness?.activating === true ||
                        !!product?.capability().enabled,
                    available:
                        this.enabled ||
                        this.nativeHarness?.activating === true ||
                        !!product?.capability().available,
                }),
                createCapture: (session, emit) =>
                    this.nativeHarness?.ownsSession(session.sessionId)
                        ? this.nativeHarness.createCapture(session, emit)
                        : this.enabled || !product
                          ? (this.capture = new FakeVoiceCapture(session, emit))
                          : product.createCapture(session, emit),
                createTranscription: (session) =>
                    this.enabled ||
                    this.nativeHarness?.ownsSession(session.sessionId) ||
                    !product
                        ? (this.transcription = new FakeVoiceTranscription(
                              session,
                          ))
                        : product.createTranscription(session),
            },
            clock,
        );
        if (native)
            this.nativeHarness = new NativeCaptureHarness(this.service, native);
    }

    start(expectedUserId: string, getAuth: () => Promise<VoiceAuth | null>) {
        if (
            this.service.preparing ||
            isBusyPhase(this.service.controller.getSnapshot().phase)
        )
            return { error: { code: "busy" as const } };
        if (!this.enabled) return { error: { code: "disabled" as const } };
        if (this.nativeHarness?.preparingPermission)
            return { error: { code: "busy" as const } };
        return this.service.start(
            this.owner,
            { kind: "draft", id: "fake-voice-draft" },
            getAuth,
            expectedUserId,
        );
    }

    /** Explicit local invocation; no HTTP command can activate the microphone. */
    async startNative(win: Window, retainAudio = false) {
        if (!this.nativeHarness)
            throw new Error("Configure the development helper first");
        return this.nativeHarness.start(win, retainAudio);
    }

    nativeState() {
        return this.nativeHarness?.getState();
    }

    async saveRecording(path: string) {
        if (!this.nativeHarness)
            throw new Error("No completed opt-in recording");
        await this.nativeHarness.saveRecording(path);
    }

    /** Never accepts PCM, credentials, or a provider URL. */
    run(request: VoiceHarnessRequest) {
        const { sessionId } = this.service.controller.getSnapshot();
        const capture =
            this.capture?.session.sessionId === sessionId
                ? this.capture
                : undefined;
        const transcription =
            this.transcription?.session.sessionId === sessionId
                ? this.transcription
                : undefined;
        switch (request.command) {
            case "enable":
                this.enabled = request.enabled === true;
                if (!this.enabled && sessionId)
                    this.service.controller.cancel(sessionId);
                break;
            case "frame":
                capture?.frame();
                break;
            case "transcript":
                if (
                    typeof request.text !== "string" ||
                    request.text.length > VOICE_LIMITS.transcriptCharacters
                ) {
                    throw new Error("Invalid synthetic transcript");
                }
                if (transcription) transcription.resultText = request.text;
                break;
            case "finish":
                if (sessionId) this.service.controller.finish(sessionId);
                break;
            case "cancel":
                if (sessionId) this.service.controller.cancel(sessionId);
                break;
            case "state":
                break;
            default:
                throw new Error("Unknown voice harness command");
        }
        return {
            state: this.service.controller.getSnapshot(),
            resources: {
                captureDisposeCount: capture?.disposeCount ?? 0,
                transcriptionDisposeCount: transcription?.disposeCount ?? 0,
                requestCount: transcription?.requestCount ?? 0,
                transcribedSamples: transcription?.sampleCount ?? 0,
            },
        };
    }
}
