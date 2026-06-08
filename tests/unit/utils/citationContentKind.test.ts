import { describe, expect, it } from 'vitest';
import {
    getContentKind,
    getSymbolicLocation,
    type CitationMetadata,
} from '../../../react/types/citations';

describe('citation content kind helpers', () => {
    it('defaults historical citations to pdf', () => {
        const citation: CitationMetadata = {
            citation_id: 'c1',
            parts: [],
            run_id: 'run',
        };
        expect(getContentKind(citation)).toBe('pdf');
    });

    it('returns symbolic locations for non-PDF citation parts', () => {
        const citation: CitationMetadata = {
            citation_id: 'c2',
            content_kind: 'text',
            parts: [{
                part_id: 'l34',
                symbolic_location: {
                    content_kind: 'text',
                    line: 34,
                    line_end: 38,
                    text: 'Preview',
                },
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
});
