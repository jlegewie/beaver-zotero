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
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
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
