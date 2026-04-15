import { describe, it, expect } from 'vitest';
import {
    preprocessCitations,
    preprocessCitationMatch,
    createPreprocessState,
    CITATION_TAG_PATTERN,
} from '../../../react/utils/citationPreprocessing';

describe('preprocessCitations', () => {
    describe('backtick unwrapping', () => {
        it('unwraps backtick-wrapped opening citation tag', () => {
            const result = preprocessCitations('text `<citation item_id="1-ABC">` more');
            expect(result).toContain('<citation');
            expect(result).not.toContain('`');
        });

        it('unwraps backtick-wrapped self-closing citation tag', () => {
            const result = preprocessCitations('text `<citation item_id="1-ABC"/>` more');
            expect(result).toContain('<citation');
            expect(result).not.toContain('`');
        });

        it('unwraps multiple backtick-wrapped citations', () => {
            const input = '`<citation item_id="1-ABC">` and `<citation item_id="1-DEF">`';
            const result = preprocessCitations(input);
            expect(result).not.toContain('`');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('item_id="1-DEF"');
        });

        it('does not affect citations without backticks', () => {
            const input = 'text <citation item_id="1-ABC"></citation> more';
            const result = preprocessCitations(input);
            expect(result).toContain('item_id="1-ABC"');
        });

        it('does not unwrap non-citation backtick content', () => {
            const input = 'text `some code` more';
            const result = preprocessCitations(input);
            expect(result).toBe('text `some code` more');
        });
    });

    describe('citation tag format handling', () => {
        it('processes self-closing citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC"/>');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('citation_key="zotero:1-ABC"');
        });

        it('processes opening-only citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC">');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('citation_key="zotero:1-ABC"');
        });

        it('processes full pair citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('citation_key="zotero:1-ABC"');
        });

        it('handles single-quoted attributes in citation tags', () => {
            const result = preprocessCitations("<citation item_id='1-ABC' page='5'></citation>");
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('page="5"');
            expect(result).toContain('citation_key="zotero:1-ABC:page=5"');
        });

        it('handles mixed-quote attributes in citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC" page=\'5\'></citation>');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('page="5"');
        });
    });

    describe('attribute normalization', () => {
        it('normalizes attachment_id to att_id', () => {
            const result = preprocessCitations('<citation attachment_id="1-XYZ"></citation>');
            expect(result).toContain('att_id="1-XYZ"');
            expect(result).not.toContain('attachment_id');
        });

        it('generates citation_key with sid and page', () => {
            const result = preprocessCitations(
                '<citation item_id="1-ABC" sid="s0-s8" page="10"></citation>'
            );
            expect(result).toContain('citation_key="zotero:1-ABC:sid=s0-s8:page=10"');
        });

        it('generates external citation key', () => {
            const result = preprocessCitations(
                '<citation external_id="semantic_scholar:123"></citation>'
            );
            expect(result).toContain('citation_key="external:semantic_scholar:123"');
        });
    });

    describe('consecutive and adjacent detection', () => {
        it('marks consecutive citations for same item', () => {
            const state = createPreprocessState();
            const result = preprocessCitations(
                '<citation item_id="1-ABC"></citation> text <citation item_id="1-ABC"></citation>',
                state
            );
            // Second citation should be consecutive
            expect(result).toContain('consecutive="true"');
        });

        it('marks adjacent citations (only whitespace between)', () => {
            const state = createPreprocessState();
            const result = preprocessCitations(
                '<citation item_id="1-ABC"></citation> <citation item_id="1-ABC"></citation>',
                state
            );
            expect(result).toContain('adjacent="true"');
        });

        it('does not mark different items as consecutive', () => {
            const state = createPreprocessState();
            const result = preprocessCitations(
                '<citation item_id="1-ABC"></citation> <citation item_id="1-DEF"></citation>',
                state
            );
            expect(result).not.toContain('consecutive="true"');
        });

        it('preserves lastIdentityKey across segments', () => {
            const state = createPreprocessState();
            preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            // Same identity key across segments = consecutive
            expect(result).toContain('consecutive="true"');
        });

        it('resets lastEndIndex per segment (no false adjacency)', () => {
            const state = createPreprocessState();
            preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            // Cross-segment should be consecutive but NOT adjacent
            expect(result).toContain('consecutive="true"');
            expect(result).not.toContain('adjacent="true"');
        });
    });

    describe('combined backtick + single-quote scenarios', () => {
        it('unwraps backtick-wrapped citation with single-quoted attrs', () => {
            const result = preprocessCitations("`<citation item_id='1-ABC'>`");
            expect(result).not.toContain('`');
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('citation_key="zotero:1-ABC"');
        });

        it('handles inline text with backtick-wrapped single-quoted citation', () => {
            const input = "See `<citation item_id='1-ABC' page='5'>` for details.";
            const result = preprocessCitations(input);
            expect(result).toContain('item_id="1-ABC"');
            expect(result).toContain('page="5"');
            expect(result).not.toContain('`<citation');
        });
    });
});

describe('CITATION_TAG_PATTERN', () => {
    it('matches self-closing tag', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec('<citation item_id="1-ABC"/>');
        expect(match).not.toBeNull();
        expect(match![1]).toContain('item_id="1-ABC"');
    });

    it('matches opening-only tag', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec('<citation item_id="1-ABC">');
        expect(match).not.toBeNull();
        expect(match![1]).toContain('item_id="1-ABC"');
    });

    it('matches full pair', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec('<citation item_id="1-ABC"></citation>');
        expect(match).not.toBeNull();
        expect(match![1]).toContain('item_id="1-ABC"');
    });

    it('matches tag with single-quoted attributes', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec("<citation item_id='1-ABC'></citation>");
        expect(match).not.toBeNull();
        expect(match![1]).toContain("item_id='1-ABC'");
    });

    it('matches tag with mixed-quote attributes', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec('<citation item_id="1-ABC" page=\'5\'/>');
        expect(match).not.toBeNull();
    });
});

describe('preprocessCitationMatch', () => {
    it('returns normalized html with citation_key', () => {
        const state = createPreprocessState();
        const result = preprocessCitationMatch(
            'item_id="1-ABC" page="5"',
            0,
            40,
            '<citation item_id="1-ABC" page="5"></citation>',
            state
        );
        expect(result.attrs).toEqual({ item_id: '1-ABC', page: '5' });
        expect(result.citationKey).toBe('zotero:1-ABC:page=5');
        expect(result.isConsecutive).toBe(false);
        expect(result.isAdjacent).toBe(false);
        expect(result.html).toContain('citation_key="zotero:1-ABC:page=5"');
    });

    it('handles single-quoted attributes', () => {
        const state = createPreprocessState();
        const result = preprocessCitationMatch(
            "item_id='1-ABC' sid='s1'",
            0,
            40,
            "<citation item_id='1-ABC' sid='s1'>",
            state
        );
        expect(result.attrs).toEqual({ item_id: '1-ABC', sid: 's1' });
        expect(result.citationKey).toBe('zotero:1-ABC:sid=s1');
    });

    it('normalizes attachment_id in attributes', () => {
        const state = createPreprocessState();
        const result = preprocessCitationMatch(
            'attachment_id="1-XYZ"',
            0,
            30,
            '<citation attachment_id="1-XYZ">',
            state
        );
        expect(result.attrs).toEqual({ att_id: '1-XYZ' });
        expect(result.html).toContain('att_id="1-XYZ"');
        expect(result.html).not.toContain('attachment_id');
    });
});
