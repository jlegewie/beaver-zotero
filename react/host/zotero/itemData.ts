import { store } from '../../store';
import { pageLabelsByAttachmentIdAtom, type PageLabelsByAttachmentId } from '../../atoms/citations';
import { getBestPDFAttachment } from '../../../src/utils/zoteroItemHelpers';
import type { CitationRef } from '../../utils/citationGrammar';
import { logger } from '../../../src/utils/logger';
import type { ItemDataHost } from '../types';

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
    resolvePageLabels(ref: CitationRef): Record<number, string> | null {
        if (ref.kind !== 'zotero') return null;
        try {
            const item = Zotero.Items.getByLibraryAndKey(ref.library_id, ref.zotero_key);
            if (!item || typeof item === 'boolean') return null;
            // Read the preloaded labels straight from the store. The renderer
            // subscribes to this atom separately so it re-resolves once the
            // async page-label preload completes.
            return getPageLabelsForItem(item, store.get(pageLabelsByAttachmentIdAtom));
        } catch (e) {
            logger(`zoteroItemData: page label resolution failed: ${e}`);
            return null;
        }
    },
};
