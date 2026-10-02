import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/batchFindExistingReferences', () => ({ batchFindExistingReferences: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ libraryRefForLibraryID: vi.fn() }));

import { urlVariants } from '../../../src/services/itemImport/duplicates';

describe('urlVariants', () => {
    it('toggles the trailing slash on the path and the scheme', () => {
        expect(urlVariants('https://example.org/page').sort()).toEqual([
            'http://example.org/page', 'http://example.org/page/', 'https://example.org/page', 'https://example.org/page/',
        ]);
    });

    it('adds the slash to the path, never to the query string', () => {
        const variants = urlVariants('https://example.org/page?id=1');
        expect(variants).toContain('https://example.org/page/?id=1');
        expect(variants).not.toContain('https://example.org/page?id=1/');
        expect(urlVariants('https://example.org/page/?id=1')).toContain('https://example.org/page?id=1');
    });

    it('drops the fragment', () => {
        expect(urlVariants('https://example.org/page#section')).toContain('https://example.org/page');
    });
});
