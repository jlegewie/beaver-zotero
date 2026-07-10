/**
 * Unit tests for create_collection validate + execute handlers, focused on
 * dual-form item_ids[] parsing (portable "<library_ref>-<key>" vs legacy
 * "<library_id>-<key>") and the same-library mismatch check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 100]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} excluded`),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import {
    validateCreateCollectionAction,
    executeCreateCollectionAction,
} from '../../../src/services/agentDataProvider/actions/createCollection';
import type { WSAgentActionValidateRequest, WSAgentActionExecuteRequest } from '../../../src/services/agentProtocol';

function makeItem(libraryID: number, key: string) {
    return {
        id: `${libraryID}:${key}`,
        libraryID,
        key,
        isAttachment: () => false,
        isNote: () => false,
        isAnnotation: () => false,
    };
}

function buildValidateRequest(actionData: Record<string, any>): WSAgentActionValidateRequest {
    return {
        type: 'agent_action_validate_request',
        request_id: 'req-1',
        action_type: 'create_collection',
        action_data: actionData,
    } as unknown as WSAgentActionValidateRequest;
}

describe('validateCreateCollectionAction', () => {
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: {
                get: vi.fn((id: number) =>
                    id === 1 || id === 100
                        ? { libraryID: id, name: id === 1 ? 'My Library' : 'Group Library', editable: true }
                        : null
                ),
                getAll: vi.fn(() => [
                    { libraryID: 1, name: 'My Library', editable: true },
                    { libraryID: 100, name: 'Group Library', editable: true },
                ]),
                userLibraryID: 1,
            },
            // Group 12345 <-> local library 100. Any other group id is unknown.
            Groups: {
                getGroupIDFromLibraryID: vi.fn((libId: number) => (libId === 100 ? 12345 : false)),
                getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
            },
            Collections: {
                getByLibraryAndKeyAsync: vi.fn(async () => null),
            },
            Items: {
                getByLibraryAndKeyAsync: vi.fn(async (libId: number, key: string) => makeItem(libId, key)),
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('accepts a portable "u-<key>" item_id resolving to the default (personal) target library', async () => {
        const res = await validateCreateCollectionAction(
            buildValidateRequest({ name: 'New Collection', item_ids: ['u-ABCD1234'] })
        );
        expect(res.valid).toBe(true);
    });

    it('accepts a portable "g<id>-<key>" item_id resolving to a matching group target library', async () => {
        const res = await validateCreateCollectionAction(
            buildValidateRequest({
                library_ref: 'g12345',
                name: 'New Collection',
                item_ids: ['g12345-GRPITEM1'],
            })
        );
        expect(res.valid).toBe(true);
    });

    it('accepts a legacy numeric item_id matching the target library', async () => {
        const res = await validateCreateCollectionAction(
            buildValidateRequest({ name: 'New Collection', item_ids: ['1-ABCD1234'] })
        );
        expect(res.valid).toBe(true);
    });

    it('rejects an item_id resolving to a different library with item_library_mismatch', async () => {
        // item_ids resolves to library 100 (group), but the target defaults
        // to the personal library (1) since no library params were given.
        const res = await validateCreateCollectionAction(
            buildValidateRequest({ name: 'New Collection', item_ids: ['g12345-GRPITEM1'] })
        );
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('item_library_mismatch');
    });

    it('rejects an unresolvable portable group item_id with library_unavailable, not a mismatch', async () => {
        const res = await validateCreateCollectionAction(
            buildValidateRequest({ name: 'New Collection', item_ids: ['g99999-ZZZZ0000'] })
        );
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('library_unavailable');
    });

    it('rejects a malformed item_id', async () => {
        const res = await validateCreateCollectionAction(
            buildValidateRequest({ name: 'New Collection', item_ids: ['not-valid-###'] })
        );
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_item_id');
    });
});

describe('executeCreateCollectionAction', () => {
    const ctx: any = { signal: { aborted: false }, timeoutSeconds: 25, startTime: Date.now() };
    let previousZotero: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Libraries: {
                get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
                userLibraryID: 1,
            },
            Collection: vi.fn(function (this: any, params: any) {
                this.name = params.name;
                this.libraryID = params.libraryID;
                this.parentID = params.parentID;
                this.key = 'NEWCOLL1';
                this.saveTx = vi.fn(async () => undefined);
                this.eraseTx = vi.fn(async () => undefined);
                this.addItems = vi.fn(async () => undefined);
            }),
            Collections: { getByLibraryAndKeyAsync: vi.fn(async () => null) },
            Items: {
                getByLibraryAndKeyAsync: vi.fn(async (libId: number, key: string) => makeItem(libId, key)),
            },
            DB: {
                executeTransaction: vi.fn(async (fn: any) => fn()),
            },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    function buildExecuteRequest(actionData: Record<string, any>): WSAgentActionExecuteRequest {
        return {
            type: 'agent_action_execute_request',
            request_id: 'e1',
            action_type: 'create_collection',
            action_data: actionData,
        } as unknown as WSAgentActionExecuteRequest;
    }

    it('adds items resolved via both portable and legacy item_id forms', async () => {
        const res = await executeCreateCollectionAction(
            buildExecuteRequest({ name: 'New Collection', item_ids: ['u-ABCD1234', '1-EFGH5678'] }),
            ctx
        );
        expect(res.success).toBe(true);
        expect(res.result_data?.items_added).toBe(2);
    });

    it('skips an item_id whose portable library ref is unresolvable on this device', async () => {
        const res = await executeCreateCollectionAction(
            buildExecuteRequest({ name: 'New Collection', item_ids: ['u-ABCD1234', 'g99999-ZZZZ0000'] }),
            ctx
        );
        expect(res.success).toBe(true);
        expect(res.result_data?.items_added).toBe(1);
    });
});
