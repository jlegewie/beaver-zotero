import { v4 as uuidv4 } from "uuid";
vi.mock("uuid", async (importOriginal) => {
    const actual = await importOriginal<typeof import("uuid")>();
    return { ...actual, v4: vi.fn(actual.v4) };
});
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { VoiceService } from "../../../src/services/voice/voiceService";
import {
    DevelopmentVoiceHarness,
    type VoiceHarnessRequest,
} from "../../../src/services/voice/developmentHarness";
import {
    VOICE_LIMITS,
    type VoiceClock,
} from "@beaver/agent-core/voice/contracts";

const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
const auth = async () => ({ userId: "user", credential: "fake" });
const output = { kind: "draft" as const, id: "draft" };
function hostWindow() {
    const events = new Map<string, Set<(event: { target: unknown }) => void>>();
    const win = {
        closed: false,
        document: { hasFocus: () => true },
        addEventListener(
            type: string,
            listener: (event: { target: unknown }) => void,
        ) {
            if (!events.has(type)) events.set(type, new Set());
            events.get(type)!.add(listener);
        },
        removeEventListener(
            type: string,
            listener: (event: { target: unknown }) => void,
        ) {
            events.get(type)?.delete(listener);
        },
        dispatch(type: string, target?: unknown): void {
            for (const listener of events.get(type) ?? [])
                listener({ target: target ?? win });
        },
        listenerCount() {
            return [...events.values()].reduce((n, set) => n + set.size, 0);
        },
    };
    return win;
}
const clock: VoiceClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const createHarness = () => new DevelopmentVoiceHarness(clock);

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    let id = 0;
    (Zotero.Utilities as any).randomString = () => `voice-${++id}`;
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("plugin voice ownership", () => {
    it("requires explicit development enablement and never enables production", async () => {
        const win = hostWindow();
        const harness = createHarness();
        const service = harness.service;
        expect(
            service.start(win as unknown as Window, output, auth, "user"),
        ).toEqual({ error: { code: "disabled" } });
        expect(win.listenerCount()).toBe(0);
        const production = new VoiceService(clock);
        expect(
            production.start(win as unknown as Window, output, auth, "user"),
        ).toEqual({ error: { code: "disabled" } });
        expect(win.listenerCount()).toBe(0);
    });

    it.each(["unload", "blur", "logout", "shutdown", "disable"])(
        "releases resources and window closures on %s",
        async (event) => {
            const win = hostWindow();
            const harness = createHarness();
            const service = harness.service;
            harness.run({ command: "enable", enabled: true });
            service.start(win as unknown as Window, output, auth, "user");
            await settle();
            expect(win.listenerCount()).toBe(2);
            if (event === "unload" || event === "blur") win.dispatch(event);
            if (event === "logout") service.authChanged(null);
            if (event === "shutdown") service.dispose();
            if (event === "disable")
                harness.run({ command: "enable", enabled: false });
            expect(service.controller.getSnapshot().phase).toBe("canceled");
            expect(harness.run({ command: "state" }).resources).toMatchObject({
                captureDisposeCount: 1,
                transcriptionDisposeCount: 1,
            });
            expect(win.listenerCount()).toBe(0);
        },
    );

    it("ignores internal focus changes and rejects another window without replacing ownership", async () => {
        const win = hostWindow(),
            other = hostWindow();
        const harness = createHarness();
        const service = harness.service;
        harness.run({ command: "enable", enabled: true });
        service.start(win as unknown as Window, output, auth, "user");
        await settle();
        other.document.hasFocus = () => false;
        win.dispatch("blur", {});
        expect(service.controller.getSnapshot().phase).toBe("listening");
        expect(
            service.start(other as unknown as Window, output, auth, "user"),
        ).toEqual({ error: { code: "busy" } });
        expect(other.listenerCount()).toBe(0);
        service.windowUnloaded(other as unknown as Window);
        expect(service.controller.getSnapshot().phase).toBe("listening");
        service.windowUnloaded(win as unknown as Window);
        other.document.hasFocus = () => true;
        service.start(other as unknown as Window, output, auth, "user");
        await settle();
        expect(service.controller.getSnapshot().owner?.windowId).toBe(
            service.windowId(other as unknown as Window),
        );
    });

    it("flushes and completes a synthetic session with no audio persistence or sends", async () => {
        const win = hostWindow();
        const harness = createHarness();
        const service = harness.service;
        harness.run({ command: "enable", enabled: true });
        service.start(win as unknown as Window, output, auth, "user");
        await settle();
        for (let i = 0; i < 3; i++) harness.run({ command: "frame" });
        harness.run({ command: "transcript", text: "Hello" });
        harness.run({ command: "finish" });
        await settle();
        const result = harness.run({ command: "state" });
        expect(result.state).toMatchObject({
            phase: "completed",
            committedText: "Hello",
            sampleCount: 5440,
        });
        expect(result.resources).toMatchObject({
            requestCount: 1,
            captureDisposeCount: 1,
            transcriptionDisposeCount: 1,
        });
        expect(win.listenerCount()).toBe(0);
    });
});

it("starts diagnostics afresh while the next session waits for auth", async () => {
    const win = hostWindow();
    const harness = createHarness();
    const service = harness.service;
    harness.run({ command: "enable", enabled: true });
    service.start(win as unknown as Window, output, auth, "user");
    await settle();
    for (let i = 0; i < 3; i++) harness.run({ command: "frame" });
    harness.run({ command: "finish" });
    await settle();
    expect(harness.run({ command: "state" }).resources.requestCount).toBe(1);
    service.start(
        win as unknown as Window,
        output,
        () => new Promise(() => {}),
        "user",
    );
    const pending = harness.run({ command: "state" });
    expect(pending.state.phase).toBe("starting");
    expect(pending.resources).toEqual({
        captureDisposeCount: 0,
        transcriptionDisposeCount: 0,
        requestCount: 0,
        transcribedSamples: 0,
    });
    service.dispose();
});

it("rejects closed or absent windows before registering listeners", () => {
    const harness = createHarness();
    const service = harness.service;
    const win = hostWindow();
    win.closed = true;
    harness.run({ command: "enable", enabled: true });
    for (const value of [win, null, undefined]) {
        expect(
            service.start(
                value as Window | null | undefined,
                output,
                auth,
                "user",
            ),
        ).toEqual({ error: { code: "unavailable" } });
    }
    expect(win.listenerCount()).toBe(0);
});

it.each([
    { command: "unknown" },
    { command: "transcript", text: 5 },
    {
        command: "transcript",
        text: "x".repeat(VOICE_LIMITS.transcriptCharacters + 1),
    },
    { command: "transcript" },
    { command: "interim", text: "unsupported" },
])("rejects invalid harness input %#", (request) => {
    const harness = createHarness();
    expect(() => harness.run(request as VoiceHarnessRequest)).toThrow();
});

it("does not allocate identities for unrelated unloading windows", () => {
    const service = new VoiceService(clock);
    service.windowUnloaded(hostWindow() as unknown as Window);
    expect(service.windowId(hostWindow() as unknown as Window)).toBe(
        "voice-window-1",
    );
});

it.each(["starting", "finalizing"])(
    "preserves owner listeners on a rejected start while %s",
    async (phase) => {
        const harness = createHarness();
        const service = harness.service;
        const owner = hostWindow(),
            other = hostWindow();
        harness.run({ command: "enable", enabled: true });
        service.start(
            owner as unknown as Window,
            output,
            phase === "starting" ? () => new Promise(() => {}) : auth,
            "user",
        );
        if (phase === "finalizing") {
            await settle();
            harness.run({ command: "finish" });
        }
        expect(service.controller.getSnapshot().phase).toBe(phase);
        expect(
            service.start(other as unknown as Window, output, auth, "user"),
        ).toEqual({ error: { code: "busy" } });
        expect(owner.listenerCount()).toBe(2);
        expect(other.listenerCount()).toBe(0);
        owner.dispatch("unload");
        expect(service.controller.getSnapshot().phase).toBe("canceled");
        expect(owner.listenerCount()).toBe(0);
    },
);

it("rejects activation from an unfocused window", () => {
    const harness = createHarness(),
        win = hostWindow();
    win.document.hasFocus = () => false;
    harness.run({ command: "enable", enabled: true });
    expect(
        harness.service.start(win as unknown as Window, output, auth, "user"),
    ).toEqual({ error: { code: "unavailable" } });
    expect(win.listenerCount()).toBe(0);
});

it("requires fresh activation after focus loss during setup, even if permission later resolves", async () => {
    const harness = createHarness(),
        win = hostWindow();
    let resolveAuth!: (auth: { userId: string; credential: string }) => void;
    const pending = new Promise<{ userId: string; credential: string }>(
        (resolve) => {
            resolveAuth = resolve;
        },
    );
    harness.run({ command: "enable", enabled: true });
    harness.service.start(
        win as unknown as Window,
        output,
        () => pending,
        "user",
    );
    harness.service.authChanged("user");
    expect(harness.service.controller.getSnapshot().phase).toBe("starting");
    win.dispatch("blur");
    resolveAuth({ userId: "user", credential: "fake" });
    await settle();
    expect(harness.service.controller.getSnapshot().phase).toBe("canceled");
    expect(harness.run({ command: "state" }).resources.requestCount).toBe(0);
    expect(win.listenerCount()).toBe(0);
});

it("runs synthetic sessions without consulting the desktop window", async () => {
    const harness = createHarness();
    const mainWindow = vi
        .spyOn(Zotero, "getMainWindow")
        .mockImplementation(() => {
            throw new Error("No desktop window");
        });
    try {
        harness.run({ command: "enable", enabled: true });
        expect(harness.start("user", auth)).toHaveProperty("sessionId");
        await settle();
        expect(harness.service.controller.getSnapshot().phase).toBe(
            "listening",
        );
        harness.run({ command: "cancel" });
        expect(harness.run({ command: "state" }).resources).toMatchObject({
            captureDisposeCount: 1,
            transcriptionDisposeCount: 1,
        });
        expect(mainWindow).not.toHaveBeenCalled();
    } finally {
        mainWindow.mockRestore();
    }
});

it("releases owner listeners if allocating a session fails synchronously", () => {
    const harness = createHarness(),
        win = hostWindow();
    harness.run({ command: "enable", enabled: true });
    vi.mocked(uuidv4).mockImplementationOnce(() => {
        throw new Error("Allocation failed");
    });
    expect(() =>
        harness.service.start(win as unknown as Window, output, auth, "user"),
    ).toThrow("Allocation failed");
    expect(win.listenerCount()).toBe(0);
    expect(harness.service.controller.getSnapshot().phase).toBe("idle");
});

it("exports bounded content-free diagnostics and unique output identities", async () => {
    const h = createHarness();
    h.run({ command: "enable", enabled: true });
    expect(h.service.createOutputId()).not.toBe(h.service.createOutputId());
    h.start("user", auth);
    await settle();
    h.run({ command: "frame" });
    h.run({ command: "frame" });
    h.run({ command: "frame" });
    h.run({ command: "transcript", text: "Private dictation" });
    h.run({ command: "finish" });
    await settle();
    const diagnostics = h.service.diagnostics();
    expect(diagnostics.phase).toBe("completed");
    expect(diagnostics.capturedMs).toBe(340);
    expect(JSON.stringify(diagnostics)).not.toMatch(
        /Private|credential|pcm|vocabulary|user/,
    );
    expect(Object.keys(diagnostics)).toHaveLength(7);
});

it.each(["rejected", "throws"])(
    "clears upload callbacks when start %s",
    (failure) => {
        const win = hostWindow();
        const service = new VoiceService(clock);
        const context = {
            baseUrl: "http://localhost",
            validate: () => !win.closed,
        };
        if (failure === "throws") {
            vi.spyOn(service.controller, "start").mockImplementationOnce(() => {
                throw new Error("Start failed");
            });
            expect(() =>
                service.start(
                    win as unknown as Window,
                    output,
                    auth,
                    "user",
                    undefined,
                    context,
                ),
            ).toThrow("Start failed");
        } else {
            expect(
                service.start(
                    win as unknown as Window,
                    output,
                    auth,
                    "user",
                    undefined,
                    context,
                ),
            ).toEqual({ error: { code: "disabled" } });
        }
        expect(service.uploadContext).toBeUndefined();
        expect((service as any).auth).toBeUndefined();
        expect(win.listenerCount()).toBe(0);
    },
);

it("preserves the active upload callback when another start is busy", () => {
    const h = createHarness();
    h.run({ command: "enable", enabled: true });
    const context = { baseUrl: "http://localhost", validate: () => true };
    h.service.start(
        hostWindow() as unknown as Window,
        output,
        () => new Promise(() => {}),
        "user",
        undefined,
        context,
    );
    expect(
        h.service.start(
            hostWindow() as unknown as Window,
            output,
            auth,
            "user",
        ),
    ).toEqual({ error: { code: "busy" } });
    expect(h.service.uploadContext).toBe(context);
    h.service.dispose();
    expect(h.service.uploadContext).toBeUndefined();
});
