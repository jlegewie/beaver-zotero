import { expect, it } from "vitest";
import fixture from "../../fixtures/voice/session.json";
import { VoiceController } from "@beaver/agent-core/voice/controller";
import {
    FakeVoiceCapture,
    FakeVoiceTranscription,
} from "@beaver/agent-core/voice/fakes";
import {
    VOICE_FORMAT,
    VOICE_VERSION,
} from "@beaver/agent-core/voice/contracts";

it("replays the batch handoff fixture with a single transcript and a flushed tail", async () => {
    let capture!: FakeVoiceCapture, transcription!: FakeVoiceTranscription;
    const controller = new VoiceController({
        clock: { setTimeout: () => 0, clearTimeout: () => {} },
        getAuth: async () => ({ userId: "fixture", credential: "fake" }),
        capability: () => ({ enabled: true, available: true }),
        createId: () => fixture.sessionId,
        createCapture: (session, emit) =>
            (capture = new FakeVoiceCapture(session, emit)),
        createTranscription: (session) =>
            (transcription = new FakeVoiceTranscription(session)),
    });
    expect(fixture.version).toBe(VOICE_VERSION);
    expect(fixture.format).toEqual(VOICE_FORMAT);
    controller.start(
        { windowId: "fixture", output: { kind: "draft", id: "fixture" } },
        "fixture",
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    for (const frame of fixture.frames.slice(0, -1))
        capture.frame(frame.sampleCount);
    capture.tailSamples = fixture.frames.at(-1)!.sampleCount;
    transcription.resultText = fixture.transcript;
    expect(transcription.requestCount).toBe(0);
    expect(controller.getSnapshot().committedText).toBe("");
    controller.finish(fixture.sessionId);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transcription.requestCount).toBe(1);
    expect(transcription.sampleCount).toBe(fixture.sampleCount);
    expect(controller.getSnapshot()).toMatchObject({
        phase: "completed",
        committedText: fixture.transcript,
        frameCount: fixture.frames.length,
    });
});
