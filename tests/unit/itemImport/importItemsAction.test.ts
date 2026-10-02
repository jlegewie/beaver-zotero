import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    checkLibraryExcluded: vi.fn(),
    getDeferredToolPreference: vi.fn(),
    resolveWriteTargetLibrary: vi.fn(),
    resolveCollectionMemberships: vi.fn(),
    writeImportItem: vi.fn(),
    resolve: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: mocks.checkLibraryExcluded,
    excludedLibraryMessage: (id: number) => `Library ${id} is excluded`,
    getDeferredToolPreference: mocks.getDeferredToolPreference,
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `g${id}`),
    resolveWriteTargetLibrary: mocks.resolveWriteTargetLibrary,
    writeTargetLibraryError: (resolution: { code: string; message: string }) => ({
        error: resolution.message,
        error_code: resolution.code === 'library_unavailable' ? 'library_unavailable' : 'library_not_found',
    }),
}));
vi.mock('../../../src/services/collections/collectionMutations', () => ({
    resolveCollectionMemberships: mocks.resolveCollectionMemberships,
}));
vi.mock('../../../src/services/itemImport/write', () => {
    class ImportItemError extends Error {
        constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
            super(message);
        }
    }
    return { ImportItemError, writeImportItem: mocks.writeImportItem };
});

import { ImportItemError } from '../../../src/services/itemImport/write';
import { TimeoutError } from '../../../src/services/agentDataProvider/timeout';
import {
    executeImportItemAction,
    validateImportItemsAction,
} from '../../../src/services/agentDataProvider/actions/importItems';

const Z = Zotero as any;
const ctx = () => ({ signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() });

const validateRequest = (data: Record<string, any>, extra: Record<string, any> = {}) => ({
    type: 'agent_action_validate_request',
    request_id: 'req-1',
    action_type: 'import_item',
    action_data: data,
    ...extra,
}) as any;

const spec = (key: string) => ({ key, source: { kind: 'identifier', input: `doi:${key}` }, identifier: { type: 'doi', value: key } });

let libraryInfo: { name: string; editable: boolean } | undefined;

beforeEach(() => {
    vi.clearAllMocks();
    libraryInfo = { name: 'My Library', editable: true };
    Z.Beaver = {
        libraryScopeInitialized: true,
        searchableLibraryIds: [1, 7],
        itemImport: { resolve: mocks.resolve },
    };
    Z.Libraries.get = vi.fn(() => libraryInfo);
    mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: true, libraryID: 1 });
    mocks.resolveCollectionMemberships.mockReturnValue([]);
    mocks.getDeferredToolPreference.mockReturnValue('always_ask');
    mocks.checkLibraryExcluded.mockReturnValue(null);
    mocks.resolve.mockResolvedValue([{ key: 'a', status: 'resolved', item: { itemType: 'book', title: 'T' } }]);
});

describe('validateImportItemsAction', () => {
    it('rejects a request without items', async () => {
        for (const data of [{}, { items: [] }, { items: 'x' }]) {
            expect(await validateImportItemsAction(validateRequest(data))).toMatchObject({
                valid: false,
                error_code: 'no_items',
                preference: 'always_ask',
            });
        }
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it('rejects when no library is searchable or the scope is not initialized', async () => {
        Z.Beaver.searchableLibraryIds = [];
        expect(await validateImportItemsAction(validateRequest({ items: [spec('a')] })))
            .toMatchObject({ valid: false, error_code: 'no_searchable_libraries' });
        Z.Beaver.searchableLibraryIds = [1];
        Z.Beaver.libraryScopeInitialized = false;
        expect(await validateImportItemsAction(validateRequest({ items: [spec('a')] })))
            .toMatchObject({ valid: false, error_code: 'no_searchable_libraries' });
    });

    it('rejects an unresolvable library target', async () => {
        mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: false, code: 'library_unavailable', message: 'group not on this computer' });
        const response = await validateImportItemsAction(validateRequest({ items: [spec('a')], library_ref: 'g99' }));
        expect(response).toMatchObject({ valid: false, error: 'group not on this computer', error_code: 'library_unavailable' });
    });

    it('rejects a library that does not exist', async () => {
        libraryInfo = undefined;
        const response = await validateImportItemsAction(validateRequest({ items: [spec('a')] }));
        expect(response).toMatchObject({ valid: false, error_code: 'library_not_found' });
    });

    it('rejects an excluded library before resolving anything', async () => {
        mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: true, libraryID: 5 });
        const response = await validateImportItemsAction(validateRequest({ items: [spec('a')], library_id: 5 }));
        expect(response).toMatchObject({ valid: false, error: 'Library 5 is excluded', error_code: 'library_not_searchable' });
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it('rejects a read-only library naming it', async () => {
        libraryInfo = { name: 'Group Archive', editable: false };
        const response = await validateImportItemsAction(validateRequest({ items: [spec('a')] }));
        expect(response).toMatchObject({ valid: false, error_code: 'library_not_editable' });
        expect((response as any).error).toContain('Group Archive');
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it('withholds the resolution when the library was excluded while resolving', async () => {
        mocks.resolve.mockImplementation(async () => {
            Z.Beaver.searchableLibraryIds = [7];
            return [{ key: 'a', status: 'already_in_library', existing_item: { library_id: 1, zotero_key: 'SECRET01' } }];
        });
        const response = await validateImportItemsAction(validateRequest({ items: [spec('a')] }));
        expect(response).toMatchObject({ valid: false, error_code: 'library_not_searchable' });
        expect(JSON.stringify(response)).not.toContain('SECRET01');
    });

    it('fails clearly when the plugin-realm import service is missing', async () => {
        delete Z.Beaver.itemImport;
        expect(await validateImportItemsAction(validateRequest({ items: [spec('a')] })))
            .toMatchObject({ valid: false, error_code: 'item_import_unavailable' });
    });

    it('resolves through the plugin-realm service and returns current_value, normalized data and preference', async () => {
        mocks.resolveCollectionMemberships.mockReturnValue([{ key: 'COLL0001', name: 'Inbox', collectionId: 'u-COLL0001' }]);
        mocks.getDeferredToolPreference.mockReturnValue('always_apply');
        const items = [spec('a')];
        const response: any = await validateImportItemsAction(validateRequest(
            { items, collections: ['Inbox'], tags: ['x'], deadline_ms: 30_000, thread_id: 'thread-1' },
        ));
        expect(mocks.resolve).toHaveBeenCalledWith(items, { libraryID: 1, deadlineMs: 30_000, threadId: 'thread-1' });
        expect(response).toMatchObject({
            type: 'agent_action_validate_response',
            request_id: 'req-1',
            valid: true,
            preference: 'always_apply',
            current_value: {
                library_id: 1,
                library_ref: 'u',
                library_name: 'My Library',
                resolved_collections: [{ key: 'COLL0001', name: 'Inbox', collection_id: 'u-COLL0001' }],
                tags: ['x'],
                items: [{ key: 'a', status: 'resolved' }],
            },
            normalized_action_data: {
                library_id: 1,
                library_ref: 'u',
                collections: ['COLL0001'],
                collection_keys: ['COLL0001'],
                collection_ids: ['u-COLL0001'],
            },
        });
        expect(typeof response.timing.total_ms).toBe('number');
        expect(mocks.getDeferredToolPreference).toHaveBeenCalledWith('import_item', undefined, undefined);
    });

    it('caps the resolution budget and defaults it when missing or invalid', async () => {
        const call = async (deadline_ms: unknown) => {
            mocks.resolve.mockClear();
            await validateImportItemsAction(validateRequest({ items: [spec('a')], deadline_ms }));
            return mocks.resolve.mock.calls[0][1].deadlineMs;
        };
        expect(await call(600_000)).toBe(55_000);
        expect(await call(undefined)).toBe(45_000);
        expect(await call(-5)).toBe(45_000);
        expect(await call('soon')).toBe(45_000);
        expect(await call(10_000)).toBe(10_000);
    });

    it('falls back to the operation thread id when the request has none', async () => {
        await validateImportItemsAction(validateRequest({ items: [spec('a')] }, { operation: { threadId: 'op-thread' } }));
        expect(mocks.resolve.mock.calls[0][1].threadId).toBe('op-thread');
        await validateImportItemsAction(validateRequest({ items: [spec('a')] }));
        expect(mocks.resolve.mock.calls[1][1].threadId).toBeNull();
    });

    it('lets a collection resolution failure propagate', async () => {
        mocks.resolveCollectionMemberships.mockImplementation(() => { throw Object.assign(new Error('no such collection'), { code: 'collection_not_found' }); });
        await expect(validateImportItemsAction(validateRequest({ items: [spec('a')], collections: ['Nope'] })))
            .rejects.toMatchObject({ code: 'collection_not_found' });
        expect(mocks.resolve).not.toHaveBeenCalled();
    });

    it('reports per-item failures inside a valid response', async () => {
        mocks.resolve.mockResolvedValue([
            { key: 'a', status: 'failed', error: { code: 'not_found', message: 'x' } },
            { key: 'b', status: 'already_in_library', existing_item: { library_id: 1, zotero_key: 'EXIST123' } },
        ]);
        const response: any = await validateImportItemsAction(validateRequest({ items: [spec('a'), spec('b')] }));
        expect(response.valid).toBe(true);
        expect(response.current_value.items.map((item: any) => item.status)).toEqual(['failed', 'already_in_library']);
    });
});

describe('executeImportItemAction', () => {
    const executeRequest = (data: Record<string, any>, extra: Record<string, any> = {}) => ({
        type: 'agent_action_execute_request',
        request_id: 'req-2',
        action_id: 'act-1',
        run_id: 'run-1',
        thread_id: 'thread-1',
        action_type: 'import_item',
        action_data: data,
        ...extra,
    }) as any;

    const data = () => ({
        library_id: 1,
        source: { kind: 'identifier', input: 'doi:10.1/x' },
        item: { itemType: 'book', title: 'T' },
    });

    it.each([
        [{}],
        [{ source: { kind: 'identifier', input: 'x' } }],
        [{ item: { itemType: 'book' } }],
    ])('rejects incomplete action data %j', async (incomplete) => {
        const response: any = await executeImportItemAction(executeRequest(incomplete), ctx());
        expect(response).toMatchObject({ success: false, error_code: 'missing_item_data' });
        expect(mocks.writeImportItem).not.toHaveBeenCalled();
    });

    it('accepts a citation-derived action with only pending resolution, or a file-only action', async () => {
        mocks.writeImportItem.mockResolvedValue({ library_id: 1, zotero_key: 'K', attachment_status: 'none' });
        const pending = await executeImportItemAction(executeRequest({
            source: { kind: 'external', input: 'W1' }, pending_resolution: { identifier: { type: 'doi', value: '1' } },
        }), ctx());
        expect(pending.success).toBe(true);
        const fileOnly = await executeImportItemAction(executeRequest({
            source: { kind: 'file', input: 'a.pdf' }, file: { path: '/x/a.pdf' },
        }), ctx());
        expect(fileOnly.success).toBe(true);
    });

    it('fails with the library error when the target cannot be resolved', async () => {
        mocks.resolveWriteTargetLibrary.mockReturnValue({ ok: false, code: 'library_unavailable', message: 'gone' });
        expect(await executeImportItemAction(executeRequest(data()), ctx()))
            .toMatchObject({ success: false, error: 'gone', error_code: 'library_unavailable' });
    });

    it('refuses a library excluded after validation without writing', async () => {
        mocks.checkLibraryExcluded.mockReturnValue({ message: 'Library 1 is excluded' });
        const response: any = await executeImportItemAction(executeRequest(data()), ctx());
        expect(response).toMatchObject({ success: false, error: 'Library 1 is excluded', error_code: 'library_not_searchable' });
        expect(mocks.checkLibraryExcluded).toHaveBeenCalledWith(1);
        expect(mocks.writeImportItem).not.toHaveBeenCalled();
    });

    it('writes the approved item and returns its result data', async () => {
        const result = { library_id: 1, zotero_key: 'ABCD1234', attachment_status: 'pending' };
        mocks.writeImportItem.mockResolvedValue(result);
        const onAttachmentResolved = vi.fn();
        const response: any = await executeImportItemAction(
            executeRequest(data(), { operation: { onAttachmentResolved } }),
            ctx(),
        );
        expect(response).toMatchObject({ type: 'agent_action_execute_response', request_id: 'req-2', success: true, result_data: result });
        const [writtenData, options] = mocks.writeImportItem.mock.calls[0];
        expect(writtenData).toMatchObject({ item: { title: 'T' } });
        expect(options).toMatchObject({
            libraryId: 1,
            actionId: 'act-1',
            runId: 'run-1',
            threadId: 'thread-1',
            onAttachmentResolved,
        });
        expect(typeof response.timing.total_ms).toBe('number');
    });

    it('passes a checkpoint that throws a TimeoutError once the deadline has passed', async () => {
        mocks.writeImportItem.mockResolvedValue({ library_id: 1, zotero_key: 'K', attachment_status: 'none' });
        const expired = { signal: new AbortController().signal, timeoutSeconds: 1, startTime: Date.now() - 5000 };
        await expect(executeImportItemAction(executeRequest(data()), expired)).rejects.toBeInstanceOf(TimeoutError);
        expect(mocks.writeImportItem).not.toHaveBeenCalled();
    });

    it('rethrows a TimeoutError raised during the write', async () => {
        mocks.writeImportItem.mockImplementation(async (_data: unknown, options: { assertCurrent: () => void }) => {
            options.assertCurrent();
            return {};
        });
        const expired = { signal: AbortSignal.abort(), timeoutSeconds: 60, startTime: Date.now() };
        await expect(executeImportItemAction(executeRequest(data()), expired)).rejects.toBeInstanceOf(TimeoutError);
    });

    it('propagates an ImportItemError code', async () => {
        mocks.writeImportItem.mockRejectedValue(new ImportItemError('already_in_library', 'This work is already in your library.'));
        expect(await executeImportItemAction(executeRequest(data()), ctx())).toMatchObject({
            success: false,
            error: 'This work is already in your library.',
            error_code: 'already_in_library',
        });
    });

    it('uses a code carried by other errors, else create_failed', async () => {
        mocks.writeImportItem.mockRejectedValueOnce(Object.assign(new Error('read-only'), { code: 'library_not_editable' }));
        expect(await executeImportItemAction(executeRequest(data()), ctx())).toMatchObject({ error_code: 'library_not_editable' });
        mocks.writeImportItem.mockRejectedValueOnce(new Error(''));
        expect(await executeImportItemAction(executeRequest(data()), ctx()))
            .toMatchObject({ success: false, error: 'Failed to create item', error_code: 'create_failed' });
    });

    it('falls back to the operation thread id', async () => {
        mocks.writeImportItem.mockResolvedValue({ library_id: 1, zotero_key: 'K', attachment_status: 'none' });
        await executeImportItemAction(executeRequest(data(), { thread_id: undefined, operation: { threadId: 'op-thread' } }), ctx());
        expect(mocks.writeImportItem.mock.calls[0][1].threadId).toBe('op-thread');
    });
});
