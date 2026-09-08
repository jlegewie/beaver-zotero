import type { VoiceClock } from "@beaver/agent-core/voice/contracts";
import {
    VOICE_HTTP_LIMITS,
    VoiceHttpParser,
    type VoiceHttpRequest,
    type VoiceHttpResponse,
} from "./voiceHttp";

/** Plugin-realm loopback listener with bounded reads, connections, and request lifetimes. */
export class VoiceSocket {
    readonly port: number;
    private socket: any;
    private connections = new Set<() => void>();

    constructor(
        clock: VoiceClock,
        handle: (request: VoiceHttpRequest) => VoiceHttpResponse,
    ) {
        const socket = (this.socket = Cc[
            "@mozilla.org/network/server-socket;1"
        ].createInstance(Ci.nsIServerSocket));
        socket.init(-1, true, VOICE_HTTP_LIMITS.connections);
        this.port = socket.port;
        socket.asyncListen({
            onSocketAccepted: (_server: unknown, transport: any) => {
                if (this.connections.size >= VOICE_HTTP_LIMITS.connections) {
                    transport.close(Cr.NS_ERROR_ABORT);
                    return;
                }
                const input = transport.openInputStream(0, 0, 0);
                const output = transport.openOutputStream(
                    Ci.nsITransport.OPEN_BLOCKING,
                    0,
                    0,
                );
                const pump = Cc[
                    "@mozilla.org/network/input-stream-pump;1"
                ].createInstance(Ci.nsIInputStreamPump);
                const reader = Cc[
                    "@mozilla.org/binaryinputstream;1"
                ].createInstance(Ci.nsIBinaryInputStream);
                let readerAttached = false;
                const parser = new VoiceHttpParser(this.port);
                let closed = false;
                const close = (graceful = false) => {
                    if (closed) return;
                    closed = true;
                    clock.clearTimeout(timer);
                    this.connections.delete(close);
                    try {
                        input.close();
                        output.close();
                        // Closing the buffered output drains its pipe. Closing the transport
                        // here would discard a response before the socket thread writes it.
                        if (!graceful) transport.close(Cr.NS_ERROR_ABORT);
                    } catch {
                        /* Already closed. */
                    }
                };
                const timer = clock.setTimeout(() => {
                    close();
                }, VOICE_HTTP_LIMITS.requestMs);
                this.connections.add(close);
                const reply = (result: VoiceHttpResponse) => {
                    const body = JSON.stringify(result.body);
                    const response = `HTTP/1.1 ${result.status} Result\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n${body}`;
                    try {
                        output.write(response, response.length);
                    } finally {
                        close(true);
                    }
                };
                pump.init(input, 0, 0, true);
                pump.asyncRead({
                    onStartRequest: () => {},
                    onDataAvailable: (
                        _request: unknown,
                        stream: any,
                        _offset: number,
                        count: number,
                    ) => {
                        if (closed) return;
                        try {
                            if (
                                count >
                                VOICE_HTTP_LIMITS.headers +
                                    VOICE_HTTP_LIMITS.body
                            )
                                throw new Error("request_limit");
                            // The pump supplies its buffered stream, which differs from the raw
                            // transport input. Replacing a binary reader's stream closes the old one.
                            if (!readerAttached) {
                                reader.setInputStream(stream);
                                readerAttached = true;
                            }
                            const request = parser.push(
                                reader.readBytes(count),
                            );
                            if (request) reply(handle(request));
                        } catch {
                            if (!closed)
                                reply({
                                    status: 400,
                                    body: { command: "cancel" },
                                });
                        }
                    },
                    onStopRequest: () => {
                        close();
                    },
                });
            },
            onStopListening: () => {},
        });
    }

    dispose(): void {
        try {
            this.socket.close();
        } finally {
            for (const close of [...this.connections]) close();
        }
    }
}
