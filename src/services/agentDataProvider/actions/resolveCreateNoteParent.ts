/**
 * Shared parent-resolution logic for create_note.
 *
 * Only regular items can have child notes in Zotero. This helper takes the
 * caller's `parent_item_id` (format: "<library_id>-<zotero_key>") and resolves
 * it to:
 *   - a regular-item parent_key when one exists in the chain, or
 *   - a null parent_key plus a related_item_key for the standalone-fallback
 *     path (used when the chain ends at a standalone attachment/note).
 *
 * Used by the WS validator (createNote.ts) and by the post-run manual-apply
 * path in react/utils/createNoteActions.ts so both flows behave identically.
 */

import { parseItemReference, resolveItemReference } from '../../../utils/libraryIdentity';

export type CreateNoteParentErrorCode =
    | 'invalid_parent_id'
    | 'library_unavailable'
    | 'item_not_found'
    | 'invalid_parent_type';

export interface CreateNoteParentResolution {
    ok: true;
    /** zotero_key of a regular item to parent the note to, or null for standalone */
    parentKey: string | null;
    /** resolved library ID when rawParentItemId was provided; null otherwise */
    resolvedLibraryId: number | null;
    /** key of the item to add as a related item when parentKey is null (standalone fallback) */
    relatedItemKey: string | null;
    /** human-readable warning to surface to the user/agent, if the fallback path was taken */
    warning: string | null;
}

export interface CreateNoteParentResolutionError {
    ok: false;
    error: string;
    errorCode: CreateNoteParentErrorCode;
}

export type CreateNoteParentResult =
    | CreateNoteParentResolution
    | CreateNoteParentResolutionError;


/**
 * Resolve `parent_item_id` to a concrete parentKey (regular item) or standalone fallback.
 *
 * Returns `{ ok: true, parentKey: null, ... }` when `rawParentItemId` is falsy.
 */
export async function resolveCreateNoteParent(
    rawParentItemId: string | null | undefined,
    parentLibraryRef?: string | null,
): Promise<CreateNoteParentResult> {
    if (!rawParentItemId) {
        return {
            ok: true,
            parentKey: null,
            resolvedLibraryId: null,
            relatedItemKey: null,
            warning: null,
        };
    }

    // Accept both the portable "<library_ref>-<zotero_key>" grammar and the
    // legacy "<library_id>-<zotero_key>" numeric grammar.
    const parsedId = parseItemReference(rawParentItemId);
    if (!parsedId) {
        return {
            ok: false,
            error: `Invalid parent_item_id format: "${rawParentItemId}". Expected "<library_ref>-<zotero_key>" or "<library_id>-<zotero_key>"`,
            errorCode: 'invalid_parent_id',
        };
    }

    // A library_ref embedded in the id string is what the model actually
    // said, so it wins over the separately-supplied parentLibraryRef. The
    // parameter only applies as a fallback for a legacy numeric id, which
    // carries no ref of its own.
    const resolved = await resolveItemReference({
        library_ref: parsedId.library_ref ?? parentLibraryRef,
        library_id: parsedId.library_id,
        zotero_key: parsedId.zotero_key,
    });
    if (resolved.status === 'library_unavailable') {
        return {
            ok: false,
            error: `Parent item library is not available on this computer: ${rawParentItemId}`,
            errorCode: 'library_unavailable',
        };
    }
    if (resolved.status === 'not_found') {
        return {
            ok: false,
            error: `Parent item not found: ${rawParentItemId}`,
            errorCode: 'item_not_found',
        };
    }
    const item = resolved.item;
    const resolvedLibraryId = item.libraryID;

    if (item.isRegularItem()) {
        return {
            ok: true,
            parentKey: item.key,
            resolvedLibraryId,
            relatedItemKey: null,
            warning: null,
        };
    }

    if (item.isAttachment() || item.isNote()) {
        if (item.parentKey) {
            return {
                ok: true,
                parentKey: item.parentKey,
                resolvedLibraryId,
                relatedItemKey: null,
                warning: null,
            };
        }
        const kind = item.isAttachment() ? 'attachment' : 'note';
        return {
            ok: true,
            parentKey: null,
            resolvedLibraryId,
            relatedItemKey: item.key,
            warning: `Parent ${rawParentItemId} is a standalone ${kind} and cannot have child notes; created a standalone note related to it instead.`,
        };
    }

    if (item.isAnnotation()) {
        // Annotation -> attachment -> (optional) regular item.
        // Use async lookup so we don't rely on the parent already being in the
        // item cache — background validation may hit annotations whose parent
        // attachment hasn't been loaded.
        const parentAttachmentID = item.parentID;
        if (!parentAttachmentID) {
            return {
                ok: false,
                error: `Annotation ${rawParentItemId} has no valid parent attachment`,
                errorCode: 'invalid_parent_type',
            };
        }
        let parentAttachment: Zotero.Item | false;
        try {
            parentAttachment = (await Zotero.Items.getAsync(parentAttachmentID)) ?? false;
        } catch {
            parentAttachment = false;
        }
        if (!parentAttachment || !parentAttachment.isAttachment()) {
            return {
                ok: false,
                error: `Annotation ${rawParentItemId} has no valid parent attachment`,
                errorCode: 'invalid_parent_type',
            };
        }
        if (parentAttachment.parentKey) {
            return {
                ok: true,
                parentKey: parentAttachment.parentKey,
                resolvedLibraryId,
                relatedItemKey: null,
                warning: null,
            };
        }
        return {
            ok: true,
            parentKey: null,
            resolvedLibraryId,
            relatedItemKey: parentAttachment.key,
            warning: `Parent ${rawParentItemId} is an annotation on a standalone attachment and cannot have child notes; created a standalone note related to the attachment instead.`,
        };
    }

    return {
        ok: false,
        error: `Parent ${rawParentItemId} has an unsupported item type for note creation`,
        errorCode: 'invalid_parent_type',
    };
}
