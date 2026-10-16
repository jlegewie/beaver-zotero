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
import { renderToMarkdownAsync } from '../../../react/utils/citationRenderers';

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
