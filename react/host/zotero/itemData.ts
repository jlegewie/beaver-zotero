import { type PageLabelsByAttachmentId } from '../../atoms/citations';
import { getBestPDFAttachment } from '../../../src/utils/zoteroItemHelpers';
import type { CitationRef } from '../../utils/citationGrammar';
import type { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';
import type { ItemDataHost, ResolvedItemDisplay } from '../types';

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
        try {
            const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
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
        try {
            const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
            if (!item || typeof item === 'boolean') return null;
            let hasReadableAttachment = false;
            if (item.isRegularItem()) {
                hasReadableAttachment = !!(await item.getBestAttachment());
            } else if (item.isAttachment()) {
                hasReadableAttachment = true;
            }
            return { itemType: item.itemType, hasReadableAttachment };
        } catch (e) {
            logger(`zoteroItemData: item display resolution failed: ${e}`);
            return null;
        }
    },
};
