import { describe, expect, it } from 'vitest';
import { gzipString, gunzipToString } from '../../../src/utils/gzip';

describe('gzip helpers', () => {
    it('round trips ASCII text', () => {
        const text = 'plain text payload';
        expect(gunzipToString(gzipString(text))).toBe(text);
    });

    it('round trips Unicode text', () => {
        const text = 'PDF labels: α β γ — Пример';
        expect(gunzipToString(gzipString(text))).toBe(text);
    });

    it('round trips a large JSON string', () => {
        const text = JSON.stringify({ pages: Array.from({ length: 500 }, (_, i) => ({ i, text: 'x'.repeat(200) })) });
        expect(gunzipToString(gzipString(text))).toBe(text);
    });

    it('throws for malformed gzip bytes', () => {
        expect(() => gunzipToString(new Uint8Array([1, 2, 3]))).toThrow();
    });
});
