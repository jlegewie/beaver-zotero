import { describe, expect, it } from 'vitest';

import { parseBackgroundJobPayload } from '../../../src/services/documentExtraction/shared/backgroundJobPayloads';

describe('parseBackgroundJobPayload', () => {
    it('accepts a PDF payload', () => {
        expect(
            parseBackgroundJobPayload(
                'pdf',
                JSON.stringify({ content_kind: 'pdf', maxPages: 7, timeoutSeconds: 180 }),
            ),
        ).toEqual({ content_kind: 'pdf', maxPages: 7, timeoutSeconds: 180 });
    });

    it('accepts a queued PDF payload that still carries a file-size limit', () => {
        // The file-size ceiling is now read from a preference, so it is no
        // longer part of the payload — but rows enqueued before that must keep
        // draining rather than being rejected as malformed.
        const legacy = {
            content_kind: 'pdf',
            maxPages: null,
            maxFileSizeMB: 25,
            timeoutSeconds: 180,
        };

        expect(parseBackgroundJobPayload('pdf', JSON.stringify(legacy))).toMatchObject({
            content_kind: 'pdf',
            maxPages: null,
            timeoutSeconds: 180,
        });
    });

    it('rejects a PDF payload whose remaining bounds are missing or wrongly typed', () => {
        expect(
            parseBackgroundJobPayload('pdf', JSON.stringify({ content_kind: 'pdf', maxPages: null })),
        ).toBeNull();
        expect(
            parseBackgroundJobPayload(
                'pdf',
                JSON.stringify({ content_kind: 'pdf', maxPages: 'all', timeoutSeconds: 180 }),
            ),
        ).toBeNull();
    });

    it('rejects a payload whose discriminator disagrees with the column kind', () => {
        expect(parseBackgroundJobPayload('pdf', JSON.stringify({ content_kind: 'epub' }))).toBeNull();
    });

    it('rejects an absent, unknown, or unparseable payload', () => {
        expect(parseBackgroundJobPayload('pdf', null)).toBeNull();
        expect(parseBackgroundJobPayload(null, JSON.stringify({ content_kind: 'pdf' }))).toBeNull();
        expect(parseBackgroundJobPayload('mystery', JSON.stringify({ content_kind: 'mystery' }))).toBeNull();
        expect(parseBackgroundJobPayload('pdf', 'not json')).toBeNull();
    });

    it('passes through the payload kinds that carry no bounds', () => {
        expect(parseBackgroundJobPayload('epub', JSON.stringify({ content_kind: 'epub' }))).toEqual({
            content_kind: 'epub',
        });
        expect(parseBackgroundJobPayload('snapshot', JSON.stringify({ content_kind: 'snapshot' }))).toEqual({
            content_kind: 'snapshot',
        });
        expect(parseBackgroundJobPayload('text', JSON.stringify({ content_kind: 'text' }))).toEqual({
            content_kind: 'text',
        });
    });
});
