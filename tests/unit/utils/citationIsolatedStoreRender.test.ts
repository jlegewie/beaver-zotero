/**
 * The shared `Citation` component reads its state through `useAtomValue`, so it
 * renders against whichever store the surrounding `<Provider>` supplies. Note
 * export depends on that: `renderToHTML` builds an isolated `createStore()`,
 * writes the citation metadata and external-reference mappings into it, and
 * renders to static markup.
 *
 * Two ways that breaks silently, both of which this test covers by driving the
 * real component the way note export does:
 *
 * - Atom identity is by module instance. The mapping atoms live in
 *   `@beaver/agent-core` while the component lives in `@beaver/agent-ui`; if
 *   either side ever resolved a second copy of the module, the component would
 *   subscribe to an atom nobody writes and external references would vanish from
 *   exported notes with no test failing.
 * - A render-time host method (or the component itself) reading a module-global
 *   store instead of the injected one would ignore the isolated store entirely.
 *
 * Rendered without a host registered, which is also the "client supplies no
 * slices" case: the fallbacks have to hold.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import type { Citation as CitationMetadata } from '@beaver/agent-core/types/citations';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import Citation from '@beaver/agent-ui/chat/Citation';

const EXTERNAL_ID = 'W2741809807';

const externalCitation: CitationMetadata = {
    citation_id: 'c1',
    requested_ref: { kind: 'external', external_id: EXTERNAL_ID, source: 'openalex' },
    resolved_ref: { kind: 'external', external_id: EXTERNAL_ID, source: 'openalex' },
    citation_type: 'external',
    display_name: 'Piwowar et al., 2018',
    run_id: 'run-1',
};

const externalReference = {
    source: 'openalex',
    source_id: EXTERNAL_ID,
    title: 'The state of OA',
    authors: ['Heather Piwowar', 'Jason Priem'],
    year: 2018,
    url: 'https://example.org/state-of-oa',
    library_items: [],
} as unknown as ExternalReference;

function renderCitation(store: ReturnType<typeof createStore>): string {
    return renderToStaticMarkup(
        React.createElement(
            Provider,
            { store },
            React.createElement(Citation, {
                'data-external-id': EXTERNAL_ID,
                'data-external-source': 'openalex',
                exportRendering: true,
            }),
        ),
    );
}

describe('Citation under the isolated note-export store', () => {
    it('renders an external reference from mappings written to the isolated store', () => {
        const store = createStore();
        store.set(citationsAtom, [externalCitation]);
        store.set(externalReferenceMappingAtom, { [EXTERNAL_ID]: externalReference });

        const html = renderCitation(store);

        // The URL only exists in externalReferenceMappingAtom, so it can only
        // appear if the component resolved the very atom the store wrote.
        expect(html).toContain('https://example.org/state-of-oa');
        expect(html).toContain('Piwowar et al., 2018');
    });

    it('falls back to plain text when the isolated store carries no mapping', () => {
        const store = createStore();
        store.set(citationsAtom, [externalCitation]);

        const html = renderCitation(store);

        expect(html).toContain('Piwowar et al., 2018');
        expect(html).not.toContain('<a');
    });

    it('derives the label from the external reference before citation metadata arrives', () => {
        const store = createStore();
        store.set(externalReferenceMappingAtom, { [EXTERNAL_ID]: externalReference });

        const html = renderCitation(store);

        expect(html).toContain('https://example.org/state-of-oa');
        expect(html).toContain('Piwowar et al., 2018');
        expect(html).not.toContain('>()</');
    });

    it('never emits empty parentheses when external metadata is unavailable', () => {
        const html = renderCitation(createStore());

        expect(html).toContain(EXTERNAL_ID);
        expect(html).not.toContain('()');
    });

    it('does not leak state between two isolated stores', () => {
        const populated = createStore();
        populated.set(citationsAtom, [externalCitation]);
        populated.set(externalReferenceMappingAtom, { [EXTERNAL_ID]: externalReference });
        renderCitation(populated);

        const empty = createStore();
        empty.set(citationsAtom, [externalCitation]);

        expect(renderCitation(empty)).not.toContain('https://example.org/state-of-oa');
    });
});

describe('web page citations', () => {
    const WEB_ID = 'web-MJNNMKH4ED';
    const page = {
        source: 'exa',
        source_id: WEB_ID,
        title: 'Obesity and overweight',
        url: 'https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight',
        details: { kind: 'webpage', site: 'who.int' },
        library_items: [],
    } as unknown as ExternalReference;

    function renderWebCitation(store: ReturnType<typeof createStore>, webId: string): string {
        return renderToStaticMarkup(
            React.createElement(Provider, { store }, React.createElement(Citation, {
                'data-external-id': webId,
                'data-loc': 'h3',
                'data-loc-kind': 'highlight',
                'data-loc-value': '3',
                exportRendering: true,
            })),
        );
    }

    it('exports a page as a link with its title and site', () => {
        const store = createStore();
        store.set(citationsAtom, [{
            citation_id: 'c1',
            run_id: 'run-1',
            citation_type: 'external_reference',
            requested_ref: { kind: 'external', external_id: WEB_ID },
            resolved_ref: { kind: 'external', external_id: WEB_ID, source: 'exa' },
            raw_tag: `<citation id="${WEB_ID}" loc="h3"/>`,
        } as CitationMetadata]);
        store.set(externalReferenceMappingAtom, { [WEB_ID]: page });

        const html = renderWebCitation(store, WEB_ID);
        expect(html).toContain(page.url);
        expect(html).toContain('who.int');
    });

    it.each(['web-AAAAAAAAAA', 'web-KGXW3ODFN'])('leaves out an invalid citation instead of its raw id (%s)', (typed) => {
        const store = createStore();
        store.set(citationsAtom, [{
            citation_id: 'c1',
            run_id: 'run-1',
            citation_type: 'external_reference',
            invalid: true,
            invalid_reason: 'external_reference_not_found',
            requested_ref: { kind: 'external', external_id: typed },
            raw_tag: `<citation id="${typed}" loc="h3"/>`,
        } as CitationMetadata]);

        expect(renderWebCitation(store, typed)).toBe('');
    });

    it('leaves out a web page the thread has no record of', () => {
        expect(renderWebCitation(createStore(), WEB_ID)).toBe('');
    });

    it('keeps the external style once the page is in the library, since the click still opens the browser', () => {
        const store = createStore();
        store.set(citationsAtom, [{
            citation_id: 'c1',
            run_id: 'run-1',
            citation_type: 'external_reference',
            requested_ref: { kind: 'external', external_id: WEB_ID },
            resolved_ref: { kind: 'external', external_id: WEB_ID, source: 'exa' },
            raw_tag: `<citation id="${WEB_ID}" loc="s3"/>`,
            locations: [{ part_id: 's3', text: 'In 2024, 1 in 7 people were living with obesity.' }],
        } as unknown as CitationMetadata]);
        store.set(externalReferenceMappingAtom, { [WEB_ID]: page });
        store.set(externalReferenceItemMappingAtom, { [WEB_ID]: { library_id: 1, zotero_key: 'ABCD1234' } });

        const html = renderToStaticMarkup(
            React.createElement(Provider, { store }, React.createElement(Citation, {
                'data-external-id': WEB_ID,
                'data-loc': 's3',
                'data-loc-kind': 'sentence',
                'data-loc-value': '3',
            })),
        );
        expect(html).toContain('external-citation');
        expect(html).not.toContain('with-locator');
    });
});
