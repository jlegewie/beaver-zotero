import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleListItemsRequest: vi.fn(),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
import { registerEndpoints } from '../../../src/services/localEndpoints/http';
import { handleListItemsRequest } from '../../../src/services/agentDataProvider';

let previous: any;
let release: (() => void) | undefined;
beforeEach(() => {
    previous = Zotero.Beaver;
    (Zotero as any).Beaver = { searchableLibraryIds: [1], account: {
        getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'user' } } }),
    } };
    (Zotero as any).Server = { Endpoints: {} };
    release = registerEndpoints();
    vi.mocked(handleListItemsRequest).mockResolvedValue({
        type: 'list_items', request_id: 'req', items: [], total_count: 0,
    } as any);
});
afterEach(() => { release?.(); Zotero.Beaver = previous; });

async function post(data: Record<string, unknown>) {
    const response = await new Zotero.Server.Endpoints['/beaver/library/list']().init({ data });
    expect(response[0]).toBe(200);
    return vi.mocked(handleListItemsRequest).mock.calls.at(-1)![0];
}

it('forwards the children and attachment filters to the list handler', async () => {
    const request = await post({ include_children: true, nest_children: true, has_attachments: true });

    expect(request).toMatchObject({ include_children: true, nest_children: true, has_attachments: true });
});

it('defaults the children and attachment filters to off', async () => {
    const request = await post({});

    expect(request).toMatchObject({ include_children: false, nest_children: false, has_attachments: null });
});
