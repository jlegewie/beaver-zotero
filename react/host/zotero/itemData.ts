import { type PageLabelsByAttachmentId } from '../../atoms/citations';
import { getBestPDFAttachment } from '../../../src/utils/zoteroItemHelpers';
import { getLibraryByIdOrName, getCollectionByIdOrName } from '../../../src/services/agentDataProvider/utils';
import type { CitationRef } from '../../utils/citationGrammar';
import type { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import type { ItemDataHost, ResolvedItemDisplay } from '../types';

/**
 * Bibliographic display name for a tool-call header label.
 *
 * - Notes → the note's own title.
 * - Attachments → the parent item's "Author Year" identity.
 * - Regular items → their own "Author Year" identity.
 *
 * Loads the data types it reads (Zotero lazy-loads field/creator data), so it is
 * reliable even for items not preloaded by the live-run path.
 */
async function resolveDisplayName(item: Zotero.Item): Promise<string | undefined> {
    if (item.isNote()) {
        // A note's title lives in itemData: getNoteTitle() reads _noteTitle, which
        // is populated by the itemData load (the 'note' data type only loads the
        // full note body and would leave getNoteTitle() throwing UnloadedDataException).
        await item.loadDataType('itemData').catch(() => {});
        const title = item.getNoteTitle?.();
        return title || undefined;
    }
    let target = item;
    if (item.isAttachment() && item.parentItemID) {
        target = await Zotero.Items.getAsync(item.parentItemID) || item;
    }
    await Zotero.Items.loadDataTypes([target], ['itemData', 'creators']).catch(() => {});
    const firstCreator = target.firstCreator || 'Unknown';
    const year = target.getField('date')?.match(/\d{4}/)?.[0] || '';
    return `${firstCreator}${year ? ` ${year}` : ''}`;
}

/**
 * Resolve the page-label map (0-based page index -> printed label) for a Zotero
 * item, preferring its best PDF attachment. Returns null when no labels have
 * been preloaded for the attachment.
 *
 * Used both by the item-data host (render-time fallback) and by the Zotero-only
 * click/export paths in the citation component.
 */
export function getPageLabelsForItem(
    item: Zotero.Item,
    labelsByAttachmentId: PageLabelsByAttachmentId,
): Record<number, string> | null {
    const attachment = item.isAttachment() ? item : getBestPDFAttachment(item);
    if (!attachment) return null;
    return labelsByAttachmentId[attachment.id] ?? null;
}

/** Zotero implementation of {@link ItemDataHost}. */
export const zoteroItemData: ItemDataHost = {
    resolvePageLabels(
        ref: CitationRef,
        labelsByAttachmentId: PageLabelsByAttachmentId,
    ): Record<number, string> | null {
        if (ref.kind !== 'zotero') return null;
        // A group citation carries a device-local library_id of
        // UNRESOLVED_LIBRARY_ID — its identity is the portable library_ref.
        // Resolve to this device's local library id (null when the library
        // isn't on this device) so group citations still get page labels.
        // No exclusion gate here: rendering persisted history is not gated on
        // library exclusion, and as a render-time host method this must not
        // read the module-global store (resolveLibraryRef only touches Zotero
        // globals, so it is safe under the isolated note-export store).
        const libraryId = resolveLibraryRef(ref);
        if (!libraryId) return null;
        try {
            const item = Zotero.Items.getByLibraryAndKey(libraryId, ref.zotero_key);
            if (!item || typeof item === 'boolean') return null;
            // Labels come from the active render store (passed in by the caller),
            // so this resolves correctly under the isolated store used for note
            // export as well as the live UI store.
            return getPageLabelsForItem(item, labelsByAttachmentId);
        } catch (e) {
            logger(`zoteroItemData: page label resolution failed: ${e}`);
            return null;
        }
    },

    async resolveItemDisplay(ref: ZoteroItemReference): Promise<ResolvedItemDisplay | null> {
        const libraryId = resolveLibraryRef(ref);
        if (!libraryId) return null;
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, ref.zotero_key);
            if (!item || typeof item === 'boolean') return null;
            let hasReadableAttachment = false;
            if (item.isRegularItem()) {
                await Zotero.Items.loadDataTypes([item], ['childItems']);
                hasReadableAttachment = !!(await item.getBestAttachment());
            } else if (item.isAttachment()) {
                hasReadableAttachment = true;
            }
            const displayName = await resolveDisplayName(item);
            return { itemType: item.itemType, hasReadableAttachment, displayName };
        } catch (e) {
            logger(`zoteroItemData: item display resolution failed: ${e}`);
            return null;
        }
    },

    async resolveLibraryName(libraryParam: number | string): Promise<string | null> {
        try {
            const { library } = getLibraryByIdOrName(libraryParam);
            return library?.name ?? null;
        } catch (e) {
            logger(`zoteroItemData: library name resolution failed: ${e}`);
            return null;
        }
    },

    async resolveCollectionName(keyOrName: string | number, libraryId?: number): Promise<string | null> {
        try {
            const result = getCollectionByIdOrName(keyOrName, libraryId);
            return result?.collection.name ?? null;
        } catch (e) {
            logger(`zoteroItemData: collection name resolution failed: ${e}`);
            return null;
        }
    },
};
