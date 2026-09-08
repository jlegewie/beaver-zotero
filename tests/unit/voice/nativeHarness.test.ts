import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentVoiceHarness } from "../../../src/services/voice/developmentHarness";
import { FakeVoiceCapture } from "@beaver/agent-core/voice/fakes";

import type { NativeCaptureHost } from "../../../src/services/voice/nativeCaptureHarness";

let native: NativeCaptureHost;
let capture: FakeVoiceCapture;
let h: DevelopmentVoiceHarness;
const win = {
    closed: false,
    document: { hasFocus: () => true },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
} as any;
const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
    vi.stubGlobal("Cu", { now: Date.now });
    let id = 0;
    Zotero.Utilities.randomString = () => `native-test-${++id}`;
    native = {
        available: true,
        permission: "granted",
        explain: vi.fn(() => true),
        prepareMicrophone: vi.fn(async () => "granted" as const),
        createCapture: vi.fn(
            (session, emit) => (capture = new FakeVoiceCapture(session, emit)),
        ),
    };
    h = new DevelopmentVoiceHarness(
        { setTimeout: () => 1, clearTimeout: () => {} },
        native,
    );
});
afterEach(() => {
    h.service.dispose();
    vi.unstubAllGlobals();
});

it("does not retain microphone bytes by default", async () => {
    await h.startNative(win);
    await settle();
    capture.frame();
    h.run({ command: "finish" });
    await settle();
    expect(h.nativeState().retainedBytes).toBe(0);
    await expect(h.saveRecording("/tmp/test.wav")).rejects.toThrow(
        "No completed opt-in recording",
    );
});
it("writes an opted-in local WAV with the correct format and final tail, then releases retained bytes", async () => {
    const write = vi.fn(async () => 0);
    vi.stubGlobal("IOUtils", { write });
    await h.startNative(win, true);
    await settle();
    capture.frame();
    await expect(h.saveRecording("/tmp/test.wav")).rejects.toThrow();
    h.run({ command: "finish" });
    await settle();
    await h.saveRecording("/tmp/test.wav");
    const wav: Uint8Array = write.mock.calls[0][1];
    const header = new DataView(wav.buffer);
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint32(24, true)).toBe(16000);
    expect(header.getUint16(34, true)).toBe(16);
    expect(header.getUint32(28, true)).toBe(32000);
    expect(header.getUint16(32, true)).toBe(2);
    expect(header.getUint32(40, true)).toBe(4480);
    expect(wav.length).toBe(44 + 4480);
    expect(h.nativeState().retainedBytes).toBe(0);
});
it("keeps opted-in bytes recoverable if writing the local file fails", async () => {
    vi.stubGlobal("IOUtils", {
        write: vi.fn(async () => {
            throw new Error("disk full");
        }),
    });
    await h.startNative(win, true);
    await settle();
    capture.frame();
    h.run({ command: "finish" });
    await settle();
    await expect(h.saveRecording("/tmp/test.wav")).rejects.toThrow("disk full");
    expect(h.nativeState().retainedBytes).toBe(4480);
});

const auth = async () => ({ userId: "fake-user", credential: "fake-only" });

it("does not enable synthetic sessions after a native session", async () => {
    await h.startNative(win);
    await settle();
    h.run({ command: "finish" });
    await settle();
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "disabled" } });
    expect(native.createCapture).toHaveBeenCalledTimes(1);
});

it("uses synthetic capture after native capture and requires enable again after disabling", async () => {
    await h.startNative(win);
    await settle();
    h.run({ command: "enable", enabled: false });
    expect(h.service.controller.getSnapshot().phase).toBe("canceled");
    expect(capture.disposeCount).toBe(1);
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "disabled" } });
    h.run({ command: "enable", enabled: true });
    h.start("fake-user", auth);
    await settle();
    const state = h.run({ command: "frame" });
    expect(state.state.frameCount).toBe(1);
    expect(native.createCapture).toHaveBeenCalledTimes(1);
});

it("keeps native buffers and metrics unchanged when either harness rejects a busy start", async () => {
    await h.startNative(win, true);
    await settle();
    capture.frame();
    const before = h.nativeState();
    expect(await h.startNative(win)).toEqual({ error: { code: "busy" } });
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "busy" } });
    expect(h.nativeState()).toEqual(before);
    expect(native.createCapture).toHaveBeenCalledTimes(1);
});

it("rejects native activation during synthetic capture without changing the adapter", async () => {
    h.run({ command: "enable", enabled: true });
    h.start("fake-user", auth);
    await settle();
    expect(await h.startNative(win)).toEqual({ error: { code: "busy" } });
    expect(h.run({ command: "frame" }).state.frameCount).toBe(1);
    expect(native.createCapture).not.toHaveBeenCalled();
});

it("serializes permission setup and requires fresh activation without recording", async () => {
    let resolve!: (status: "granted") => void;
    native.permission = "unknown";
    native.prepareMicrophone = vi.fn(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const setup = h.startNative(win);
    expect(await h.startNative(win)).toEqual({ error: { code: "busy" } });
    h.run({ command: "enable", enabled: true });
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "busy" } });
    expect(native.explain).not.toHaveBeenCalled(); // prepareMicrophone owns the setup explanation.
    native.permission = "granted";
    resolve("granted");
    expect(await setup).toMatchObject({ setup: true, permission: "granted" });
    expect(native.createCapture).not.toHaveBeenCalled();
    expect(h.service.controller.getSnapshot().phase).toBe("idle");
    await h.startNative(win);
    await settle();
    expect(native.createCapture).toHaveBeenCalledTimes(1);
});

it("releases the setup guard on failure", async () => {
    native.permission = "unknown";
    native.prepareMicrophone = vi.fn(async () => {
        throw new Error("setup failed");
    });
    expect(await h.startNative(win)).toMatchObject({
        error: { code: "unavailable" },
        help: expect.stringContaining("helper is installed"),
    });
    h.run({ command: "enable", enabled: true });
    expect(h.start("fake-user", auth)).toHaveProperty("sessionId");
});

it("preserves a completed recording when a new start has no focused owner", async () => {
    await h.startNative(win, true);
    await settle();
    capture.frame();
    h.run({ command: "finish" });
    await settle();
    const before = h.nativeState();
    expect(
        await h.startNative({ ...win, document: { hasFocus: () => false } }),
    ).toEqual({ error: { code: "unavailable" } });
    expect(h.nativeState()).toEqual(before);
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "disabled" } });
});

it("does not clear a new recording when an earlier file write finishes", async () => {
    let resolve!: () => void;
    vi.stubGlobal("IOUtils", {
        write: vi.fn(
            () =>
                new Promise<void>((r) => {
                    resolve = r;
                }),
        ),
    });
    await h.startNative(win, true);
    await settle();
    capture.frame();
    h.run({ command: "finish" });
    await settle();
    const saving = h.saveRecording("/tmp/earlier.wav");
    await h.startNative(win, true);
    await settle();
    capture.frame();
    resolve();
    await saving;
    expect(h.nativeState()?.retainedBytes).toBe(3200);
});

it("keeps native capture under application authentication cleanup", async () => {
    await h.startNative(win);
    await settle();
    h.service.authChanged(null);
    expect(h.service.controller.getSnapshot().phase).toBe("canceled");
    expect(capture.disposeCount).toBe(1);
});

it("bounds opted-in retention to the capture duration even with extra frames", async () => {
    await h.startNative(win, true);
    await settle();
    for (let i = 0; i < 1201; i++) {
        capture.frame();
        await settle();
    }
    expect(h.nativeState()?.retainedBytes).toBe(3840000);
    expect(h.service.controller.getSnapshot().phase).toBe("listening");
});

it("reports canceled permission setup as unavailable without a second explanation", async () => {
    native.permission = "unknown";
    native.prepareMicrophone = vi.fn(async () => "unknown" as const);
    expect(await h.startNative(win)).toEqual({
        error: { code: "unavailable" },
    });
    expect(native.explain).not.toHaveBeenCalled();
    expect(native.createCapture).not.toHaveBeenCalled();
    expect(h.start("fake-user", auth)).toEqual({ error: { code: "disabled" } });
});
