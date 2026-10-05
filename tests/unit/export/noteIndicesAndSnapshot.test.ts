import { describe, expect, it } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';
import { assignNotePlacements, renderedClusterOrder } from '@beaver/agent-export/citations/noteIndices';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import { buildCitationSnapshot } from '@beaver/agent-export/source/citationSnapshot';

describe('assignNotePlacements', () => {
    it('numbers citation footnotes and markdown footnotes in one sequence', () => {
        const doc = parseExportSource({ title: '', blocks: [{
            type: 'markdown',
            markdown: 'A <citation id="u-AAAAAAAA"/>. B[^x]. C <citation id="u-BBBBBBBB"/>.\n\n[^x]: Inside <citation id="u-CCCCCCCC"/>.',
        }] });
        const placements = assignNotePlacements(doc, () => true);
        // Cluster 2 sits in markdown footnote 2 and does not get its own note.
        expect(Object.fromEntries(placements)).toEqual({
            0: { noteIndex: 1, ownFootnote: true },
            2: { noteIndex: 2, ownFootnote: false },
            1: { noteIndex: 3, ownFootnote: true },
        });
    });

    it('skips clusters that do not create a footnote', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="ext-ABCD1234"/>. B <citation id="u-BBBBBBBB"/>.' }] });
        const placements = assignNotePlacements(doc, index => index === 1);
        expect(placements.get(0)).toBeUndefined();
        expect(placements.get(1)).toEqual({ noteIndex: 1, ownFootnote: true });
    });
});

describe('renderedClusterOrder', () => {
    it('puts citations in a markdown footnote where the footnote is referenced and skips unreferenced ones', () => {
        const doc = parseExportSource({ title: '', blocks: [{
            type: 'markdown',
            markdown: 'A[^x] <citation id="u-AAAAAAAA"/>.\n\n[^x]: Inside <citation id="u-BBBBBBBB"/>.\n\n[^unused]: Never <citation id="u-CCCCCCCC"/>.',
        }] });
        // Clusters are indexed in source order: A=0, footnote=1, unused=2.
        expect(renderedClusterOrder(doc)).toEqual([1, 0]);
    });
});

describe('assignNotePlacements with repeated footnotes', () => {
    it('counts a footnote referenced twice once', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown:
            'A[^n] B[^n] C <citation id="u-AAAAAAAA"/>.\n\n[^n]: Note.' }] });
        expect(assignNotePlacements(doc, () => true).get(0)).toEqual({ noteIndex: 2, ownFootnote: true });
    });
});

describe('buildCitationSnapshot', () => {
    it('keeps only the metadata and external references the blocks cite', () => {
        const cited: Citation = { citation_id: 'a', resolved_ref: { kind: 'external', external_id: 'W9' } };
        const other: Citation = { citation_id: 'b' };
        const snapshot = buildCitationSnapshot({
            blocks: [{ type: 'markdown', markdown: 'x <citation id="u-AAAAAAAA" loc="page2"/>' }],
            citationsByKey: { 'zotero:u-AAAAAAAA:page2': cited, 'zotero:u-ZZZZZZZZ': other },
            externalReferences: { W9: { source: 'openalex', library_items: [] }, W10: { source: 'openalex', library_items: [] } },
            externalItemMapping: { W9: null, W10: null },
        });
        expect(Object.keys(snapshot.citationsByKey)).toEqual(['zotero:u-AAAAAAAA:page2']);
        expect(Object.keys(snapshot.externalReferences)).toEqual(['W9']);
        expect(snapshot.externalItemMapping).toEqual({ W9: null });
    });
});
