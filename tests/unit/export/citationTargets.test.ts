import { describe, expect, it } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';
import { formatLocator, resolveCitationTarget } from '@beaver/agent-export/citations/citationTargets';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import type { CitationSnapshot } from '@beaver/agent-export/types';

function occurrence(tag: string) {
    return parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: `x ${tag}` }] }).clusters[0].items[0];
}

function snapshot(partial: Partial<CitationSnapshot> = {}): CitationSnapshot {
    return { citationsByKey: {}, externalReferences: {}, externalItemMapping: {}, pageLabelsByAttachmentId: {}, ...partial };
}

describe('resolveCitationTarget', () => {
    it('resolves a library citation with a written page locator when there is no metadata', () => {
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="page12-14"/>'), snapshot());
        expect(target).toMatchObject({ kind: 'zotero', libraryRef: 'u', zoteroKey: 'AAAAAAAA' });
        expect(target.kind === 'zotero' && formatLocator(target.locator!)).toBe('12-14');
    });

    it('takes pages and labels from the metadata of the exact tag', () => {
        const citation: Citation = {
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'sentence', value: '5', raw: 's5' } },
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            pages: [3, 4],
            page_labels: { 2: 'iii', 3: 'iv' },
            display_name: 'Smith 2004',
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="s5"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA:s5': citation } }));
        expect(target.kind).toBe('zotero');
        if (target.kind === 'zotero') expect(formatLocator(target.locator!)).toBe('iii-iv');
    });

    it('leaves the locator without labels when the metadata labels are all empty', () => {
        const citation: Citation = {
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'sentence', value: '5', raw: 's5' } },
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            pages: [11],
            page_labels: { 10: '' },
            display_name: 'Smith 2004',
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="s5"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA:s5': citation } }));
        expect(target.kind === 'zotero' && target.locator?.labels).toBeNull();
    });

    it('does not give a locator-free citation the pages of a page-specific alias', () => {
        // The only metadata for the work is page-specific; lookup maps also file it under the base key.
        const citation: Citation = {
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'page', value: '9', raw: 'page9' } },
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            pages: [9],
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA:page9': citation, 'zotero:u-AAAAAAAA': citation } }));
        expect(target).toMatchObject({ kind: 'zotero', locator: null });
    });

    it('keeps the work\'s content kind when its passage metadata does not apply', () => {
        // Snapshot metadata for another passage, found only by the base key.
        const citation: Citation = {
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'paragraph', value: '3', raw: 'p3' } },
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            content_kind: 'snapshot',
            pages: [1],
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="page4"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA': citation } }));
        expect(target).toMatchObject({ kind: 'zotero', locator: null });
    });

    it('shows a written EPUB locator only when its sections have printed labels', () => {
        const citation: Citation = {
            citation_id: 'c1',
            requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA', loc: { kind: 'paragraph', value: '3', raw: 'p3' } },
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            content_kind: 'epub',
            pages: [2],
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="page4"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA': citation } }));
        expect(target.kind).toBe('zotero');
        if (target.kind !== 'zotero') return;
        expect(formatLocator(target.locator!)).toBeUndefined();
        expect(formatLocator(target.locator!, { 3: '57' })).toBe('57');
    });

    it('keeps the gap in a sentence list that skips pages', () => {
        const metadata = (loc: string, pages: number[]): Citation => ({
            citation_id: loc,
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            pages,
        });
        const locator = (loc: string, pages: number[]) => {
            const target = resolveCitationTarget(occurrence(`<citation id="u-AAAAAAAA" loc="${loc}"/>`),
                snapshot({ citationsByKey: { [`zotero:u-AAAAAAAA:${loc}`]: metadata(loc, pages) } }));
            return target.kind === 'zotero' ? formatLocator(target.locator!) : null;
        };
        expect(locator('s5.2,s9.4', [5, 9])).toBe('5, 9');
        expect(locator('s5.2-s9.4', [5, 9])).toBe('5-9');
    });

    it('does not borrow pages from metadata found only by the base key', () => {
        const citation: Citation = {
            citation_id: 'c1',
            resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAAA' },
            pages: [9],
        };
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="s7"/>'),
            snapshot({ citationsByKey: { 'zotero:u-AAAAAAAA': citation } }));
        expect(target.kind === 'zotero' && target.locator).toBeNull();
    });

    it('cites the library item an external reference was imported as', () => {
        const target = resolveCitationTarget(occurrence('<citation external_id="W1"/>'), snapshot({
            externalItemMapping: { W1: { library_id: 1, library_ref: 'u', zotero_key: 'BBBBBBBB' } },
        }));
        expect(target).toMatchObject({ kind: 'zotero', zoteroKey: 'BBBBBBBB' });
    });

    it('returns external references and external files as such', () => {
        const reference = { source: 'openalex' as const, title: 'Paper', library_items: [] };
        expect(resolveCitationTarget(occurrence('<citation external_id="W2"/>'), snapshot({ externalReferences: { W2: reference } })))
            .toMatchObject({ kind: 'external', externalId: 'W2', reference });
        expect(resolveCitationTarget(occurrence('<citation id="ext-ABCD1234" loc="page2"/>'), snapshot()))
            .toMatchObject({ kind: 'external_file', extKey: 'ABCD1234', displayName: 'ext-ABCD1234' });
    });

    it('treats invalid metadata as unresolved', () => {
        const citation: Citation = { citation_id: 'c', invalid: true, raw_tag: '<citation id="garbage"/>', display_name: 'Lost' };
        const target = resolveCitationTarget(occurrence('<citation id="garbage"/>'),
            snapshot({ citationsByKey: { 'invalid:garbage': citation } }));
        expect(target).toEqual({ kind: 'unresolved', displayName: 'Lost' });
    });
});

describe('formatLocator', () => {
    it('collapses consecutive pages and prefers labels, overriding metadata labels', () => {
        const spec = { pages: [1, 2, 3, 7], labels: null, inclusiveRange: false, labelsOnly: false };
        expect(formatLocator(spec)).toBe('1-3, 7');
        expect(formatLocator(spec, { 0: 'i', 1: 'ii', 2: '1', 6: '5' })).toBe('i-ii, 1, 5');
    });

    it('collapses only labels that are consecutive in one sequence', () => {
        const spec = { pages: [1, 2, 3, 4, 5], labels: null, inclusiveRange: false, labelsOnly: false };
        expect(formatLocator(spec, { 0: 'iv', 1: 'v', 2: 'S1', 3: '10', 4: '12' })).toBe('iv-v, S1, 10, 12');
    });

    it('writes an inclusive span as a range only when its labels span the cited pages', () => {
        const spec = { pages: [5, 7], labels: null, inclusiveRange: true, labelsOnly: false };
        expect(formatLocator(spec)).toBe('5-7');
        expect(formatLocator(spec, { 4: '1205', 6: '1207' })).toBe('1205-1207');
        expect(formatLocator(spec, { 4: 'iv', 6: 'vi' })).toBe('iv-vi');
        // One end has no printed label: cite the printed end.
        expect(formatLocator(spec, { 4: '1205' })).toBe('1205');
        expect(formatLocator(spec, { 6: '1207' })).toBe('1207');
        // Two numberings: no invented range.
        expect(formatLocator(spec, { 4: 'xii', 6: '1' })).toBe('xii');
    });

    it('lists only printed pages when some cited pages have printed labels', () => {
        const spec = { pages: [11, 12], labels: null, inclusiveRange: false, labelsOnly: false };
        // Physical page 12 has no printed label; "12, 12" would mix numberings.
        expect(formatLocator(spec, { 10: '12' })).toBe('12');
        expect(formatLocator({ ...spec, pages: [12, 13] }, { 11: '12' })).toBe('12');
        expect(formatLocator(spec)).toBe('11-12');
    });

    it('keeps spans and runs of prefixed labels that share a prefix', () => {
        const span = { pages: [5, 7], labels: null, inclusiveRange: true, labelsOnly: false };
        expect(formatLocator(span, { 4: 'S12', 6: 'S14' })).toBe('S12-S14');
        expect(formatLocator(span, { 4: 'A-3', 6: 'A-5' })).toBe('A-3-A-5');
        expect(formatLocator(span, { 4: 'S12', 6: 'T14' })).toBe('S12');
        expect(formatLocator(span, { 4: 'S12', 6: '14' })).toBe('S12');

        const run = { pages: [5, 6, 7], labels: null, inclusiveRange: false, labelsOnly: false };
        expect(formatLocator(run, { 4: 'S12', 5: 'S13', 6: 'S14' })).toBe('S12-S14');
    });

    it('shows only labelled pages for EPUB-like locators', () => {
        expect(formatLocator({ pages: [4], labels: null, inclusiveRange: false, labelsOnly: true })).toBeUndefined();
    });

    it('keeps written page locators as written, with labels for their numbers', () => {
        const target = resolveCitationTarget(occurrence('<citation id="u-AAAAAAAA" loc="page1-150,200"/>'), snapshot());
        const spec = target.kind === 'zotero' ? target.locator! : null;
        expect(formatLocator(spec!)).toBe('1-150, 200');
        // Page 150 has no label: the range cites its printed start rather
        // than mixing numberings ("i-150").
        expect(formatLocator(spec!, { 0: 'i', 199: '190' })).toBe('i, 190');
    });

    it('writes an explicit range with labels only when they span the written pages', () => {
        const written = (loc: string) => {
            const target = resolveCitationTarget(occurrence(`<citation id="u-AAAAAAAA" loc="${loc}"/>`), snapshot());
            return target.kind === 'zotero' ? target.locator! : null;
        };
        // An unnumbered cover before printed page 1201.
        expect(formatLocator(written('page1-2')!, { 1: '1201' })).toBe('1201');
        expect(formatLocator(written('page2-3')!, { 1: '1201', 2: '1202' })).toBe('1201-1202');
        expect(formatLocator(written('page2-4')!, { 1: '1201', 3: '1205' })).toBe('1201');
        expect(formatLocator(written('page5-6')!, { 1: '1201' })).toBe('5-6');
    });
});
