import { describe, expect, it, vi } from 'vitest';
import { gzipJsonValueChunked, gzipString, gunzipToString } from '../../../src/utils/gzip';

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

    it('chunked JSON gzip matches JSON.stringify output and yields', async () => {
        const value = {
            pages: Array.from({ length: 25 }, (_, i) => ({
                i,
                text: `page ${i} ${'x'.repeat(200)}`,
            })),
        };
        const yieldToEventLoop = vi.fn().mockResolvedValue(undefined);

        const bytes = await gzipJsonValueChunked(value, {
            yieldAfterChars: 256,
            yieldToEventLoop,
        });

        expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
        expect(yieldToEventLoop).toHaveBeenCalled();
    });

    it('chunks large string fields before encoding', async () => {
        const value = {
            markdown: `${'large text '.repeat(200)}"quoted"\\path\nline\t\u0001\ud800`,
        };
        const yieldToEventLoop = vi.fn().mockResolvedValue(undefined);
        const onDeflatePush = vi.fn();

        const bytes = await gzipJsonValueChunked(value, {
            yieldAfterChars: 128,
            yieldToEventLoop,
            onDeflatePush,
        });

        expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
        expect(yieldToEventLoop.mock.calls.length).toBeGreaterThan(5);
        expect(onDeflatePush.mock.calls.length).toBe(yieldToEventLoop.mock.calls.length);
    });

    it('preserves toJSON omission and nulling semantics', async () => {
        const omitted = { toJSON: () => undefined };
        const value = {
            objectProperty: omitted,
            array: [omitted],
            nested: {
                toJSON(key: string) {
                    return { key };
                },
            },
        };

        const bytes = await gzipJsonValueChunked(value, {
            yieldAfterChars: 64,
            yieldToEventLoop: vi.fn().mockResolvedValue(undefined),
        });

        expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
    });

    it('terminates and round trips for non-positive or invalid slice sizes', async () => {
        const value = { text: 'payload '.repeat(50) };
        for (const yieldAfterChars of [0, -5, 0.25, NaN, Infinity]) {
            const bytes = await gzipJsonValueChunked(value, {
                yieldAfterChars,
                yieldToEventLoop: vi.fn().mockResolvedValue(undefined),
            });
            expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
        }
    });

    it('never splits surrogate pairs across deflate slices', async () => {
        // Odd slice size over a run of astral chars forces slice boundaries
        // onto high surrogates; the slicer must extend past the pair.
        const value = { text: '😀'.repeat(100) };
        const onDeflatePush = vi.fn();

        const bytes = await gzipJsonValueChunked(value, {
            yieldAfterChars: 13,
            yieldToEventLoop: vi.fn().mockResolvedValue(undefined),
            onDeflatePush,
        });

        expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
        expect(onDeflatePush.mock.calls.some(([chars]) => chars === 14)).toBe(true);
    });

    it('batches small JSON tokens before deflating', async () => {
        const value = {
            pages: Array.from({ length: 100 }, (_, i) => ({
                index: i,
                bbox: [i, i + 1, i + 2, i + 3],
            })),
        };
        const onDeflatePush = vi.fn();

        const bytes = await gzipJsonValueChunked(value, {
            yieldAfterChars: 512,
            yieldToEventLoop: vi.fn().mockResolvedValue(undefined),
            onDeflatePush,
        });

        expect(gunzipToString(bytes)).toBe(JSON.stringify(value));
        expect(onDeflatePush.mock.calls.length).toBeLessThan(20);
        expect(onDeflatePush.mock.calls.some(([chars]) => chars > 400)).toBe(true);
    });
});
