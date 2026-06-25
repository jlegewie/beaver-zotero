import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

// The atom module's import chain reaches Zotero APIs at module load
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => true),
    setPref: vi.fn(),
}));

import {
    citationKeyToMarkerAtom,
    citationsAtom,
    citationByKeyAtom,
    citationMapAtom,
    getOrAssignCitationMarkerAtom,
    processCitationsAtom,
} from '../../../react/atoms/citations';
import {
    getCitationBoundingBoxes,
    getCitationPages,
    isExternalCitation,
    isExternalFileCitation,
    isZoteroCitation,
    itemTypeToIconName,
    type Citation,
} from '../../../react/types/citations';

function citation(overrides: Partial<Citation>): Citation {
    return {
        citation_id: overrides.citation_id || 'c1',
        run_id: 'run1',
        ...overrides,
    };
}

describe('citationByKeyAtom', () => {
    it('indexes citations by requested and resolved keys', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'PARENT' },
            raw_tag: '<citation att_id="1-ATTACH" loc="p3"/>',
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['zotero:1-ATTACH:p3']).toBe(data);
        expect(byKey['zotero:1-PARENT:p3']).toBe(data);
        expect(byKey['zotero:1-PARENT']).toBe(data);
    });

    it('does not expose ambiguous base-key fallback', () => {
        const store = createStore();
        const first = citation({
            citation_id: 'c1',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ITEM' },
            raw_tag: '<citation item_id="1-ITEM" page="5"/>',
        });
        const second = citation({
            citation_id: 'c2',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ITEM' },
            raw_tag: '<citation item_id="1-ITEM" page="6"/>',
        });
        store.set(citationsAtom, [first, second]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['zotero:1-ITEM:5']).toBe(first);
        expect(byKey['zotero:1-ITEM:6']).toBe(second);
        expect(byKey['zotero:1-ITEM']).toBeUndefined();
    });

    it('indexes external references under source-qualified and compatibility keys', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            citation_type: 'external_reference',
            resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W1' },
            raw_tag: '<citation external_id="W1" loc="p2"/>',
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['external:W1:p2']).toBe(data);
        expect(byKey['external:openalex:W1:p2']).toBe(data);
    });

    it('indexes raw tag range keys when backend refs carry only the first locator', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            raw_tag: '<citation att_id="1-ATTACH" sid="s343-s345"/>',
            requested_ref: {
                kind: 'zotero',
                library_id: 1,
                zotero_key: 'ATTACH',
                loc: { kind: 'sentence', raw: 's343', value: '343' },
            },
            resolved_ref: {
                kind: 'zotero',
                library_id: 1,
                zotero_key: 'ATTACH',
                loc: { kind: 'sentence', raw: 's343', value: '343' },
            },
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['zotero:1-ATTACH:s343-s345']).toBe(data);
        expect(byKey['zotero:1-ATTACH:s343']).toBe(data);
    });

    it('indexes structured-document sid locator keys from raw tags', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'NLNMPWNQ' },
            raw_tag: '<citation att_id="1-NLNMPWNQ" sid="heading3"/>',
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['zotero:1-NLNMPWNQ:heading3']).toBe(data);
    });

    it('indexes invalid citation fallback keys from normalized raw identity', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            invalid: true,
            raw_tag: '<citation id="bad"/>',
        });
        store.set(citationsAtom, [data]);

        expect(store.get(citationByKeyAtom)['invalid:bad']).toBe(data);
    });

    it('indexes a valid external reference cited with id= under its raw-identity fallback key', () => {
        // The model sometimes writes <citation id="W..."/> instead of
        // external_id="W...". The backend reclassifies it to a valid external
        // reference, but the rendered DOM tag still parses as an invalid Zotero
        // id ("invalid:W..."). The metadata must be reachable under that key.
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            citation_type: 'external_reference',
            invalid: false,
            raw_tag: '<citation id="W158378843"/>',
            requested_ref: { kind: 'external', source: 'openalex', external_id: 'W158378843' },
            resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W158378843' },
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        // Reachable both as a normal external reference and via the raw id= tag.
        expect(byKey['external:openalex:W158378843']).toBe(data);
        expect(byKey['invalid:W158378843']).toBe(data);
    });

    it('indexes external-file citations under extfile keys', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            citation_type: 'external_file',
            display_name: 'paper-draft.pdf',
            requested_ref: { kind: 'external_file', ext_key: 'AB12CD34', loc: { kind: 'page', raw: 'page2', value: '2' } },
            resolved_ref: { kind: 'external_file', ext_key: 'AB12CD34', loc: { kind: 'page', raw: 'page2', value: '2' } },
            raw_tag: '<citation id="ext-AB12CD34" loc="page2"/>',
        });
        store.set(citationsAtom, [data]);

        const byKey = store.get(citationByKeyAtom);
        expect(byKey['extfile:AB12CD34:page2']).toBe(data);
        expect(byKey['extfile:AB12CD34']).toBe(data);
    });
});

describe('citationMapAtom', () => {
    it('derives the citation_id map from the citation list', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ITEM' },
        });
        store.set(citationsAtom, [data]);
        expect(store.get(citationMapAtom)).toEqual({ c1: data });

        // Removal propagates without any explicit map invalidation
        store.set(citationsAtom, []);
        expect(store.get(citationMapAtom)).toEqual({});
    });
});

describe('processCitationsAtom', () => {
    it('aliases requested and resolved marker keys when bases differ', () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, { 'zotero:1-ATTACH': '1' });
        store.set(citationsAtom, [citation({
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATTACH' },
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'PARENT' },
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        store.set(processCitationsAtom);

        const markers = store.get(citationKeyToMarkerAtom);
        expect(markers['zotero:1-ATTACH']).toBe('1');
        expect(markers['zotero:1-PARENT']).toBe('1');
    });

    it('allocates the next marker from existing marker values, not alias key count', () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, { 'zotero:1-ATTACH': '1' });
        store.set(citationsAtom, [citation({
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATTACH' },
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'PARENT' },
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        store.set(processCitationsAtom);

        expect(store.set(getOrAssignCitationMarkerAtom, 'zotero:1-NEXT')).toBe('2');
        expect(store.get(citationKeyToMarkerAtom)).toMatchObject({
            'zotero:1-ATTACH': '1',
            'zotero:1-PARENT': '1',
            'zotero:1-NEXT': '2',
        });
    });

    it('preserves the earliest existing marker when alias keys already have markers', () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, {
            'zotero:1-PARENT': '1',
            'zotero:1-ATTACH': '2',
        });
        store.set(citationsAtom, [citation({
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ATTACH' },
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'PARENT' },
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        store.set(processCitationsAtom);

        expect(store.get(citationKeyToMarkerAtom)).toMatchObject({
            'zotero:1-PARENT': '1',
            'zotero:1-ATTACH': '1',
        });
    });

    it('does not assign markers for invalid citations', () => {
        const store = createStore();
        store.set(citationsAtom, [citation({
            citation_id: 'c1',
            invalid: true,
            raw_tag: '<citation id="bad"/>',
        })]);

        store.set(processCitationsAtom);

        expect(store.get(citationKeyToMarkerAtom)).toEqual({});
    });
});

describe('citation type guards', () => {
    it('classifies citations by their structured refs', () => {
        const zotero = citation({
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ZOTERO' },
        });
        const external = citation({
            resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W123' },
        });
        const externalFile = citation({
            resolved_ref: { kind: 'external_file', ext_key: 'AB12CD34' },
        });

        expect(isZoteroCitation(zotero)).toBe(true);
        expect(isExternalCitation(zotero)).toBe(false);
        expect(isExternalCitation(external)).toBe(true);
        expect(isZoteroCitation(external)).toBe(false);
        expect(isExternalFileCitation(externalFile)).toBe(true);
        expect(isZoteroCitation(externalFile)).toBe(false);
        expect(isExternalCitation(externalFile)).toBe(false);
    });
});

describe('getCitationPages', () => {
    it('combines pages from locations and the pages field', () => {
        const data = citation({
            locations: [
                { part_id: 's1', page_idx: 2 },
                { part_id: 's2', page_idx: 4 },
            ],
            pages: [5, 3],
        });

        expect(getCitationPages(data)).toEqual([3, 5]);
    });
});

describe('getCitationBoundingBoxes', () => {
    it('expands compact quads into bounding boxes with the citation page label', () => {
        const data = citation({
            page_labels: { 1: 'iv' },
            locations: [
                { part_id: 's1', page_idx: 1, boxes: [[1, 2, 3, 4]] },
            ],
        });

        expect(getCitationBoundingBoxes(data)).toEqual([
            {
                page: 2,
                pageLabel: 'iv',
                bboxes: [{ l: 1, t: 2, r: 3, b: 4, coord_origin: 't' }],
            },
        ]);
    });

    it('marks bottom-left legacy boxes with their origin', () => {
        const data = citation({
            locations: [
                { part_id: 's1', page_idx: 0, boxes: [[50, 700, 500, 680]], origin: 'b' },
            ],
        });

        const [first] = getCitationBoundingBoxes(data);
        expect(first.bboxes[0].coord_origin).toBe('b');
    });
});

describe('itemTypeToIconName', () => {
    it('maps item types and attachment content kinds to icon names', () => {
        expect(itemTypeToIconName('journalArticle', undefined)).toBe('journalArticle');
        expect(itemTypeToIconName('attachment', 'pdf')).toBe('attachmentPDF');
        expect(itemTypeToIconName('attachment', 'epub')).toBe('attachmentEPUB');
        expect(itemTypeToIconName('attachment', 'text')).toBe('attachmentFile');
        expect(itemTypeToIconName(undefined, 'pdf')).toBe('document');
    });
});
