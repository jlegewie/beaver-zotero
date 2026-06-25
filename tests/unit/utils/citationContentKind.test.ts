import { describe, expect, it } from 'vitest';
import {
    getContentKind,
    getSymbolicLocation,
    type Citation,
} from '../../../react/types/citations';

describe('citation content kind helpers', () => {
    it('defaults citations without a content kind to pdf', () => {
        const citation: Citation = {
            citation_id: 'c1',
            run_id: 'run',
        };
        expect(getContentKind(citation)).toBe('pdf');
    });

    it('derives symbolic locations from non-PDF part locations', () => {
        const citation: Citation = {
            citation_id: 'c2',
            content_kind: 'text',
            locations: [{
                part_id: 'l34',
                line: 34,
                line_end: 38,
                text: 'Preview',
            }],
            run_id: 'run',
        };
        expect(getContentKind(citation)).toBe('text');
        expect(getSymbolicLocation(citation)).toEqual({
            content_kind: 'text',
            line: 34,
            line_end: 38,
            text: 'Preview',
        });
    });

    it('derives epub symbolic locations from section hrefs', () => {
        const citation: Citation = {
            citation_id: 'c3',
            content_kind: 'epub',
            locations: [{
                part_id: 's44',
                section_href: 'ch03.xhtml',
                anchor_id: 'p12',
                text: 'Reader, I married him.',
            }],
            run_id: 'run',
        };
        expect(getSymbolicLocation(citation)).toEqual({
            content_kind: 'epub',
            section_href: 'ch03.xhtml',
            anchor_id: 'p12',
            text: 'Reader, I married him.',
        });
    });
});
