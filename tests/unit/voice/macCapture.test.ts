import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacCaptureService } from "../../../src/services/voice/macCapture";
import { VoiceHttpParser } from "../../../src/services/voice/voiceHttp";
import { VOICE_FORMAT } from "@beaver/agent-core/voice/contracts";

const session = { version: 1 as const, sessionId: "test-session" };
let service: MacCaptureService;
let capture: ReturnType<MacCaptureService["createCapture"]>;
let emit: ReturnType<typeof vi.fn>;
let eventSequence: number;
let controlSequence: number;
const clock = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
};
function send(type: string, fields = {}, token = "secret") {
    return service.handle({
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
            ...session,
            type,
            ...(type === "control"
                ? { sequence: controlSequence++ }
                : { eventSequence: eventSequence++ }),
            ...(["frame", "error"].includes(type)
                ? {
                      quality: {
                          inputPeak: 0,
                          clippedSamples: 0,
                          discontinuityCount: 0,
                      },
                  }
                : {}),
            ...fields,
        }),
    });
}
async function ready() {
    const started = capture.start();
    send("hello", { helperVersion: 2 });
    send("permission", { status: "granted" });
    send("ready", { format: VOICE_FORMAT });
    await started;
}
function frame(samples = 1600, sequence = 0) {
    return send("frame", {
        sequence,
        sampleCount: samples,
        pcm: Buffer.alloc(samples * 2).toString("base64"),
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    emit = vi.fn();
    eventSequence = controlSequence = 0;
    service = new MacCaptureService(
        {
            clock,
            now: Date.now,
            token: () => "secret",
            launch: vi.fn(async () => {}),
            decode: (text) => new Uint8Array(Buffer.from(text, "base64")),
        },
        12345,
    );
    capture = service.createCapture(session, emit);
});
afterEach(() => {
    service.dispose();
    vi.useRealTimers();
});

describe("macOS capture IPC lease", () => {
    it("delivers readiness, ordered PCM and a short tail before finish resolves", async () => {
        await ready();
        frame();
        const finished = capture.finish();
        frame(321, 1);
        send("done", { frameCount: 2, sampleCount: 1921 });
        await finished;
        expect(emit.mock.calls.map(([e]) => e.type)).toEqual([
            "ready",
            "quality",
            "frame",
            "quality",
            "frame",
        ]);
        expect(send("control").status).toBe(403);
    });
    it("rejects wrong authorization without consuming ordering or failing the legitimate session", async () => {
        capture.start();
        expect(send("hello", { helperVersion: 2 }, "wrong").status).toBe(403);
        eventSequence = 0;
        expect(send("hello", { helperVersion: 2 }).status).toBe(200);
        expect(emit).not.toHaveBeenCalled();
    });
    it.each([{ version: 2 }, { sessionId: "other" }, { helperVersion: 99 }])(
        "fails authenticated incompatible handshakes: %j",
        (fields) => {
            capture.start();
            send("hello", { helperVersion: 2, ...fields });
            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({ error: { code: "protocol_error" } }),
            );
        },
    );
    it.each(["denied", "restricted"])(
        "reports explicit %s permission without inferring it from silence",
        (status) => {
            capture.start();
            send("hello", { helperVersion: 2 });
            send("permission", { status });
            send("error", { code: "permission_denied" });
            expect(service.permission).toBe(status);
            expect(emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: { code: "permission_denied" },
                }),
            );
        },
    );
    it("revokes canceled permission setup and allows a fresh session", async () => {
        const started = capture.start();
        send("hello", { helperVersion: 2 });
        send("permission", { status: "not_determined" });
        capture.dispose();
        capture.dispose();
        expect(send("ready", { format: VOICE_FORMAT }).status).toBe(403);
        await expect(started).rejects.toThrow();
        expect(emit).not.toHaveBeenCalled();
        expect(() =>
            service.createCapture({ ...session, sessionId: "next" }, emit),
        ).not.toThrow();
    });
    it("completes a setup-only lease without readiness or audio", async () => {
        capture.dispose();
        capture = service.preparePermission(session) as any;
        const setup = capture.start();
        send("hello", { helperVersion: 2 });
        send("permission", { status: "not_determined" });
        expect(
            send("permission_done", { status: "granted" }).body,
        ).toMatchObject({ command: "exit" });
        await setup;
        expect(service.permission).toBe("granted");
        expect(emit).not.toHaveBeenCalled();
    });
    it("never accepts audio readiness during permission-only setup", async () => {
        capture.dispose();
        capture = service.preparePermission(session) as any;
        const setup = capture.start();
        send("hello", { helperVersion: 2 });
        expect(send("ready", { format: VOICE_FORMAT }).status).toBe(400);
        await expect(setup).rejects.toThrow();
    });
    it("locks concurrent windows at the native boundary", () => {
        expect(() =>
            service.createCapture({ ...session, sessionId: "second" }, emit),
        ).toThrow();
    });
    it("stalls audio even when independent control remains healthy", async () => {
        await ready();
        for (let i = 0; i < 6; i++) {
            send("control");
            vi.advanceTimersByTime(500);
        }
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ error: { code: "capture_failed" } }),
        );
    });
    it("expires missing control even while audio continues", async () => {
        await ready();
        for (let i = 0; i < 6; i++) {
            frame(1600, i);
            vi.advanceTimersByTime(500);
        }
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ error: { code: "disconnected" } }),
        );
    });
    it("bounds startup and finalization", async () => {
        capture.start();
        vi.advanceTimersByTime(30000);
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ error: { code: "startup_timeout" } }),
        );
        capture = service.createCapture(session, emit);
        await ready();
        capture.finish();
        for (let i = 0; i < 20; i++) {
            send("control");
            vi.advanceTimersByTime(500);
        }
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({
                error: { code: "finalization_timeout" },
            }),
        );
    });
    it.each([
        "gap",
        "oversize",
        "early-tail",
        "bad-base64",
        "bad-done",
        "duplicate-ready",
        "control-gap",
    ])("rejects %s", async (kind) => {
        await ready();
        if (kind === "gap") frame(1600, 1);
        if (kind === "oversize") frame(1601);
        if (kind === "early-tail") frame(3);
        if (kind === "bad-base64")
            send("frame", { sequence: 0, sampleCount: 1, pcm: "!!!!" });
        if (kind === "bad-done") {
            capture.finish();
            send("done", { frameCount: 1, sampleCount: 0 });
        }
        if (kind === "duplicate-ready") send("ready", { format: VOICE_FORMAT });
        if (kind === "control-gap") send("control", { sequence: 1 });
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ error: { code: "protocol_error" } }),
        );
    });
    it("makes repeated finish idempotent and rejects frames after the final tail", async () => {
        await ready();
        expect(capture.finish()).toBe(capture.finish());
        frame(20);
        frame(1600, 1);
        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ error: { code: "protocol_error" } }),
        );
    });
    it("revokes every request on plugin disposal", async () => {
        await ready();
        service.dispose();
        expect(send("control").status).toBe(403);
        expect(() => service.createCapture(session, emit)).toThrow();
    });
});

function request(body = "{}", headers = "") {
    return `POST /voice HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n${headers}\r\n${body}`;
}
describe("bounded native HTTP framing", () => {
    it("handles partial header/body reads", () => {
        const parser = new VoiceHttpParser(12345),
            wire = request();
        let parsed;
        for (const byte of wire) parsed = parser.push(byte);
        expect(parsed?.body).toBe("{}");
    });
    it.each([
        "Origin: null\r\n",
        "Origin: https://evil.example\r\n",
        "Host: localhost\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Expect: 100-continue\r\n",
        "Sec-Fetch-Site: cross-site\r\n",
        "Content-Length: 2\r\n",
    ])("rejects unsafe or ambiguous headers %s", (header) => {
        expect(() =>
            new VoiceHttpParser(12345).push(request("{}", header)),
        ).toThrow();
    });
    it("rejects wrong host, oversized headers/body, pipelining, and non-ASCII", () => {
        for (const wire of [
            request().replace("127.0.0.1", "evil.example"),
            request("x".repeat(6145)),
            "x".repeat(4097),
            request() + request(),
            request("é"),
        ]) {
            expect(() => new VoiceHttpParser(12345).push(wire)).toThrow();
        }
    });
});

it("forwards cumulative clipping diagnostics and discontinuities before terminal errors", async () => {
    await ready();
    const quality = {
        inputPeak: 1.2,
        clippedSamples: 20,
        discontinuityCount: 0,
    };
    send("frame", {
        sequence: 0,
        sampleCount: 1600,
        pcm: Buffer.alloc(3200).toString("base64"),
        quality,
    });
    send("error", {
        code: "discontinuity",
        quality: { ...quality, discontinuityCount: 1 },
    });
    expect(emit.mock.calls.slice(-2).map(([event]) => event)).toEqual([
        {
            ...session,
            type: "quality",
            quality: { ...quality, discontinuityCount: 1 },
        },
        { ...session, type: "error", error: { code: "discontinuity" } },
    ]);
});

it.each([
    undefined,
    null,
    { inputPeak: -1, clippedSamples: 0, discontinuityCount: 0 },
    { inputPeak: 1, clippedSamples: 0.5, discontinuityCount: 0 },
])("rejects missing or malformed capture quality %#", async (quality) => {
    await ready();
    send("frame", {
        sequence: 0,
        sampleCount: 1600,
        pcm: Buffer.alloc(3200).toString("base64"),
        quality,
    });
    expect(emit).toHaveBeenLastCalledWith({
        ...session,
        type: "error",
        error: { code: "protocol_error" },
    });
    expect(emit.mock.calls.some(([event]) => event.type === "frame")).toBe(
        false,
    );
});

it("rejects decreasing quality counters", async () => {
    await ready();
    send("frame", {
        sequence: 0,
        sampleCount: 1600,
        pcm: Buffer.alloc(3200).toString("base64"),
        quality: { inputPeak: 1, clippedSamples: 20, discontinuityCount: 0 },
    });
    frame(1600, 1);
    expect(emit).toHaveBeenLastCalledWith({
        ...session,
        type: "error",
        error: { code: "protocol_error" },
    });
});

it("enforces the complete utterance sample bound independently of controller and wall time", async () => {
    await ready();
    for (let i = 0; i < 1200; i++) frame(1600, i);
    expect(emit).not.toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "error" }),
    );
    frame(1600, 1200);
    expect(emit).toHaveBeenLastCalledWith({
        ...session,
        type: "error",
        error: { code: "duration_limit" },
    });
});
