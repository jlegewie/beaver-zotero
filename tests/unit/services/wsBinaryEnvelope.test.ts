import { describe, expect, it } from 'vitest';

import {
    buildEnvelopeFrame,
    gzipDecompressedSize,
    isWSBinaryEnvelope,
    type WSBinaryEnvelope,
} from '../../../src/services/wsBinaryEnvelope';
import { gzipString, gunzipToString } from '../../../src/utils/gzip';

describe('wsBinaryEnvelope', () => {
    it('builds a frame with BE length prefix, JSON header, and intact payload', () => {
        const payload = gzipString('{"hello": "world"}');
        const envelope: WSBinaryEnvelope = {
            kind: 'ws_binary_envelope',
            header: { type: 'zotero_document', request_id: 'r1', content_kind: 'pdf' },
            payload,
        };

        const frame = buildEnvelopeFrame(envelope);

        const headerLen = new DataView(frame.buffer).getUint32(0, false);
        const headerText = new TextDecoder().decode(frame.subarray(4, 4 + headerLen));
        const header = JSON.parse(headerText);
        expect(header).toEqual({
            type: 'zotero_document',
            request_id: 'r1',
            content_kind: 'pdf',
            payload_encoding: 'gzip',
        });

        const framePayload = frame.subarray(4 + headerLen);
        expect(framePayload).toEqual(payload);
        expect(gunzipToString(framePayload)).toBe('{"hello": "world"}');
    });

    it('reads the decompressed size from the gzip ISIZE trailer', () => {
        const text = 'x'.repeat(123_456);
        const blob = gzipString(text);
        expect(gzipDecompressedSize(blob)).toBe(123_456);
    });

    it('returns 0 for blobs smaller than a minimal gzip stream', () => {
        expect(gzipDecompressedSize(new Uint8Array(4))).toBe(0);
    });

    it('isWSBinaryEnvelope discriminates envelopes from JSON responses', () => {
        const envelope: WSBinaryEnvelope = {
            kind: 'ws_binary_envelope',
            header: { type: 'zotero_document', request_id: 'r1' },
            payload: gzipString('{}'),
        };
        expect(isWSBinaryEnvelope(envelope)).toBe(true);
        expect(isWSBinaryEnvelope({ type: 'zotero_document', request_id: 'r1' })).toBe(false);
        expect(isWSBinaryEnvelope(null)).toBe(false);
        expect(isWSBinaryEnvelope('ws_binary_envelope')).toBe(false);
    });
});
