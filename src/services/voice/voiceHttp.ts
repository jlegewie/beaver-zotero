/** Strict, single-request HTTP framing. No credentials or audio reach host request logs. */
export const VOICE_HTTP_LIMITS = {
    headers: 4096,
    body: 6144,
    connections: 8,
    requestMs: 2000,
} as const;
export interface VoiceHttpRequest {
    headers: Record<string, string>;
    body: string;
}
export interface VoiceHttpResponse {
    status: number;
    body: object;
}

export class VoiceHttpParser {
    private buffer = "";
    private headers?: Record<string, string>;
    private length = 0;
    private completed = false;
    constructor(private readonly port: number) {}

    push(bytes: string): VoiceHttpRequest | undefined {
        if (
            this.completed ||
            this.buffer.length + bytes.length >
                VOICE_HTTP_LIMITS.headers + VOICE_HTTP_LIMITS.body
        )
            throw new Error("request_limit");
        this.buffer += bytes;
        if (!this.headers) {
            const end = this.buffer.indexOf("\r\n\r\n");
            if (end < 0) {
                if (this.buffer.length > VOICE_HTTP_LIMITS.headers)
                    throw new Error("header_limit");
                return;
            }
            if (end > VOICE_HTTP_LIMITS.headers)
                throw new Error("header_limit");
            const lines = this.buffer.slice(0, end).split("\r\n");
            if (lines.shift() !== "POST /voice HTTP/1.1")
                throw new Error("request_line");
            const headers: Record<string, string> = Object.create(null);
            for (const line of lines) {
                const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(line);
                if (!match || match[1].toLowerCase() in headers)
                    throw new Error("header");
                headers[match[1].toLowerCase()] = match[2].trim();
            }
            if (
                headers.host !== `127.0.0.1:${this.port}` ||
                "origin" in headers ||
                "sec-fetch-site" in headers ||
                "transfer-encoding" in headers ||
                "expect" in headers ||
                headers["content-type"] !== "application/json" ||
                !/^[1-9][0-9]{0,3}$/.test(headers["content-length"] ?? "")
            )
                throw new Error("headers");
            this.length = Number(headers["content-length"]);
            if (this.length > VOICE_HTTP_LIMITS.body)
                throw new Error("body_limit");
            this.headers = headers;
            this.buffer = this.buffer.slice(end + 4);
        }
        if (this.buffer.length > this.length) throw new Error("pipelining");
        if (this.buffer.length < this.length) return;
        this.completed = true;
        // The native wire vocabulary is ASCII, including base64 PCM.
        if (/[^\x20-\x7e\r\n\t]/.test(this.buffer)) throw new Error("encoding");
        return { headers: this.headers, body: this.buffer };
    }
}
