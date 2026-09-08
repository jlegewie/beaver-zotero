import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceController } from "@beaver/agent-core/voice/controller";
import {
    FakeVoiceCapture,
    FakeVoiceTranscription,
} from "@beaver/agent-core/voice/fakes";
import {
    VOICE_FORMAT,
    VOICE_LIMITS,
    projectVoice,
    defaultVoiceOptions,
    type VoiceDependencies,
    type VoiceFrame,
    type VoiceRecording,
    type VoiceTranscript,
} from "@beaver/agent-core/voice/contracts";

const owner = {
    windowId: "main",
    output: { kind: "composer" as const, id: "editor" },
};
const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
function fixture(overrides: Partial<VoiceDependencies> = {}) {
    let capture!: FakeVoiceCapture;
    let transcription!: FakeVoiceTranscription;
    let id = 0;
    const deps: VoiceDependencies = {
        clock: {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (h) =>
                clearTimeout(h as ReturnType<typeof setTimeout>),
        },
        createId: () => `session-${++id}`,
        getAuth: async () => ({ userId: "user", credential: "credential" }),
        capability: () => ({ enabled: true, available: true }),
        createCapture: (session, emit) =>
            (capture = new FakeVoiceCapture(session, emit)),
        createTranscription: (session) =>
            (transcription = new FakeVoiceTranscription(session)),
        ...overrides,
    };
    const controller = new VoiceController(deps);
    return {
        controller,
        deps,
        get capture() {
            return capture;
        },
        get transcription() {
            return transcription;
        },
        async start(options = defaultVoiceOptions()) {
            controller.start(owner, "user", options);
            await settle();
            return controller.getSnapshot().sessionId!;
        },
        speech() {
            for (let i = 0; i < 3; i++) capture.frame();
        },
        frame(overrides: Partial<VoiceFrame> = {}) {
            capture.emit({
                ...capture.session,
                type: "frame",
                frame: {
                    ...capture.session,
                    sequence: controller.getSnapshot().frameCount,
                    sampleCount: 1600,
                    format: VOICE_FORMAT,
                    pcm: new Uint8Array(3200),
                    ...overrides,
                },
            });
        },
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("batch lifecycle", () => {
    it("authenticates before capture, makes no request while listening, and never exposes credentials", async () => {
        const auth = deferred<{ userId: string; credential: string }>();
        const f = fixture({ getAuth: () => auth.promise });
        f.controller.start(owner, "user");
        expect(f.capture).toBeUndefined();
        auth.resolve({ userId: "user", credential: "secret" });
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: "listening",
            captureReady: true,
            audioStarted: false,
        });
        f.speech();
        expect(f.transcription.requestCount).toBe(0);
        expect(f.controller.getSnapshot()).toMatchObject({
            audioStarted: true,
            sampleCount: 4800,
            committedText: "",
        });
        expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(
            "secret",
        );
    });
    it("flushes the tail, releases capture, and publishes one atomic result after one request", async () => {
        const f = fixture();
        const id = await f.start();
        const result = deferred<VoiceTranscript>();
        let recording!: VoiceRecording;
        let calls = 0;
        f.transcription.transcribe = async (audio) => {
            expect(f.capture.disposed).toBe(true);
            calls++;
            recording = audio;
            return result.promise;
        };
        f.speech();
        f.controller.finish(id);
        f.controller.finish(id);
        await settle();
        expect(f.capture.finishCount).toBe(1);
        expect(calls).toBe(1);
        expect(recording).toMatchObject({
            sampleCount: 5440,
            sessionId: id,
            format: VOICE_FORMAT,
        });
        expect(recording.pcm.length).toBe(10880);
        expect(recording.pcm.some((n) => n !== 0)).toBe(true);
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: "finalizing",
            committedText: "",
        });
        result.resolve({
            version: 1,
            sessionId: id,
            text: "Bourdieu’s theory.",
        });
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: "completed",
            committedText: "Bourdieu’s theory.",
        });
        expect(recording.pcm.every((n) => n === 0)).toBe(true);
        f.controller.finish(id);
        f.controller.cancel(id);
        f.controller.dispose();
        f.controller.dispose();
        expect(calls).toBe(1);
        expect(f.capture.disposeCount).toBe(1);
        expect(f.transcription.disposeCount).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        "cancel",
        "finish",
        "window",
        "logout",
        "account",
        "dispose",
        "timeout",
    ])("revokes pending authentication on %s", async (operation) => {
        const auth = deferred<{ userId: string; credential: string }>();
        const f = fixture({ getAuth: () => auth.promise });
        const id = await f.start();
        if (operation === "cancel") f.controller.cancel(id);
        if (operation === "finish") f.controller.finish(id);
        if (operation === "window") f.controller.windowUnloaded("main");
        if (operation === "logout") f.controller.authChanged(null);
        if (operation === "account") f.controller.authChanged("other");
        if (operation === "dispose") f.controller.dispose();
        if (operation === "timeout")
            vi.advanceTimersByTime(VOICE_LIMITS.startupMs);
        auth.resolve({ userId: "user", credential: "secret" });
        await settle();
        expect(f.capture).toBeUndefined();
        expect(f.transcription).toBeUndefined();
        expect(f.controller.getSnapshot().phase).toBe(
            operation === "timeout" ? "error" : "canceled",
        );
    });
    it("revokes pending capture setup before its eventual readiness callback", async () => {
        const f = fixture();
        const ready = deferred();
        const create = f.deps.createCapture;
        f.deps.createCapture = (s, emit) => {
            const c = create(s, emit);
            c.start = () => ready.promise;
            return c;
        };
        const id = await f.start();
        f.controller.finish(id);
        expect(f.capture.disposed).toBe(true);
        expect(f.transcription.disposed).toBe(true);
        f.capture.emit({
            ...f.capture.session,
            type: "ready",
            format: VOICE_FORMAT,
        });
        ready.resolve();
        await settle();
        expect(f.controller.getSnapshot().phase).toBe("canceled");
    });
    it.each(["cancel", "window", "logout", "dispose", "timeout"])(
        "clears borrowed audio and ignores late batch results after %s",
        async (operation) => {
            const f = fixture();
            const id = await f.start();
            const result = deferred<VoiceTranscript>();
            let audio!: Uint8Array;
            f.transcription.transcribe = (recording) => {
                audio = recording.pcm;
                return result.promise;
            };
            f.speech();
            f.controller.finish(id);
            await settle();
            if (operation === "cancel") f.controller.cancel(id);
            if (operation === "window") f.controller.windowUnloaded("main");
            if (operation === "logout") f.controller.authChanged(null);
            if (operation === "dispose") f.controller.dispose();
            if (operation === "timeout")
                vi.advanceTimersByTime(VOICE_LIMITS.transcriptionMs);
            expect(audio.every((n) => n === 0)).toBe(true);
            expect(f.transcription.disposed).toBe(true);
            result.resolve({ version: 1, sessionId: id, text: "stale" });
            await settle();
            expect(f.controller.getSnapshot().committedText).toBe("");
            expect(f.controller.getSnapshot().phase).toBe(
                operation === "timeout" ? "error" : "canceled",
            );
        },
    );
    it("does not let an old result overwrite a fresh session", async () => {
        const f = fixture();
        const id = await f.start();
        const result = deferred<VoiceTranscript>();
        f.transcription.transcribe = () => result.promise;
        f.speech();
        f.controller.finish(id);
        await settle();
        f.controller.cancel(id);
        const next = await f.start();
        result.resolve({ version: 1, sessionId: id, text: "stale" });
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({
            sessionId: next,
            phase: "listening",
            committedText: "",
        });
    });
    it("keeps one lock across windows and ignores stale commands and unrelated unloads", async () => {
        const f = fixture();
        const id = await f.start();
        expect(
            f.controller.start({ ...owner, windowId: "other" }, "user"),
        ).toEqual({ error: { code: "busy" } });
        f.controller.windowUnloaded("other");
        f.controller.authChanged("user");
        expect(f.controller.getSnapshot().phase).toBe("listening");
        f.controller.windowUnloaded("main");
        await f.start();
        f.controller.cancel(id);
        f.controller.finish(id);
        expect(f.controller.getSnapshot().phase).toBe("listening");
    });
    it("bounds capture shutdown separately from transcription", async () => {
        const f = fixture();
        const id = await f.start();
        const stopped = deferred();
        f.capture.finish = () => stopped.promise;
        f.controller.finish(id);
        vi.advanceTimersByTime(VOICE_LIMITS.finalizationMs);
        stopped.resolve();
        await settle();
        expect(f.transcription.requestCount).toBe(0);
        expect(f.controller.getSnapshot().error?.code).toBe(
            "finalization_timeout",
        );
    });
    it("keeps the transcription deadline after the native deadline has elapsed", async () => {
        const f = fixture();
        const id = await f.start();
        f.speech();
        f.transcription.transcribe = () => new Promise(() => {});
        f.controller.finish(id);
        await settle();
        vi.advanceTimersByTime(VOICE_LIMITS.finalizationMs);
        expect(f.controller.getSnapshot().phase).toBe("finalizing");
        vi.advanceTimersByTime(
            VOICE_LIMITS.transcriptionMs - VOICE_LIMITS.finalizationMs,
        );
        expect(f.controller.getSnapshot().error?.code).toBe(
            "transcription_timeout",
        );
    });
    it("bounds listening by wall time independently of audio flow", async () => {
        const f = fixture();
        await f.start();
        vi.advanceTimersByTime(VOICE_LIMITS.durationMs);
        expect(f.controller.getSnapshot().error?.code).toBe("duration_limit");
        expect(vi.getTimerCount()).toBe(0);
    });
    it("continues cleanup when observers or a capture disposal throw", async () => {
        const f = fixture();
        await f.start();
        f.controller.subscribe(() => {
            throw new Error("view");
        });
        f.capture.dispose = () => {
            throw new Error("device");
        };
        f.controller.authChanged(null);
        expect(f.transcription.disposed).toBe(true);
        expect(f.controller.getSnapshot().phase).toBe("canceled");
    });
    it("allocates no adapters when an observer cancels starting synchronously", async () => {
        const f = fixture();
        f.controller.subscribe(() => {
            if (f.controller.getSnapshot().phase === "starting")
                f.controller.windowUnloaded("main");
        });
        await f.start();
        expect(f.capture).toBeUndefined();
        expect(f.transcription).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        [false, true, "disabled"],
        [true, false, "unavailable"],
    ] as const)("gates activation %#", (enabled, available, code) => {
        const f = fixture({ capability: () => ({ enabled, available }) });
        expect(f.controller.start(owner, "user")).toEqual({ error: { code } });
    });
    it("rejects missing auth and a disposed controller", async () => {
        const f = fixture({ getAuth: async () => null });
        await f.start();
        expect(f.controller.getSnapshot().error?.code).toBe("unauthenticated");
        expect(f.capture).toBeUndefined();
        f.controller.dispose();
        expect(f.controller.start(owner, "user")).toEqual({
            error: { code: "disabled" },
        });
    });
});

describe("audio bounds and energy gate", () => {
    it("accepts exactly the sample limit including a short tail and rejects an extra sample", async () => {
        const f = fixture();
        const id = await f.start();
        for (let i = 0; i < 1199; i++) f.capture.frame();
        f.capture.tailSamples = 1600;
        f.controller.finish(id);
        await settle();
        expect(f.transcription.sampleCount).toBe(1920000);
        expect(f.controller.getSnapshot().phase).toBe("completed");
        await f.start();
        for (let i = 0; i < 1200; i++) f.capture.frame();
        f.capture.frame();
        expect(f.controller.getSnapshot().error?.code).toBe("duration_limit");
        expect(f.transcription.requestCount).toBe(0);
    });
    it("copies incoming PCM before reuse and computes RMS", async () => {
        const f = fixture();
        const id = await f.start();
        const pcm = new Uint8Array(3200);
        for (let i = 1; i < pcm.length; i += 2) pcm[i] = 64;
        f.frame({ pcm });
        pcm.fill(0);
        expect(f.controller.getSnapshot().level).toBe(0.5);
        f.capture.sequence = 1;
        f.capture.frame();
        f.capture.frame();
        let firstSample = 0;
        f.transcription.transcribe = async (recording) => {
            firstSample = recording.pcm[1];
            return { ...f.transcription.session, text: "ok" };
        };
        f.controller.finish(id);
        await settle();
        expect(firstSample).toBe(64);
    });
    it.each([
        { sequence: 1 },
        { sequence: -1 },
        { sampleCount: 1601 },
        { sampleCount: 0 },
        { sampleCount: 640, pcm: new Uint8Array(1280) },
        { pcm: new Uint8Array(3) },
        { version: 2 },
        { sessionId: "wrong" },
        { format: { ...VOICE_FORMAT, sampleRate: 48000 } },
    ])("rejects malformed native frames %#", async (patch) => {
        const f = fixture();
        await f.start();
        f.frame(patch as Partial<VoiceFrame>);
        expect(f.controller.getSnapshot().error?.code).toBe("protocol_error");
    });
    it("rejects frames after a short tail", async () => {
        const f = fixture();
        const id = await f.start();
        f.capture.finish = async () => {
            f.capture.frame(640);
            f.capture.frame();
        };
        f.controller.finish(id);
        await settle();
        expect(f.controller.getSnapshot().error?.code).toBe("protocol_error");
    });
    it.each(["empty", "short", "muted", "near-silent", "click"])(
        "does not transcribe %s input",
        async (kind) => {
            const f = fixture();
            const id = await f.start();
            f.capture.tailSamples = 0;
            if (kind === "short") f.capture.frame();
            if (kind === "muted" || kind === "near-silent")
                for (let i = 0; i < 100; i++)
                    f.capture.frame(1600, kind === "muted" ? 0 : 0.002);
            if (kind === "click") {
                f.capture.frame();
                for (let i = 0; i < 10; i++) f.capture.frame(1600, 0);
            }
            expect(f.controller.getSnapshot().error).toBeNull();
            f.controller.finish(id);
            await settle();
            expect(f.controller.getSnapshot()).toMatchObject({
                phase: "error",
                error: { code: "no_speech" },
                committedText: "",
            });
            expect(f.transcription.requestCount).toBe(0);
        },
    );
    it("includes final-tail energy in the gate", async () => {
        const f = fixture();
        const id = await f.start();
        f.capture.frame();
        f.capture.frame(1600, 0);
        f.capture.frame(1600, 0);
        f.capture.tailSamples = 1600;
        f.controller.finish(id);
        await settle();
        expect(f.controller.getSnapshot().phase).toBe("completed");
        expect(f.transcription.requestCount).toBe(1);
    });
});

describe("batch context, results and quality", () => {
    it("snapshots vocabulary and language and refreshes credentials only for the same user", async () => {
        const f = fixture();
        const options = {
            language: "fr",
            biasTerms: ["Bourdieu"],
            correctionVocabulary: ["Actes de la recherche"],
        };
        const id = await f.start(options);
        options.biasTerms[0] = "changed";
        options.language = "en";
        f.deps.getAuth = async () => ({
            userId: "user",
            credential: "refreshed",
        });
        let recorded!: VoiceRecording;
        f.transcription.transcribe = async (recording, credential) => {
            expect(credential).toBe("refreshed");
            recorded = recording;
            return { ...f.transcription.session, text: "ok" };
        };
        f.speech();
        f.controller.finish(id);
        await settle();
        expect(recorded.options).toEqual({
            language: "fr",
            biasTerms: ["Bourdieu"],
            correctionVocabulary: ["Actes de la recherche"],
        });
        expect(Object.isFrozen(recorded.options.biasTerms)).toBe(true);
    });
    it.each(["logout", "replacement", "pending-cancel"])(
        "prevents upload after auth %s",
        async (kind) => {
            const f = fixture();
            const id = await f.start();
            f.speech();
            f.deps.getAuth =
                kind === "pending-cancel"
                    ? () => new Promise(() => {})
                    : async () =>
                          kind === "logout"
                              ? null
                              : { userId: "other", credential: "new" };
            f.controller.finish(id);
            await settle();
            if (kind === "pending-cancel") f.controller.cancel(id);
            expect(f.transcription.requestCount).toBe(0);
            expect(f.controller.getSnapshot().phase).not.toBe("completed");
        },
    );
    it.each([
        { language: "" },
        { biasTerms: ["x".repeat(32001)] },
        { correctionVocabulary: Array(1001).fill("x") },
    ])("rejects invalid or unbounded context %#", async (patch) => {
        const f = fixture();
        expect(
            f.controller.start(owner, "user", {
                ...defaultVoiceOptions(),
                ...patch,
            }),
        ).toEqual({ error: { code: "protocol_error" } });
    });
    it.each([
        [{ version: 2, text: "bad" }, "protocol_error"],
        [{ sessionId: "wrong", text: "bad" }, "protocol_error"],
        [{ text: 42 }, "protocol_error"],
        [{ text: "x".repeat(64001) }, "overflow"],
        [{ error: { code: "transcription_failed" } }, "transcription_failed"],
    ])("rejects invalid or failed batch result %#", async (patch, code) => {
        const f = fixture();
        const id = await f.start();
        f.transcription.transcribe = async () =>
            ({ ...f.transcription.session, ...patch }) as VoiceTranscript;
        f.speech();
        f.controller.finish(id);
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: "error",
            committedText: "",
            error: { code },
        });
    });
    it("accepts an empty successful transcript without inventing text", async () => {
        const f = fixture();
        const id = await f.start();
        f.speech();
        f.controller.finish(id);
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({
            phase: "completed",
            committedText: "",
        });
    });
    it("exposes immutable clipping diagnostics and retains counts on failure", async () => {
        const f = fixture();
        await f.start();
        const quality = {
            inputPeak: 1,
            clippedSamples: 32,
            discontinuityCount: 1,
        };
        f.capture.emit({ ...f.capture.session, type: "quality", quality });
        quality.clippedSamples = 999;
        f.capture.emit({
            ...f.capture.session,
            type: "error",
            error: { code: "discontinuity" },
        });
        expect(f.controller.getSnapshot()).toMatchObject({
            clipping: true,
            quality: { clippedSamples: 32, discontinuityCount: 1 },
            error: { code: "discontinuity" },
        });
        expect(Object.isFrozen(f.controller.getSnapshot().quality)).toBe(true);
    });
    it.each([
        { inputPeak: NaN },
        { clippedSamples: -1 },
        { discontinuityCount: 0.5 },
    ])("rejects malformed quality %#", async (patch) => {
        const f = fixture();
        await f.start();
        f.capture.emit({
            ...f.capture.session,
            type: "quality",
            quality: {
                inputPeak: 0,
                clippedSamples: 0,
                discontinuityCount: 0,
                ...patch,
            },
        });
        expect(f.controller.getSnapshot().error?.code).toBe("protocol_error");
    });
    it("keeps output ownership immutable and observations shared", async () => {
        const f = fixture();
        const mutable = { ...owner, output: { ...owner.output } };
        f.controller.start(mutable, "user");
        mutable.output.id = "other";
        await settle();
        expect(projectVoice(f.controller.getSnapshot(), owner)).toMatchObject({
            ownsOutput: true,
            busy: true,
        });
        expect(
            projectVoice(f.controller.getSnapshot(), {
                ...owner,
                windowId: "other",
            }),
        ).toMatchObject({ ownsOutput: false, busy: true });
        let count = 0;
        const off = f.controller.subscribe(() => count++);
        off();
        f.capture.frame();
        expect(count).toBe(0);
    });
    it.each([
        "auth",
        "transcription_factory",
        "capture_factory",
        "capture_start",
        "transcribe",
    ])(
        "classifies %s failures without exposing private messages",
        async (stage) => {
            const f = fixture();
            const fail = () => {
                throw new Error("private details");
            };
            if (stage === "auth") f.deps.getAuth = fail;
            if (stage === "transcription_factory")
                f.deps.createTranscription = fail;
            if (stage === "capture_factory") f.deps.createCapture = fail;
            if (stage === "capture_start") {
                const create = f.deps.createCapture;
                f.deps.createCapture = (s, emit) => {
                    const c = create(s, emit);
                    c.start = fail;
                    return c;
                };
            }
            const id = await f.start();
            if (stage === "transcribe") {
                f.transcription.transcribe = fail;
                f.speech();
                f.controller.finish(id);
                await settle();
            }
            expect(f.controller.getSnapshot().error?.code).toBe(
                stage === "auth"
                    ? "unauthenticated"
                    : stage.startsWith("capture")
                      ? "capture_failed"
                      : "transcription_failed",
            );
            expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(
                "private details",
            );
            if (f.capture) expect(f.capture.disposed).toBe(true);
            if (f.transcription) expect(f.transcription.disposed).toBe(true);
        },
    );
    it("keeps pending activation when another window reports the same account", async () => {
        const auth = deferred<{ userId: string; credential: string }>();
        const f = fixture({ getAuth: () => auth.promise });
        await f.start();
        f.controller.authChanged("user");
        expect(f.controller.getSnapshot().phase).toBe("starting");
        auth.resolve({ userId: "other", credential: "credential" });
        await settle();
        expect(f.controller.getSnapshot().phase).toBe("canceled");
        expect(f.capture).toBeUndefined();
    });
});
