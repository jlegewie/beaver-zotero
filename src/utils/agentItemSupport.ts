/**
 * Agent-facing item support predicates.
 *
 * These predicates decide which items the Beaver agent and frontend UI treat
 * as supported sources (regular items plus PDF/EPUB/plain-text attachments).
 * They are intentionally separate from the sync predicates in `./sync` — the
 * backend sync/upload path remains PDF-only, while frontend reading supports
 * every content kind the local extraction pipeline can handle.
 *
 * This module must stay React-free (no `react/*`, Jotai store, or transitive
 * imports of them) so esbuild-side callers like `src/modules/zoteroContextMenu.ts`
 * can use it.
 */

import { getReadableContentKind } from '../services/documentExtraction/attachmentResolution';
import { safeFileExists } from './attachmentFiles';
import { safeIsInTrash } from './zoteroItemUtils';
import { isAttachmentOnServer, isAttachmentAvailableRemotely } from './webAPI';
import { getPref } from './prefs';
import { logger } from './logger';

/**
 * True when the item is a kind the agent can work with: a regular item or an
 * attachment whose content the local extraction pipeline can read
 * (PDF/EPUB/plain text).
 */
export const isAgentSupportedItem = (item: Zotero.Item | false): boolean => {
    if (!item) return false;
    if (item.isRegularItem()) return true;
    const kind = getReadableContentKind(item);
    return kind === 'pdf' || kind === 'epub' || kind === 'text';
};

/**
 * Fast, synchronous filter: supported kind, not in trash, and (optionally)
 * member of one of the given collections.
 */
export const agentItemFilter = (item: Zotero.Item | false, collectionIds?: number[]): boolean => {
    if (!item) return false;
    if (!isAgentSupportedItem(item)) return false;
    const trashState = safeIsInTrash(item);
    if (trashState === null) {
        logger(
            `agentItemFilter: Item missing isInTrash, skipping. id=${item?.id ?? 'unknown'} key=${item?.key ?? 'unknown'} library=${item?.libraryID ?? 'unknown'} type=${item?.itemType ?? 'unknown'}`,
            2
        );
        return false;
    }
    if (trashState) return false;
    if (collectionIds) {
        const itemCollections = new Set(item.getCollections());
        return collectionIds.some(id => itemCollections.has(id));
    }
    return true;
};

/**
 * Comprehensive filter adding file availability for attachments.
 *
 * Availability is deliberately broader than the sync filter: besides a local
 * file or a server copy with a synced hash, Beaver can download hashless
 * on-demand attachments (sync state TO_DOWNLOAD / FORCE_DOWNLOAD) when the
 * remote-file-access preference is enabled.
 */
export const agentItemFilterAsync = async (
    item: Zotero.Item | false,
    collectionIds?: number[]
): Promise<boolean> => {
    if (!item) return false;
    if (!agentItemFilter(item, collectionIds)) return false;
    if (item.isRegularItem()) return true;
    if (item.isAttachment()) {
        if (await safeFileExists(item)) return true;
        const remoteAccessible = getPref('accessRemoteFiles') && isAttachmentAvailableRemotely(item);
        // Only PDFs can be read straight from a bare server copy. EPUB and plain
        // text extraction require the actual file, which a remote-only copy only
        // provides through the pref-gated download-on-validate path — so without
        // remote access enabled, a server copy (hash synced) is PDF-only.
        if (getReadableContentKind(item) === 'pdf') {
            return isAttachmentOnServer(item) || remoteAccessible;
        }
        return remoteAccessible;
    }
    return false;
};

/**
 * True iff `item` is a regular item with at least one agent-supported
 * child attachment.
 */
export const hasAgentSupportedAttachment = async (item: Zotero.Item): Promise<boolean> => {
    if (!item.isRegularItem()) return false;
    const attachmentIds = item.getAttachments();
    if (!attachmentIds || attachmentIds.length === 0) return false;
    const attachments = await Zotero.Items.getAsync(attachmentIds);
    return attachments.some((a) => isAgentSupportedItem(a) && !a.deleted);
};
