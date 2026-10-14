import { describe, expect, it } from 'vitest';

import { resolvePrintedPageLabels } from '@beaver/agent-core/extract/pageLabels/printedPageLabels';
import { formatCitedPages, formatPrintedPage } from '@beaver/agent-ui/utils/pageLabels';
import { formatPageRangesWithLabels } from '@beaver/agent-ui/utils/pageRanges';

describe('resolvePrintedPageLabels', () => {
    it('returns the derived label of each page', () => {
        expect(resolvePrintedPageLabels({
            pageCount: 3,
            derived: { '0': '1201', '1': '1202', '2': '1203' },
        })).toEqual({ 0: '1201', 1: '1202', 2: '1203' });
    });

    it('ignores embedded labels, with or without derived labels', () => {
        const embedded = { '0': '1', '1': '2', '2': '3' };
        expect(resolvePrintedPageLabels({ pageCount: 3, derived: { '1': '1202' }, embedded }))
            .toEqual({ 1: '1202' });
        expect(resolvePrintedPageLabels({ pageCount: 3, derived: null, embedded })).toEqual({});
        expect(resolvePrintedPageLabels({ pageCount: 3, embedded })).toEqual({});
    });

    it('leaves gaps absent rather than filling them', () => {
        expect(resolvePrintedPageLabels({ pageCount: 5, derived: { '1': '2', '4': '5' } }))
            .toEqual({ 1: '2', 4: '5' });
    });

    it('keeps Roman, prefixed and zero-padded labels verbatim', () => {
        expect(resolvePrintedPageLabels({
            pageCount: 3,
            derived: { '0': 'xii', '1': 'S12', '2': '007' },
        })).toEqual({ 0: 'xii', 1: 'S12', 2: '007' });
    });

    it('keeps duplicate labels on their own pages', () => {
        expect(resolvePrintedPageLabels({ pageCount: 3, derived: { '0': '5', '2': '5' } }))
            .toEqual({ 0: '5', 2: '5' });
    });

    it('returns no labels for an empty derived map', () => {
        expect(resolvePrintedPageLabels({ pageCount: 3, derived: {} })).toEqual({});
    });

    it('drops blank labels, invalid keys and pages past the page count', () => {
        expect(resolvePrintedPageLabels({
            pageCount: 2,
            derived: { '0': ' ', x: '9', '-1': '0', '1': '2', '5': '6' },
        })).toEqual({ 1: '2' });
        expect(resolvePrintedPageLabels({ pageCount: null, derived: { '5': '6' } })).toEqual({ 5: '6' });
    });
});

describe('formatPrintedPage', () => {
    it('shows the printed label when the page has one', () => {
        expect(formatPrintedPage(1, { 1: '1202' }))
            .toEqual({ label: '1202', physical: 2, documentHasLabels: true });
    });

    it('marks a page without a label in a labelled document', () => {
        expect(formatPrintedPage(0, { 1: '1202' }))
            .toEqual({ label: null, physical: 1, documentHasLabels: true });
    });

    it('reports a document without labels as such', () => {
        expect(formatPrintedPage(0, null)).toEqual({ label: null, physical: 1, documentHasLabels: false });
        expect(formatPrintedPage(0, {})).toEqual({ label: null, physical: 1, documentHasLabels: false });
    });
});

describe('formatCitedPages', () => {
    it('shows printed labels and the physical pages they differ from', () => {
        expect(formatCitedPages([3, 4], { 2: '1203', 3: '1204' })).toEqual({
            locator: 'p.1203-1204',
            reference: 'page 1203-1204',
            physicalWhenDifferent: '3-4',
        });
    });

    it('omits the physical pages when the labels equal them', () => {
        expect(formatCitedPages([3], { 2: '3' }).physicalWhenDifferent).toBe('');
    });

    it('uses the distinct PDF form for an unlabelled page of a labelled document', () => {
        expect(formatCitedPages([1], { 1: '1202' })).toEqual({
            locator: 'PDF p.1',
            reference: 'PDF page 1',
            physicalWhenDifferent: '',
        });
        expect(formatCitedPages([1, 2], { 1: '1202' }).locator).toBe('p.1202, PDF p.1');
    });

    it('uses plain physical numbers without labels or with labels turned off', () => {
        expect(formatCitedPages([5, 6], null).locator).toBe('p.5-6');
        expect(formatCitedPages([5], { 4: '1205' }, false)).toEqual({
            locator: 'p.5',
            reference: 'page 5',
            physicalWhenDifferent: '',
        });
    });

    it('returns empty strings without pages', () => {
        expect(formatCitedPages([], { 0: '1' })).toEqual({ locator: '', reference: '', physicalWhenDifferent: '' });
    });
});

describe('formatPageRangesWithLabels', () => {
    it('does not join consecutive pages whose Arabic labels skip numbers', () => {
        expect(formatPageRangesWithLabels([3, 4], ['12', '15'])).toBe('12, 15');
        expect(formatPageRangesWithLabels([3, 4, 5], ['12', '13', '14'])).toBe('12-14');
        expect(formatPageRangesWithLabels([1, 2], ['i', 'ii'])).toBe('i-ii');
    });
});
