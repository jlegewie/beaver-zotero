import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/noteHtmlSimplifier', () => ({
    getOrSimplify: vi.fn(),
}));

vi.mock('../../../src/utils/noteEditorIO', () => ({
    getLatestNoteHtml: vi.fn(),
}));

import {
    recoverSimplifiedCitationLabel,
    shouldFetchNoteContext,
} from '../../../react/components/agentRuns/EditNotePreview';

beforeEach(() => {
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) => {
                if (libraryID !== 1) return false;
                if (key === 'ATTACH') return { kind: 'attachment', parentItemID: 10, isAttachment: () => true };
                if (key === 'PARENT') return { kind: 'parent-direct', isAttachment: () => false };
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
});
