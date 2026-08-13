import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn(),
}));

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getLatestNoteHtml: vi.fn(),
}));

import {
    computeRewriteScope,
    formatRewriteScope,
    recoverSimplifiedCitationLabel,
    shouldFetchNoteContext,
} from '../../../react/components/agentRuns/EditNotePreview';

beforeEach(() => {
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) => {
                if (libraryID !== 1) return false;
                if (key === 'ATTACH') return { kind: 'attachment', parentItemID: 10, isAttachment: (): boolean => true };
                if (key === 'PARENT') return { kind: 'parent-direct', isAttachment: (): boolean => false };
                return false;
            }),
            get: vi.fn((itemID: number) => itemID === 10 ? { kind: 'parent' } : false),
        },
        Utilities: {
            Item: {
                itemToCSLJSON: vi.fn((item: any) => ({ title: item.kind })),
            },
        },
        EditorInstanceUtilities: {
            formatCitation: vi.fn((citation: any) => {
                const title = citation.citationItems[0]?.itemData?.title;
                return `(${title})`;
            }),
        },
    };
});

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

describe('rewrite scope summary', () => {
    const paragraphs = Array.from(
        { length: 115 },
        (_, i) => `<p>Paragraph ${i} of a long research note about corrugator activity.</p>`,
    );
    const oldHtml = paragraphs.join('\n');

    it('names the share of text a shrinking rewrite deletes', () => {
        const newHtml = paragraphs.slice(0, 22).join('\n');
        const scope = computeRewriteScope(oldHtml, newHtml);

        expect(scope).toMatchObject({ oldLines: 115, newLines: 22, isDestructive: true });
        expect(formatRewriteScope(scope)).toBe(
            'Replaces the entire note: 115 → 22 lines, about 81% of the text is deleted',
        );
    });

    it('names replacement, not deletion, when a rewrite keeps the length', () => {
        const newHtml = Array.from(
            { length: 115 },
            (_, i) => `<p>Section ${i}: housing markets reproduce urban inequality.</p>`,
        ).join('\n');
        const scope = computeRewriteScope(oldHtml, newHtml);

        expect(scope?.isDestructive).toBe(true);
        expect(formatRewriteScope(scope)).toContain('of the text is replaced');
    });

    it('stays neutral when a rewrite grows the note', () => {
        const newHtml = `${oldHtml}\n${paragraphs.slice(0, 25).join('\n')}`;
        const scope = computeRewriteScope(oldHtml, newHtml);

        expect(scope?.isDestructive).toBe(false);
        expect(formatRewriteScope(scope)).toBe('Replaces the entire note: 115 → 140 lines');
    });

    it('claims no magnitude while the old body is still unknown', () => {
        expect(computeRewriteScope('', '<p>new</p>')).toBeNull();
        expect(formatRewriteScope(null)).toBe('Replaces the entire note');
    });
});

describe('recoverSimplifiedCitationLabel', () => {
    it('resolves att_id citation labels through the parent item', () => {
        expect(recoverSimplifiedCitationLabel('<citation att_id="1-ATTACH"/>')).toBe('(parent)');
    });

    it('resolves attachment_id citation labels through the parent item', () => {
        expect(recoverSimplifiedCitationLabel('<citation attachment_id="1-ATTACH"/>')).toBe('(parent)');
    });

    it('keeps item_id citation labels on the direct item', () => {
        expect(recoverSimplifiedCitationLabel('<citation item_id="1-PARENT"/>')).toBe('(parent-direct)');
    });

    it('resolves unified id attachment citation labels through the parent item', () => {
        expect(recoverSimplifiedCitationLabel('<citation id="1-ATTACH"/>')).toBe('(parent)');
    });

    it('resolves a portable "u-<key>" citation the same way as its legacy numeric equivalent', () => {
        (globalThis as any).Zotero.Libraries = { userLibraryID: 1 };
        expect(recoverSimplifiedCitationLabel('<citation id="u-ATTACH"/>')).toBe('(parent)');
        expect(recoverSimplifiedCitationLabel('<citation item_id="u-PARENT"/>')).toBe('(parent-direct)');
    });
});
