import { FakeVoiceCapture, FakeVoiceTranscription } from '@beaver/agent-core/voice/fakes';
import { VOICE_LIMITS, type VoiceAuth, type VoiceClock } from '@beaver/agent-core/voice/contracts';
import { createVoiceService, type VoiceService, type VoiceWindow } from './voiceService';

export interface VoiceHarnessRequest {
    command: string;
    text?: string;
    segmentId?: number;
    enabled?: boolean;
}

/** Synthetic adapters owned by the plugin realm; constructed only in development builds. */
export class DevelopmentVoiceHarness {
    readonly service: VoiceService;
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

    constructor(clock?: VoiceClock) {
        this.service = createVoiceService({
            capability: () => ({ enabled: this.enabled, available: true }),
            createCapture: (session, emit) => this.capture = new FakeVoiceCapture(session, emit),
            createTranscription: (session, emit) => this.transcription = new FakeVoiceTranscription(session, emit),
        }, clock);
    }

    start(expectedUserId: string, getAuth: () => Promise<VoiceAuth | null>) {
        return this.service.start(this.owner, { kind: 'draft', id: 'fake-voice-draft' }, getAuth, expectedUserId);
    }

    /** Never accepts PCM, credentials, or a provider URL. */
    run(request: VoiceHarnessRequest) {
        const { sessionId } = this.service.controller.getSnapshot();
        const capture = this.capture?.session.sessionId === sessionId ? this.capture : undefined;
        const transcription = this.transcription?.session.sessionId === sessionId ? this.transcription : undefined;
        switch (request.command) {
            case 'enable':
                this.enabled = request.enabled === true;
                if (!this.enabled && sessionId) this.service.controller.cancel(sessionId);
                break;
            case 'frame': capture?.frame(); break;
            case 'interim':
            case 'segment_final':
                if (typeof request.text !== 'string' || request.text.length > VOICE_LIMITS.transcriptCharacters
                    || !Number.isSafeInteger(request.segmentId) || request.segmentId! < 0) {
                    throw new Error('Invalid synthetic transcript');
                }
                transcription?.text(request.command, request.segmentId!, request.text);
                break;
            case 'finish': if (sessionId) this.service.controller.finish(sessionId); break;
            case 'cancel': if (sessionId) this.service.controller.cancel(sessionId); break;
            case 'state': break;
            default: throw new Error('Unknown voice harness command');
        }
        return { state: this.service.controller.getSnapshot(), resources: {
            captureDisposeCount: capture?.disposeCount ?? 0,
            transcriptionDisposeCount: transcription?.disposeCount ?? 0,
            sentFrames: transcription?.sendCount ?? 0,
            endAudio: transcription?.endAudio ?? null,
        } };
    }
}
