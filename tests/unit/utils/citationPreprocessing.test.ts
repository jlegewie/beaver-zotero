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
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-zotero-key="DEF"');
        });

        it('unwraps adjacent same-item citations sharing one pair of backticks', () => {
            const input = '`<citation att_id="3-ABC" page="5"/><citation att_id="3-ABC" page="12"/>`';
            const result = preprocessCitations(input);
            expect(result).not.toContain('`');
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-loc-value="5"');
            expect(result).toContain('data-loc-value="12"');
        });

        it('unwraps adjacent citations with whitespace inside one pair of backticks', () => {
            const input = '`<citation att_id="3-ABC" page="5"/> <citation att_id="3-DEF" page="12"/>`';
            const result = preprocessCitations(input);
            expect(result).not.toContain('`');
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-zotero-key="DEF"');
        });

        it('does not affect citations without backticks', () => {
            const input = 'text <citation item_id="1-ABC"></citation> more';
            const result = preprocessCitations(input);
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC"');
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
            expect(result).toContain('data-library-id="1"');
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC"');
        });

        it('processes opening-only citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC">');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC"');
        });

        it('processes full pair citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC"');
        });

        it('handles single-quoted attributes in citation tags', () => {
            const result = preprocessCitations("<citation item_id='1-ABC' page='5'></citation>");
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-loc="5"');
            expect(result).toContain('data-loc-kind="page"');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC:5"');
        });

        it('handles mixed-quote attributes in citation tags', () => {
            const result = preprocessCitations('<citation item_id="1-ABC" page=\'5\'></citation>');
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-loc="5"');
        });
    });

    describe('attribute normalization', () => {
        it('normalizes attachment_id to att_id', () => {
            const result = preprocessCitations('<citation attachment_id="1-XYZ"></citation>');
            expect(result).toContain('data-zotero-key="XYZ"');
            expect(result).not.toContain('attachment_id');
        });

        it('generates citation_key with sid and page', () => {
            const result = preprocessCitations(
                '<citation item_id="1-ABC" sid="s0-s8" page="10"></citation>'
            );
            expect(result).toContain('data-loc="s0-s8"');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC:s0-s8"');
        });

        it('generates external citation key', () => {
            const result = preprocessCitations(
                '<citation external_id="semantic_scholar:123"></citation>'
            );
            expect(result).toContain('data-external-id="semantic_scholar:123"');
            expect(result).toContain('data-requested-citation-key="external:semantic_scholar:123"');
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
            expect(result).toContain('data-consecutive="true"');
        });

        it('marks adjacent citations (only whitespace between)', () => {
            const state = createPreprocessState();
            const result = preprocessCitations(
                '<citation item_id="1-ABC"></citation> <citation item_id="1-ABC"></citation>',
                state
            );
            expect(result).toContain('data-adjacent="true"');
        });

        it('does not mark different items as consecutive', () => {
            const state = createPreprocessState();
            const result = preprocessCitations(
                '<citation item_id="1-ABC"></citation> <citation item_id="1-DEF"></citation>',
                state
            );
            expect(result).not.toContain('data-consecutive="true"');
        });

        it('preserves lastIdentityKey across segments', () => {
            const state = createPreprocessState();
            preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            // Same identity key across segments = consecutive
            expect(result).toContain('data-consecutive="true"');
        });

        it('resets lastEndIndex per segment (no false adjacency)', () => {
            const state = createPreprocessState();
            preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            const result = preprocessCitations('<citation item_id="1-ABC"></citation>', state);
            // Cross-segment should be consecutive but NOT adjacent
            expect(result).toContain('data-consecutive="true"');
            expect(result).not.toContain('data-adjacent="true"');
        });
    });

    describe('combined backtick + single-quote scenarios', () => {
        it('unwraps backtick-wrapped citation with single-quoted attrs', () => {
            const result = preprocessCitations("`<citation item_id='1-ABC'>`");
            expect(result).not.toContain('`');
            expect(result).toContain('data-requested-citation-key="zotero:1-ABC"');
        });

        it('handles inline text with backtick-wrapped single-quoted citation', () => {
            const input = "See `<citation item_id='1-ABC' page='5'>` for details.";
            const result = preprocessCitations(input);
            expect(result).toContain('data-zotero-key="ABC"');
            expect(result).toContain('data-loc="5"');
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

    it('matches empty self-closing tag', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        const match = CITATION_TAG_PATTERN.exec('<citation/>');
        expect(match).not.toBeNull();
        expect(match![1]).toBeUndefined();
    });

    it('matches empty full pair and spaced empty tag', () => {
        CITATION_TAG_PATTERN.lastIndex = 0;
        expect(CITATION_TAG_PATTERN.exec('<citation></citation>')).not.toBeNull();
        CITATION_TAG_PATTERN.lastIndex = 0;
        expect(CITATION_TAG_PATTERN.exec('<citation >')).not.toBeNull();
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
        expect(result.citationKey).toBe('zotero:1-ABC:5');
        expect(result.isConsecutive).toBe(false);
        expect(result.isAdjacent).toBe(false);
        expect(result.html).toContain('data-requested-citation-key="zotero:1-ABC:5"');
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
        expect(result.citationKey).toBe('zotero:1-ABC:s1');
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
        expect(result.attrs).toEqual({ attachment_id: '1-XYZ' });
        expect(result.html).toContain('data-zotero-key="XYZ"');
        expect(result.html).not.toContain('attachment_id');
    });

    it('emits invalid marker data for malformed citations', () => {
        const state = createPreprocessState();
        const result = preprocessCitationMatch('id="bad"', 0, 20, '<citation id="bad"/>', state);
        expect(result.html).toContain('data-invalid-reason="invalid_zotero_id"');
        expect(result.html).toContain('data-raw-identity="bad"');
        expect(result.html).toContain('data-identity-attr="id"');
    });
});
