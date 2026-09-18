import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleItemQuickSearchRequest: vi.fn(),
    handleResolvePopulationRequest: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { registerEndpoints } from '../../../src/services/localEndpoints/http';
import * as handlers from '../../../src/services/agentDataProvider';

let previous: any;
let release: (() => void) | undefined;
beforeEach(() => {
    previous = Zotero.Beaver;
    (Zotero as any).Beaver = { searchableLibraryIds: [1], account: {
        getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'user' } } }),
    } };
    (Zotero as any).Server = { Endpoints: {} };
    release = registerEndpoints();
});
afterEach(() => { release?.(); Zotero.Beaver = previous; });
async function post(path: string) {
    const response = await new Zotero.Server.Endpoints[path]().init({ data: {} });
    expect(response[0]).toBe(200);
    return JSON.parse(response[2]);
}
it.each([
    ['metadata', 'handleItemSearchByMetadataRequest'],
    ['topic', 'handleItemSearchByTopicRequest'],
    ['quick', 'handleItemQuickSearchRequest'],
] as const)('preserves unresolved collection diagnostics over %s HTTP', async (path, handler) => {
    vi.mocked(handlers[handler]).mockResolvedValue({ items: [], unresolved_collections: ['Missing'] } as any);
    expect(await post(`/beaver/search/${path}`)).toMatchObject({ unresolved_collections: ['Missing'] });
});
it('preserves population identities aligned with legacy labels over HTTP', async () => {
    vi.mocked(handlers.handleResolvePopulationRequest).mockResolvedValue({
        item_ids: [], total_count: 0, collection_names: ['Research'], collection_ids: ['g12345-ABCD2345'],
    } as any);
    expect(await post('/beaver/library/resolve-population')).toMatchObject({
        collection_names: ['Research'], collection_ids: ['g12345-ABCD2345'],
    });
});
