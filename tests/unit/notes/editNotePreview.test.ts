import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn(),
    getLatestNoteHtml: vi.fn(),
}));

import { shouldFetchNoteContext } from '../../../react/components/agentRuns/EditNotePreview';

describe('EditNotePreview note-context fallback', () => {
    it('keeps note context enabled for insert_before when the anchor is HTML-only', () => {
        expect(shouldFetchNoteContext({
            operation: 'insert_before',
            strippedOld: '',
            effectiveOld: '<p>',
            strippedNew: 'Inserted text',
        })).toBe(true);
    });

    it('still skips note context for rewrite previews', () => {
        expect(shouldFetchNoteContext({
            operation: 'rewrite',
            strippedOld: '',
            effectiveOld: '<p>',
            strippedNew: 'Inserted text',
        })).toBe(false);
    });
});
