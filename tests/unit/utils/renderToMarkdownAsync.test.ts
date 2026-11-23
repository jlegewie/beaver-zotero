import { describe, expect, it, vi } from 'vitest';

let releaseLibraryLoad: () => void = () => {};

vi.mock('../../../src/utils/zoteroDataLoading', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/utils/zoteroDataLoading')>()),
    ensureLibraryItemsLoaded: vi.fn(() => new Promise<number[]>((resolve) => {
        releaseLibraryLoad = () => resolve([]);
    })),
}));

import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { store } from '../../../react/store';
import { renderToMarkdown, renderToMarkdownAsync } from '../../../react/utils/citationRenderers';

describe('renderToMarkdownAsync', () => {
    it('renders against the citation state from before libraries finished loading', async () => {
        store.set(externalReferenceMappingAtom, {
            'ext-1': { source_id: 'ext-1', title: 'A Study', year: 2020 } as any,
        });

        const rendered = renderToMarkdownAsync('Claim <citation external_id="ext-1"/>.');
        // Switching chats while the cited libraries load replaces the state.
        store.set(externalReferenceMappingAtom, {});
        releaseLibraryLoad();

        const markdown = await rendered;
        expect(markdown).toContain('A Study');
        expect(markdown).toContain('## Sources');
    });
});

describe('renderToMarkdown', () => {
    it('writes a table cell citation as its paper, with no source entry', () => {
        const tag = '<citation id="u-TABLEKEY" loc="cell:u-PAPERAAA/design"/>';
        const loc = { kind: 'cell' as const, value: 'u-PAPERAAA/design', raw: 'cell:u-PAPERAAA/design' };
        const citation = {
            citation_id: 'c',
            citation_type: 'table' as const,
            requested_ref: { kind: 'zotero' as const, library_id: 1, library_ref: 'u', zotero_key: 'TABLEKEY', loc },
            display_name: 'Smith et al. 2021',
            raw_tag: tag,
            table: { title: 'Study designs', row_label: 'Smith et al. 2021', column_header: 'Design', value: 'Survey' },
        };
        const markdown = renderToMarkdown(`Most are surveys ${tag}.`, {
            citations: [citation],
            citationByKey: { 'zotero:u-TABLEKEY:cell:u-PAPERAAA/design': citation },
            externalReferenceMapping: {},
            externalItemMapping: {},
        });
        expect(markdown).toBe('Most are surveys (Smith et al. 2021).');
    });
});
