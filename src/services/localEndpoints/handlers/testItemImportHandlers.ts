/**
 * Development/staging endpoints for create_items v2 (item import).
 *
 * - `/beaver/test/item-import-resolve`: resolve specs to item JSON (writes nothing).
 * - `/beaver/test/item-import-write`: write `proposed_data` (or undo a `result_data`).
 * - `/beaver/test/item-import-capabilities`: probe states of the internal Zotero APIs.
 *
 * Resolve and write accept a test-only `authorized_folders` override for path
 * imports; `pathAccess` honors it only in development and staging builds.
 */

import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { ImportItemProposedData, ImportItemResultData, ImportItemSpec } from '@beaver/agent-core/types/itemImport';
import { resolveWriteTargetLibrary } from '../../../utils/libraryIdentity';
import { checkLibraryExcluded } from '../../agentDataProvider/utils';
import { setTestAuthorizedFolders } from '../../itemImport/pathAccess';

async function withFolders<T>(threadId: string | undefined, folders: unknown, work: () => Promise<T>): Promise<T> {
    const scope = threadId || '*';
    const list = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string') : null;
    if (list?.length) setTestAuthorizedFolders(scope, list);
    try {
        return await work();
    } finally {
        if (list?.length) setTestAuthorizedFolders(scope, null);
    }
}

export async function handleTestItemImportResolveHttpRequest(request: any) {
    const items: ImportItemSpec[] = Array.isArray(request?.items) ? request.items : [];
    if (!items.length) return { error: 'Provide items: ImportItemSpec[]' };
    const target = resolveWriteTargetLibrary({ library_ref: request.library_ref, library_id: request.library_id });
    if (!target.ok) return { error: target.message, error_code: target.code };
    const excluded = checkLibraryExcluded(target.libraryID);
    if (excluded) return { error: excluded.message, error_code: 'library_excluded' };
    const started = Date.now();
    const resolved = await withFolders(request.thread_id, request.authorized_folders, () =>
        Zotero.Beaver.itemImport.resolve(items, {
            libraryID: target.libraryID,
            deadlineMs: typeof request.deadline_ms === 'number' ? request.deadline_ms : 45_000,
            threadId: request.thread_id ?? null,
            skipDuplicateCheck: request.skip_duplicate_check === true,
        }));
    // The library may have been excluded while resolving.
    const excludedNow = checkLibraryExcluded(target.libraryID);
    if (excludedNow) return { error: excludedNow.message, error_code: 'library_excluded' };
    return { library_id: target.libraryID, elapsed_ms: Date.now() - started, items: resolved };
}

export async function handleTestItemImportWriteHttpRequest(request: any) {
    const operations = Zotero.Beaver.libraryOperations;
    if (request?.undo) {
        const action = { id: 'test-undo', run_id: 'test', action_type: 'import_item', status: 'applied', proposed_data: {}, result_data: request.undo } as AgentAction;
        await operations.run('undoImportItemAction', [action]);
        return { undone: true };
    }
    const proposed = request?.proposed_data as ImportItemProposedData | undefined;
    if (!proposed?.source) return { error: 'Provide proposed_data: ImportItemProposedData (or undo: result_data)' };
    const action = {
        id: request.action_id ?? `test-${Date.now()}`,
        run_id: request.run_id ?? 'test',
        action_type: 'import_item',
        status: 'pending',
        proposed_data: proposed,
    } as AgentAction;
    try {
        const result: ImportItemResultData = await withFolders(request.thread_id, request.authorized_folders, () =>
            operations.run('executeImportItemAction', [action, {
                threadId: request.thread_id,
                libraryId: typeof request.library_id === 'number' ? request.library_id : undefined,
            }]));
        return { result_data: result };
    } catch (error: any) {
        return { error: error?.message ?? String(error), error_code: error?.code, details: error?.details };
    }
}

export async function handleTestItemImportCapabilitiesHttpRequest() {
    return {
        zotero_version: (Zotero as any).version,
        apis: Zotero.Beaver.itemImport.capabilities(),
    };
}
