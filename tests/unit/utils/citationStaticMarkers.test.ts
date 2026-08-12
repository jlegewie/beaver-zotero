/**
 * A static render (note export) has no effects, so `renderToHTML` precomputes
 * the marker map the live path builds through `processCitationsAtom`. Both must
 * number the same set of sources the same way.
 */
import { describe, expect, it } from 'vitest';
import { computeStaticCitationMarkers } from '../../../react/utils/citationRenderers';
import type { Citation } from '@beaver/agent-core/types/citations';

function citation(overrides: Partial<Citation>): Citation {
    return {
        citation_id: 'c1',
        citation_type: 'item',
        run_id: 'run-1',
        ...overrides,
    };
}

describe('computeStaticCitationMarkers', () => {
    it('numbers each distinct source in tag order', () => {
        const markers = computeStaticCitationMarkers(
            'One<citation id="u-ITEMKEY1"/> two<citation id="u-ITEMKEY2"/> one again<citation id="u-ITEMKEY1"/>',
        );

        expect(markers).toEqual({ 'zotero:u-ITEMKEY1': '1', 'zotero:u-ITEMKEY2': '2' });
    });

    it('merges the requested and resolved identities of one citation', () => {
        const markers = computeStaticCitationMarkers(
            'First<citation id="u-ITEMKEY1"/> then<citation id="u-ITEMKEY2"/>',
            {
                c1: citation({
                    requested_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'ITEMKEY2' },
                    resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'ITEMKEY1' },
                }),
            },
        );

        expect(markers['zotero:u-ITEMKEY1']).toBe('1');
        expect(markers['zotero:u-ITEMKEY2']).toBe('1');
    });

    it('merges a source the text names by library id with its portable identity', () => {
        // A tag written on another device names a library this one cannot map,
        // so it keys on the rowid while the citation keys on the portable ref.
        const markers = computeStaticCitationMarkers(
            'Legacy<citation id="5-ITEMKEY1"/> and portable<citation id="u-ITEMKEY1"/>',
            {
                c1: citation({
                    requested_ref: { kind: 'zotero', library_id: 5, library_ref: 'u', zotero_key: 'ITEMKEY1' },
                    resolved_ref: { kind: 'zotero', library_id: 5, library_ref: 'u', zotero_key: 'ITEMKEY1' },
                }),
            },
        );

        expect(markers['zotero:5-ITEMKEY1']).toBe('1');
        expect(markers['zotero:u-ITEMKEY1']).toBe('1');
    });
});
