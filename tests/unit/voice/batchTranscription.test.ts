import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { BatchTranscription } from "../../../src/services/voice/batchTranscription";
import {
    VOICE_FORMAT,
    type VoiceRecording,
} from "@beaver/agent-core/voice/contracts";
const session = {
    version: 1 as const,
    sessionId: "ee409e96-1ca2-40e8-a953-061f48154a74",
};
const recording = (samples = 8000): VoiceRecording => ({
    ...session,
    format: VOICE_FORMAT,
    sampleCount: samples,
    pcm: Uint8Array.from({ length: samples * 2 }, (_, i) => i % 251),
    options: {
        language: "de",
        biasTerms: ["Bourdieu"],
        correctionVocabulary: ["Habitus"],
    },
});
const success = (samples = 8000) => ({
    session_id: session.sessionId,
    transcript: "Corrected dictation.",
    duration_ms: Math.ceil(samples / 16),
    credit_cost: "0.75",
});
function setup(body: unknown = success(), status = 200, validate = () => true) {
    const fetcher = vi.fn(
        async () => new Response(JSON.stringify(body), { status }),
    );
    const adapter = new BatchTranscription(
        session,
        { baseUrl: "http://127.0.0.1:8000/", validate },
        { fetch: fetcher as typeof fetch, yieldTask: async () => {} },
    );
    return { adapter, fetcher };
}
describe("batch upload", () => {
    it.each([8000, 1920000])(
        "uploads one exact gzip member preserving %i samples and the wire metadata",
        async (samples) => {
            const r = recording(samples);
            let observed: Uint8Array | undefined;
            const fetcher = vi.fn(async (_url, init) => {
                observed = new Uint8Array(init.body);
                return new Response(JSON.stringify(success(samples)));
            });
            const adapter = new BatchTranscription(
                session,
                { baseUrl: "http://localhost:8000", validate: () => true },
                { fetch: fetcher, yieldTask: async () => {} },
            );
            expect(await adapter.transcribe(r, "credential")).toEqual({
                ...session,
                text: "Corrected dictation.",
            });
            const bytes = observed!;
            const size = new DataView(bytes.buffer).getUint32(0, false);
            expect(
                JSON.parse(
                    new TextDecoder().decode(bytes.subarray(4, 4 + size)),
                ),
            ).toEqual({
                version: 1,
                session_id: session.sessionId,
                encoding: "pcm16le-gzip",
                sample_rate: 16000,
                channels: 1,
                language: "de",
                biasTerms: ["Bourdieu"],
                correctionVocabulary: ["Habitus"],
            });
            expect(
                gunzipSync(bytes.subarray(4 + size)).equals(Buffer.from(r.pcm)),
            ).toBe(true);
            expect(fetcher).toHaveBeenCalledOnce();
            expect(fetcher.mock.calls[0][0]).toBe(
                "http://localhost:8000/api/v1/voice/transcriptions",
            );
            expect(
                fetcher.mock.calls[0][1].headers["Content-Encoding"],
            ).toBeUndefined();
            expect(
                fetcher.mock.calls[0][1].body.every((byte) => byte === 0),
            ).toBe(true);
        },
    );
    it("cancels during compression without a POST", async () => {
        const fetcher = vi.fn();
        const adapter = new BatchTranscription(
            session,
            { baseUrl: "", validate: () => true },
            { fetch: fetcher, yieldTask: async () => adapter.dispose() },
        );
        await adapter.transcribe(recording(), "credential");
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("revalidates excluded sources after compression and makes no POST", async () => {
        const { adapter, fetcher } = setup(success(), 200, () => false);
        expect(await adapter.transcribe(recording(), "credential")).toEqual({
            ...session,
            error: { code: "source_ineligible" },
        });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("aborts a pending request and rejects a late successful response", async () => {
        let resolve!: (r: Response) => void;
        const fetcher = vi.fn(
            () => new Promise<Response>((r) => (resolve = r)),
        );
        const adapter = new BatchTranscription(
            session,
            { baseUrl: "", validate: () => true },
            { fetch: fetcher, yieldTask: async () => {} },
        );
        const pending = adapter.transcribe(recording(), "credential");
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        adapter.dispose();
        resolve(new Response(JSON.stringify(success())));
        expect(await pending).toEqual({
            ...session,
            error: { code: "outcome_unknown" },
        });
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    });
    it.each([
        ["invalid_auth", 401, "unauthenticated"],
        ["__proto__", 500, "transcription_failed"],
        ["toString", 500, "transcription_failed"],
        ["insufficient_credits", 402, "insufficient_credits"],
        ["voice_disabled", 403, "disabled"],
        ["session_in_progress", 409, "outcome_unknown"],
        ["result_unavailable", 409, "outcome_unknown"],
        ["settlement_pending", 503, "outcome_unknown"],
        ["outcome_unknown", 409, "outcome_unknown"],
        ["voice_busy", 429, "busy"],
        ["no_speech", 422, "no_speech"],
        ["voice_timeout", 504, "transcription_timeout"],
        ["provider_failed", 424, "transcription_failed"],
        ["correction_failed", 424, "transcription_failed"],
    ])("normalizes %s without replaying", async (code, status, expected) => {
        const { adapter, fetcher } = setup(
            { detail: { code } },
            status as number,
        );
        expect(await adapter.transcribe(recording(), "credential")).toEqual({
            ...session,
            error: { code: expected },
        });
        await adapter.transcribe(recording(), "credential");
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it.each([
        { session_id: "other" },
        { transcript: "" },
        { transcript: "a".repeat(64001) },
        { duration_ms: 0 },
        { credit_cost: "-1" },
        { credit_cost: null },
    ])("rejects malformed success", async (override) => {
        const { adapter } = setup({ ...success(), ...override });
        expect(await adapter.transcribe(recording(), "credential")).toEqual({
            ...session,
            error: { code: "outcome_unknown" },
        });
    });
    it("bounds response reads before parsing even without Content-Length", async () => {
        const { adapter } = setup({ transcript: "x".repeat(500000) });
        expect(await adapter.transcribe(recording(), "credential")).toEqual({
            ...session,
            error: { code: "outcome_unknown" },
        });
    });
    it("does not upload oversized PCM or invalid IDs", async () => {
        for (const invalid of [
            { ...recording(), sessionId: "opaque" },
            recording(1920001),
        ]) {
            const { adapter, fetcher } = setup();
            expect(await adapter.transcribe(invalid, "credential")).toEqual({
                ...session,
                error: { code: "protocol_error" },
            });
            expect(fetcher).not.toHaveBeenCalled();
        }
    });
});

it.each(["fetch", "stream", "utf8", "json", "empty"])(
    "reports unknown billing after dispatch failure: %s",
    async (stage) => {
        const { adapter, fetcher } = setup();
        fetcher.mockImplementationOnce(async () => {
            if (stage === "fetch")
                throw new TypeError("Network connection lost");
            if (stage === "stream")
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode('{"session_id":'),
                            );
                        },
                        pull(controller) {
                            controller.error(new Error("Connection lost"));
                        },
                    }),
                );
            if (stage === "utf8") return new Response(new Uint8Array([0xff]));
            if (stage === "json") return new Response("{truncated");
            return new Response(null);
        });
        expect(await adapter.transcribe(recording(), "credential")).toEqual({
            ...session,
            error: { code: "outcome_unknown" },
        });
        await adapter.transcribe(recording(), "credential");
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][1].body.every((byte) => byte === 0)).toBe(
            true,
        );
    },
);

it("does not report uncertain billing when preparation fails before dispatch", async () => {
    const fetcher = vi.fn();
    const adapter = new BatchTranscription(
        session,
        { baseUrl: "", validate: () => true },
        {
            fetch: fetcher,
            yieldTask: async () => {
                throw new Error("Compression setup failed");
            },
        },
    );
    expect(await adapter.transcribe(recording(), "credential")).toEqual({
        ...session,
        error: { code: "transcription_failed" },
    });
    expect(fetcher).not.toHaveBeenCalled();
});
