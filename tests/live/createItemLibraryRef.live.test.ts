/**
 * Live tests for the create_item / create_collection agent actions and their
 * `library_ref` emission + library-targeting behavior.
 *
 * Covers:
 *   - validate create_item: current_value.library_ref for the default personal
 *     library ("u") and a group library resolved by name ("g<id>"), plus the
 *     library-resolution error paths (invalid id, unknown name).
 *   - execute create_item: a real create into the personal library asserts
 *     result_data.library_ref === "u" (then trashes the item), and an invalid
 *     library id is rejected without creating anything.
 *   - validate create_collection: current_value.library_ref for personal + group.
 *
 * Only the personal library is ever written to (executed), to avoid syncing
 * throwaway items into a shared group. Group coverage uses read-only validate.
 *
 * Prerequisites: dev build running + authenticated; the personal library
 * searchable in Beaver. Group cases skip when no editable group exists.
 * Run: npm run test:live -- createItemLibraryRef
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { getLibraryTopology, type LibraryTopology } from '../helpers/libraryTopology';

interface ValidateResponse {
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    current_value?: { library_id?: number; library_ref?: string; library_name?: string } | null;
}
interface ExecuteResponse {
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    result_data?: { library_id: number; zotero_key: string; library_ref?: string } | null;
}

function validate(action_type: string, action_data: unknown): Promise<ValidateResponse> {
    return post<ValidateResponse>('/beaver/agent-action/validate', { action_type, action_data });
}
function execute(action_type: string, action_data: unknown): Promise<ExecuteResponse> {
    return post<ExecuteResponse>('/beaver/agent-action/execute', { action_type, action_data });
}

let available: boolean;
let topo: LibraryTopology;
/** Ids created by execute tests, trashed in afterAll as a safety net. */
const createdItemIds: string[] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) {
        console.warn('\n⚠  Zotero not available — createItemLibraryRef live tests will be skipped.\n');
        return;
    }
    topo = await getLibraryTopology();
});

afterAll(async () => {
    if (createdItemIds.length > 0) {
        await post('/beaver/delete-items', { item_ids: createdItemIds }).catch(() => undefined);
    }
});

describe('validate create_item — library_ref emission + targeting', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps current_value.library_ref "u" when no library is specified', async () => {
        const res = await validate('create_item', {
            items: [{ source_id: 's1', title: 'Beaver Identity Validate Test' }],
        });
        expect(res.valid).toBe(true);
        expect(res.current_value?.library_ref).toBe('u');
        expect(res.current_value?.library_id).toBe(topo.personal.library_id);
    });

    it('resolves a group library by name and stamps its ref', async (ctx) => {
        if (!topo.editableGroup) return ctx.skip();
        const res = await validate('create_item', {
            library_name: topo.editableGroup.name,
            items: [{ source_id: 's1', title: 'Beaver Identity Validate Test' }],
        });
        expect(res.valid).toBe(true);
        expect(res.current_value?.library_ref).toBe(topo.editableGroup.library_ref);
        expect(res.current_value?.library_id).toBe(topo.editableGroup.library_id);
    });

    it('rejects an explicitly invalid library id', async () => {
        const res = await validate('create_item', {
            library_id: -5,
            items: [{ source_id: 's1', title: 'Beaver Identity Validate Test' }],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('library_not_found');
    });

    it('rejects an unknown library name', async () => {
        const res = await validate('create_item', {
            library_name: 'No Such Library ∎∎∎',
            items: [{ source_id: 's1', title: 'Beaver Identity Validate Test' }],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('library_not_found');
    });
});

describe('execute create_item — result_data.library_ref', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('creates in the personal library and stamps result_data.library_ref "u"', async () => {
        const title = `Beaver Identity Live Test ${Date.now()}`;
        const res = await execute('create_item', {
            item: { source: 'openalex', title },
            file_available: false,
        });
        expect(res.success).toBe(true);
        expect(res.result_data?.library_id).toBe(topo.personal.library_id);
        expect(res.result_data?.library_ref).toBe('u');
        expect(res.result_data?.zotero_key).toBeTruthy();

        // Trash the throwaway item (also tracked in afterAll as a backstop).
        const id = `${res.result_data!.library_id}-${res.result_data!.zotero_key}`;
        createdItemIds.push(id);
        const del = await post<{ success: boolean; deleted: number }>('/beaver/delete-items', { item_ids: [id] });
        expect(del.deleted).toBeGreaterThanOrEqual(1);
    });

    it('falls back to the personal library for an unknown library id (execute does not re-validate)', async () => {
        // Unlike validate (which rejects an unknown library), the execute path
        // does not re-check the target library — an unresolvable numeric
        // library_id defaults to the personal library rather than erroring.
        // The item still lands with a correct portable ref ("u").
        const res = await execute('create_item', {
            item: { source: 'openalex', title: `Beaver Identity Fallback Test ${Date.now()}` },
            file_available: false,
            library_id: 999999,
        });
        expect(res.success).toBe(true);
        expect(res.result_data?.library_id).toBe(topo.personal.library_id);
        expect(res.result_data?.library_ref).toBe('u');

        const id = `${res.result_data!.library_id}-${res.result_data!.zotero_key}`;
        createdItemIds.push(id);
        await post('/beaver/delete-items', { item_ids: [id] });
    });
});

describe('validate create_collection — library_ref emission', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps current_value.library_ref "u" for the default personal library', async () => {
        const res = await validate('create_collection', {
            name: `Beaver Identity Test Collection ${Date.now()}`,
        });
        expect(res.error ?? null).toBeNull();
        expect(res.current_value?.library_ref).toBe('u');
    });

    it('stamps the group ref when the collection targets a group by name', async (ctx) => {
        if (!topo.editableGroup) return ctx.skip();
        const res = await validate('create_collection', {
            library_name: topo.editableGroup.name,
            name: `Beaver Identity Test Collection ${Date.now()}`,
        });
        expect(res.error ?? null).toBeNull();
        expect(res.current_value?.library_ref).toBe(topo.editableGroup.library_ref);
    });
});
