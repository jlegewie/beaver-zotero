/**
 * Validate and execute library-wide tag operations (manage_tags).
 *
 * Supports two actions:
 *   - 'rename': renames a tag. If the new name already exists in the library,
 *     Zotero atomically merges the two tags (via UPDATE OR REPLACE itemTags +
 *     purge). The merge is flagged via `is_merge` for UI and undo awareness.
 *   - 'delete': removes the tag from every item in the library.
 *
 * Both operations snapshot the affected item IDs and the tag's color at
 * validation time so destructive operations (delete, merge-on-rename) can be
 * undone by the user.
 */

import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { getDeferredToolPreference, validateLibraryAccess } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import { logger } from '../../../utils/logger';

// Safety cap: if a tag is on more than this many items, refuse to snapshot the
// set so we don't balloon proposed_data. The agent can still perform the op
// but must confirm with the user via a different flow.
const MAX_SNAPSHOT_ITEMS = 5000;


/**
 * Convert a list of Zotero numeric item IDs to "<libraryID>-<key>" strings.
 */
async function itemIdsToKeys(libraryID: number, itemIDs: number[]): Promise<string[]> {
    if (itemIDs.length === 0) return [];
    const items = await Zotero.Items.getAsync(itemIDs);
    const valid = items.filter((i): i is Zotero.Item => i !== null);
    if (valid.length > 0) {
        await Zotero.Items.loadDataTypes(valid, ['primaryData']);
    }
    return valid.map((item) => `${libraryID}-${item.key}`);
}


/**
 * Result of resolving a user/agent-supplied tag name against Zotero.
 *
 * 'cache'         — found via Zotero.Tags.getID (in-memory map, fast path)
 * 'cache_rebuilt' — initial getID miss, but a fresh Zotero.Tags.init() then
 *                   found the tag. Signals a transient cache desync; caller
 *                   should log this.
 * null tagID      — not found. `suggestions` holds up to 3 case-insensitive
 *                   matches the agent could retry with.
 */
type TagResolution =
    | { tagID: number; source: 'cache' | 'cache_rebuilt' }
    | { tagID: null; suggestions: string[] };


// Shared in-flight rebuild promise. If multiple concurrent callers miss the
// cache at once (e.g. 10 parallel manage_tags calls), they all await the same
// Zotero.Tags.init() rather than queuing N sequential rebuilds.
let _pendingCacheRebuild: Promise<void> | null = null;

function rebuildTagCache(): Promise<void> {
    if (!_pendingCacheRebuild) {
        _pendingCacheRebuild = Zotero.Tags.init()
            .finally(() => {
                _pendingCacheRebuild = null;
            });
    }
    return _pendingCacheRebuild;
}


/**
 * Resolve a tag name to its tagID
 */
async function resolveTagByName(name: string): Promise<TagResolution> {
    const cacheID = Zotero.Tags.getID(name);
    if (cacheID !== false && cacheID != null) {
        return { tagID: cacheID, source: 'cache' };
    }

    // Cache miss → rebuild (shared across concurrent callers) and retry.
    await rebuildTagCache();
    const retryID = Zotero.Tags.getID(name);
    if (retryID !== false && retryID != null) {
        return { tagID: retryID, source: 'cache_rebuilt' };
    }

    // Still missing. Probe case-insensitively for suggestions — init() doesn't
    // help with case typos since getID is exact-case.
    const suggestions: string[] = [];
    await Zotero.DB.queryAsync(
        'SELECT name FROM tags WHERE LOWER(name) = LOWER(?) LIMIT 3',
        [name],
        {
            onRow: (row: any) => {
                suggestions.push(row.getResultByIndex(0) as string);
            },
        },
    );
    return { tagID: null, suggestions };
}


/**
 * Format a "Did you mean" suggestion list for inclusion in an error string.
 * Returns empty string if no suggestions.
 */
function formatSuggestions(suggestions: string[]): string {
    if (suggestions.length === 0) return '';
    if (suggestions.length === 1) return ` Did you mean: '${suggestions[0]}'?`;
    return ` Did you mean: ${suggestions.map((s) => `'${s}'`).join(', ')}?`;
}


export async function validateManageTagsAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { action, name: rawName, new_name: rawNewName, library_id: rawLibraryId, library_name } = request.action_data as {
        action: 'rename' | 'delete';
        name: string;
        new_name?: string | null;
        library_id?: number | null;
        library_name?: string | null;
    };

    const name = (rawName ?? '').trim();
    if (!name) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Tag name cannot be empty',
            error_code: 'invalid_name',
            preference: 'always_ask',
        };
    }

    // Resolve library (int / name / default). We use the generic helper so the
    // behavior matches other handlers.
    const libIdentifier =
        typeof rawLibraryId === 'number' && rawLibraryId > 0
            ? rawLibraryId
            : (library_name ?? null);
    const libValidation = validateLibraryAccess(libIdentifier);
    if (!libValidation.valid) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: libValidation.error,
            error_code: libValidation.error_code,
            preference: 'always_ask',
        };
    }
    const library = libValidation.library!;
    const libraryID = library.libraryID;

    if (!library.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be modified`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Resolve tag ID for the source tag (must exist). On a cache miss we
    // rebuild Zotero.Tags' in-memory map — getID can return false for tags
    // the DB has (list_tags SQL shows them, but _idsByTag is out of sync).
    const resolution = await resolveTagByName(name);
    if (resolution.tagID === null) {
        const hint = formatSuggestions(resolution.suggestions);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Tag not found in library '${library.name}': '${name}'.${hint}`,
            error_code: 'tag_not_found',
            preference: 'always_ask',
        };
    }
    const tagID = resolution.tagID;
    if (resolution.source === 'cache_rebuilt') {
        logger(`manage_tags: cache desync repaired for '${name}' in library ${libraryID} (Zotero.Tags.init rebuilt, tagID=${tagID})`, 1);
    }

    // Validate action-specific fields
    let newName: string | null = null;
    let isMerge = false;
    if (action === 'rename') {
        newName = (rawNewName ?? '').trim();
        if (!newName) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: "action='rename' requires a non-empty new_name",
                error_code: 'invalid_new_name',
                preference: 'always_ask',
            };
        }
        if (newName === name) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'new_name must be different from name',
                error_code: 'invalid_new_name',
                preference: 'always_ask',
            };
        }
        // Merge detection: does new_name already exist in this library?
        const existingTarget = Zotero.Tags.getID(newName);
        isMerge = existingTarget !== false && existingTarget != null;
    } else if (action === 'delete') {
        newName = null;
    } else {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Unsupported action: '${action}'. Use 'rename' or 'delete'.`,
            error_code: 'invalid_action',
            preference: 'always_ask',
        };
    }

    // Count (preview only). The authoritative snapshot for undo is captured
    // at execute time — NOT here — so a re-apply after manual library edits
    // produces a fresh snapshot.
    let itemCount = 0;
    try {
        const ids = await Zotero.Tags.getTagItems(libraryID, tagID);
        itemCount = ids.length;
    } catch (e) {
        logger(`validateManageTagsAction: getTagItems failed: ${e}`, 1);
    }

    if (itemCount > MAX_SNAPSHOT_ITEMS) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Tag '${name}' is used on ${itemCount} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap). Ask the user to perform this operation in Zotero directly.`,
            error_code: 'too_many_items',
            preference: 'always_ask',
        };
    }

    const preference = getDeferredToolPreference('manage_tags');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: libraryID,
            library_name: library.name,
            action,
            name,
            new_name: newName,
            is_merge: isMerge,
            item_count: itemCount,
        },
        // Only resolved scalars go into normalized_action_data. Snapshots are
        // captured at execute time.
        normalized_action_data: {
            library_id: libraryID,
        },
        preference,
    };
}


export async function executeManageTagsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { action, name, new_name, library_id } = request.action_data as {
        action: 'rename' | 'delete';
        name: string;
        new_name?: string | null;
        library_id: number;
    };

    if (!library_id || typeof library_id !== 'number') {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'library_id missing or invalid in action_data',
            error_code: 'invalid_library_id',
        };
    }

    try {
        // Re-snapshot the authoritative pre-apply state at execute time.
        // This ensures a re-apply after manual library edits produces a fresh
        // snapshot that the next undo can correctly reverse.
        const resolution = await resolveTagByName(name);
        const tagID = resolution.tagID;
        if (resolution.tagID !== null && resolution.source === 'cache_rebuilt') {
            logger(`executeManageTagsAction: cache desync repaired for '${name}' in library ${library_id} (Zotero.Tags.init rebuilt, tagID=${tagID})`, 1);
        }

        let affectedItemIds: string[] = [];
        if (tagID !== null) {
            try {
                const ids = await Zotero.Tags.getTagItems(library_id, tagID);
                if (ids.length > MAX_SNAPSHOT_ITEMS) {
                    return {
                        type: 'agent_action_execute_response',
                        request_id: request.request_id,
                        success: false,
                        error: `Tag '${name}' is used on ${ids.length} items (over the ${MAX_SNAPSHOT_ITEMS} safety cap).`,
                        error_code: 'too_many_items',
                    };
                }
                affectedItemIds = await itemIdsToKeys(library_id, ids);
            } catch (e) {
                logger(`executeManageTagsAction: getTagItems snapshot failed: ${e}`, 1);
            }
        }
        const rawColor = Zotero.Tags.getColor(library_id, name);
        const oldColor = rawColor && typeof rawColor === 'object'
            ? { color: (rawColor as any).color, position: (rawColor as any).position }
            : null;

        let isMerge: boolean | null = null;

        if (action === 'rename') {
            const target = (new_name ?? '').trim();
            if (!target) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: "new_name required for rename",
                    error_code: 'invalid_new_name',
                };
            }
            // Re-check merge status at execute time (the tag state may have
            // shifted since validation if the user edited tags manually).
            const existingTarget = Zotero.Tags.getID(target);
            isMerge = existingTarget !== false && existingTarget != null;

            checkAborted(ctx, 'manage_tags:before_rename');
            await Zotero.Tags.rename(library_id, name, target);
            logger(`executeManageTagsAction: Renamed tag '${name}' → '${target}' in library ${library_id}`, 1);
        } else if (action === 'delete') {
            if (tagID === null) {
                // Already gone — treat as success with 0 affected items
                logger(`executeManageTagsAction: Tag '${name}' not found in library ${library_id}; treating as already deleted`, 1);
            } else {
                checkAborted(ctx, 'manage_tags:before_delete');
                // onProgress and types are optional at runtime (see Zotero.Tags.removeFromLibrary
                // JSDoc in tags.js); the .d.ts in zotero-types marks them required. Pass undefined.
                await (Zotero.Tags.removeFromLibrary as any)(library_id, [tagID]);
                logger(`executeManageTagsAction: Deleted tag '${name}' from library ${library_id}`, 1);
            }
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Unsupported action: '${action}'`,
                error_code: 'invalid_action',
            };
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id,
                action,
                name,
                new_name: new_name ?? null,
                items_affected: affectedItemIds.length,
                affected_item_ids: affectedItemIds,
                old_color: oldColor,
                is_merge: isMerge,
            },
        };
    } catch (error) {
        if (error instanceof TimeoutError) {
            throw error;
        }
        logger(`executeManageTagsAction: Failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: 'execution_failed',
        };
    }
}
