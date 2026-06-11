/**
 * Binary WebSocket envelope for large compressed payloads.
 *
 * Large data-request responses (whole-document extraction results) are sent
 * as a single binary frame instead of JSON text so the payload can stay
 * gzip-compressed end to end.
 *
 * Frame layout (must match the backend parser in
 * app/services/chat_ws/incoming_messages.py):
 *
 *   [0..3]    uint32 big-endian header length N
 *   [4..4+N)  UTF-8 JSON header — the response object minus the payload
 *             field, plus payload_encoding: 'gzip' (must carry type and
 *             request_id)
 *   [4+N..)   gzip (RFC 1952) of the JSON-serialized payload value
 *
 * Only sent when the corresponding request advertised `accept_encoding`
 * containing 'gzip'; older backends cannot parse binary frames.
 */

/** Discriminated wrapper a data-request handler returns instead of JSON. */
export interface WSBinaryEnvelope {
    kind: 'ws_binary_envelope';
    /** Response object minus the payload field; must include type + request_id. */
    header: Record<string, any>;
    /** gzip (RFC 1952) of the JSON-serialized payload value. */
    payload: Uint8Array;
}

export function isWSBinaryEnvelope(value: unknown): value is WSBinaryEnvelope {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as any).kind === 'ws_binary_envelope' &&
        (value as any).payload instanceof Uint8Array
    );
}

/** Skip compression for small results; JSON is simpler and cheap at this size. */
export const SMALL_PAYLOAD_THRESHOLD_BYTES = 256 * 1024;

/**
 * Max serialized-JSON size for the legacy (uncompressed) response path, just
 * under the 64MB `--ws-max-size` deployed on current backends. Backends that
 * advertise `accept_encoding` never take this path. NOT 16MB: a tighter guard
 * would regress 16-64MB documents that work against deployed backends today.
 */
export const LEGACY_MAX_JSON_BYTES = 60 * 1024 * 1024;

export type WSBinaryFrame = Uint8Array | Blob;

/** Build the single binary frame for a WSBinaryEnvelope. */
export function buildEnvelopeFrame(envelope: WSBinaryEnvelope): WSBinaryFrame {
    const headerBytes = new TextEncoder().encode(
        JSON.stringify({ ...envelope.header, payload_encoding: 'gzip' }),
    );
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, headerBytes.byteLength, false);
    if (typeof Blob !== 'undefined') {
        return new Blob(
            [
                prefix as unknown as BlobPart,
                headerBytes as unknown as BlobPart,
                envelope.payload as unknown as BlobPart,
            ],
            { type: 'application/octet-stream' },
        );
    }

    const frame = new Uint8Array(4 + headerBytes.byteLength + envelope.payload.byteLength);
    frame.set(prefix, 0);
    frame.set(headerBytes, 4);
    frame.set(envelope.payload, 4 + headerBytes.byteLength);
    return frame;
}

/**
 * Decompressed size of a gzip blob from its ISIZE trailer (last 4 bytes,
 * little-endian, uncompressed length mod 2^32). Exact for payloads under
 * 4GB — far beyond any transfer budget — and free: no inflation needed.
 */
export function gzipDecompressedSize(blob: Uint8Array): number {
    if (blob.byteLength < 18) return 0; // smaller than a minimal gzip stream
    return new DataView(blob.buffer, blob.byteOffset + blob.byteLength - 4, 4).getUint32(0, true);
}
