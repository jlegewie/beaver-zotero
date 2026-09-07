import { expect, it } from 'vitest';
import fixture from '../../fixtures/voice/session.json';
import { VoiceController } from '@beaver/agent-core/voice/controller';
import { FakeVoiceCapture, FakeVoiceTranscription } from '@beaver/agent-core/voice/fakes';
import { VOICE_FORMAT, VOICE_VERSION, type TranscriptEvent } from '@beaver/agent-core/voice/contracts';

it('replays the versioned handoff fixture through the controller', async () => {
    let capture!: FakeVoiceCapture, transcription!: FakeVoiceTranscription;
    const sentFrames: { sequence: number; sampleCount: number; byteLength: number }[] = [];
    const controller = new VoiceController({
        clock: { setTimeout: () => 0, clearTimeout: () => {} },
        getAuth: async () => ({ userId: 'fixture', credential: 'fake' }),
        capability: () => ({ enabled: true, available: true }), createId: () => fixture.sessionId,
        createCapture: (session, emit) => capture = new FakeVoiceCapture(session, emit),
        createTranscription: (session, emit) => transcription = new FakeVoiceTranscription(session, emit),
    });
    expect(fixture.version).toBe(VOICE_VERSION); expect(fixture.format).toEqual(VOICE_FORMAT);
    controller.start({ windowId: 'fixture', output: { kind: 'draft', id: 'fixture' } }, 'fixture');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const send = transcription.send.bind(transcription);
    transcription.send = async frame => {
        sentFrames.push({ sequence: frame.sequence, sampleCount: frame.sampleCount, byteLength: frame.pcm.byteLength });
        await send(frame);
    };
    capture.frame(fixture.frames[0].sampleCount); capture.tailSamples = fixture.frames[1].sampleCount;
    transcription.autoComplete = false;
    for (const event of fixture.transcript.slice(0, -1)) {
        transcription.emit({ version: VOICE_VERSION, sessionId: fixture.sessionId, ...event } as TranscriptEvent);
    }
    controller.finish(fixture.sessionId);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sentFrames).toEqual(fixture.frames);
    expect(transcription.endAudio).toMatchObject(fixture.endAudio);
    transcription.emit({ version: VOICE_VERSION, sessionId: fixture.sessionId, ...fixture.transcript.at(-1) } as TranscriptEvent);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'completed', committedText: fixture.committedText });
});
