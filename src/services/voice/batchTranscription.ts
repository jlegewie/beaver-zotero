import { Deflate } from "pako";
import {
    VOICE_LIMITS,
    type VoiceEnvelope,
    type VoiceErrorCode,
    type VoiceRecording,
    type VoiceTranscript,
    type VoiceTranscription,
} from "@beaver/agent-core/voice/contracts";

export interface VoiceUploadContext {
    baseUrl: string;
    /** Revalidate activation-time source eligibility and account immediately before upload. */
    validate(): boolean;
}
export interface BatchDependencies {
    fetch: typeof fetch;
    yieldTask(): Promise<void>;
}

const errors: Record<string, VoiceErrorCode> = {
    invalid_auth: "unauthenticated",
    insufficient_credits: "insufficient_credits",
    voice_disabled: "disabled",
    voice_unavailable: "unavailable",
    voice_busy: "busy",
    no_speech: "no_speech",
    audio_too_long: "duration_limit",
    payload_too_large: "overflow",
    invalid_request: "protocol_error",
    invalid_audio: "protocol_error",
    invalid_result: "protocol_error",
    voice_timeout: "transcription_timeout",
    session_conflict: "outcome_unknown",
    session_in_progress: "outcome_unknown",
    result_unavailable: "outcome_unknown",
    outcome_unknown: "outcome_unknown",
    settlement_pending: "outcome_unknown",
};

/** One bounded upload. Never retries or stores audio, vocabulary, transcripts, or credentials. */
export class BatchTranscription implements VoiceTranscription {
    private abort = new AbortController();
    private used = false;
    private buffers: Uint8Array[] = [];
    constructor(
        private session: VoiceEnvelope,
        private context: VoiceUploadContext,
        private deps: BatchDependencies,
    ) {}

    async transcribe(
        recording: VoiceRecording,
        credential: string,
    ): Promise<VoiceTranscript> {
        const failure = (code: VoiceErrorCode): VoiceTranscript => ({
            ...this.session,
            error: { code },
        });
        if (this.used || this.abort.signal.aborted)
            return failure("protocol_error");
        this.used = true;
        let dispatched = false;
        try {
            if (
                recording.sessionId !== this.session.sessionId ||
                recording.version !== 1 ||
                !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
                    recording.sessionId,
                ) ||
                recording.pcm.length !== recording.sampleCount * 2 ||
                recording.pcm.length > VOICE_LIMITS.bufferBytes ||
                recording.sampleCount < VOICE_LIMITS.minimumSamples ||
                !credential
            )
                return failure("protocol_error");
            const metadata = new TextEncoder().encode(
                JSON.stringify({
                    version: 1,
                    session_id: recording.sessionId,
                    language: recording.options.language,
                    encoding: "pcm16le-gzip",
                    sample_rate: 16000,
                    channels: 1,
                    biasTerms: recording.options.biasTerms,
                    correctionVocabulary:
                        recording.options.correctionVocabulary,
                }),
            );
            this.buffers.push(metadata);
            if (metadata.length > 400000) return failure("overflow");
            const chunks: Uint8Array[] = [];
            let compressedSize = 0;
            const encoder = new Deflate({ gzip: true, chunkSize: 16384 });
            encoder.onData = (chunk: Uint8Array) => {
                compressedSize += chunk.length;
                this.buffers.push(chunk);
                chunks.push(chunk);
            };
            // Yield between bounded chunks so Esc and owner teardown can interrupt compression.
            for (
                let offset = 0;
                offset < recording.pcm.length;
                offset += 65536
            ) {
                await this.deps.yieldTask();
                if (this.abort.signal.aborted) return failure("disconnected");
                encoder.push(
                    recording.pcm.subarray(offset, offset + 65536),
                    offset + 65536 >= recording.pcm.length,
                );
                if (encoder.err || compressedSize > 3850000)
                    return failure("overflow");
            }
            const body = new Uint8Array(4 + metadata.length + compressedSize);
            this.buffers.push(body);
            new DataView(body.buffer).setUint32(0, metadata.length, false);
            body.set(metadata, 4);
            let cursor = 4 + metadata.length;
            for (const chunk of chunks) {
                body.set(chunk, cursor);
                cursor += chunk.length;
            }
            if (this.abort.signal.aborted) return failure("disconnected");
            if (!this.context.validate()) return failure("source_ineligible");
            const url = `${this.context.baseUrl.replace(/\/$/, "")}/api/v1/voice/transcriptions`;
            // Once fetch is invoked, a missing or unreadable result cannot establish whether billing occurred.
            dispatched = true;
            const response = await this.deps.fetch(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${credential}`,
                    "Content-Type": "application/vnd.beaver.voice.v1",
                },
                body,
                signal: this.abort.signal,
                cache: "no-store",
                redirect: "error",
                credentials: "omit",
            });
            // Bound the response before JSON parsing, including servers that omit Content-Length.
            if (!response.body) return failure("outcome_unknown");
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8", { fatal: true });
            let text = "",
                bytes = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.length;
                    if (bytes > 400000) {
                        await reader.cancel();
                        return failure("outcome_unknown");
                    }
                    text += decoder.decode(part.value, { stream: true });
                }
                text += decoder.decode();
            } finally {
                reader.releaseLock();
            }
            if (this.abort.signal.aborted) return failure("outcome_unknown");
            const data = JSON.parse(text);
            if (!response.ok) {
                const code = data?.detail?.code;
                return failure(
                    typeof code === "string" &&
                        Object.prototype.hasOwnProperty.call(errors, code)
                        ? errors[code]
                        : "transcription_failed",
                );
            }
            if (
                data?.session_id !== this.session.sessionId ||
                typeof data.transcript !== "string" ||
                !data.transcript.trim() ||
                data.transcript.length > VOICE_LIMITS.transcriptCharacters ||
                data.duration_ms !== Math.ceil(recording.sampleCount / 16) ||
                !["string", "number"].includes(typeof data.credit_cost) ||
                !/^\d+(?:\.\d+)?$/.test(String(data.credit_cost)) ||
                !Number.isFinite(Number(data.credit_cost))
            )
                return failure("outcome_unknown");
            return { ...this.session, text: data.transcript };
        } catch {
            return failure(
                dispatched
                    ? "outcome_unknown"
                    : this.abort.signal.aborted
                      ? "disconnected"
                      : "transcription_failed",
            );
        } finally {
            this.release();
        }
    }
    private release() {
        for (const bytes of this.buffers) bytes.fill(0);
        this.buffers = [];
    }
    dispose() {
        this.abort.abort();
        this.release();
    }
}
