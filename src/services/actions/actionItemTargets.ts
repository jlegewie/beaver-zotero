/**
 * Which selected Zotero items an action acts on.
 *
 * This is the one rule every action surface applies to item selections: the
 * homepage context bar, the slash menu, the library context menu and the
 * reader toolbar. A paper and its file stand in for each other, so an action
 * never disappears because the user selected the parent row instead of the
 * PDF, or the PDF instead of the parent:
 *
 * - a regular item an action can't take directly is replaced by its best
 *   readable attachment when the action accepts attachments;
 * - an attachment an action can't take directly is replaced by its regular
 *   parent when the action accepts items.
 *
 * Must stay React-free: the library context menu (esbuild bundle) uses it.
 */

import type { ActionTargetType } from '@beaver/agent-core/types/actions';
import { agentItemFilter } from '../../utils/agentItemSupport';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';

/** Target kinds an item selection can satisfy. */
export type ItemTargetKind = 'items' | 'attachment' | 'note';

/** Item kinds in the order a mixed selection resolves its wire target type. */
const ITEM_TARGET_KINDS: readonly ItemTargetKind[] = ['items', 'attachment', 'note'];

export const isItemTargetKind = (target: ActionTargetType): target is ItemTargetKind =>
    target === 'items' || target === 'attachment' || target === 'note';

/** The kind an item counts as on its own, or null when no action can use it. */
export function itemTargetKind(item: Zotero.Item): ItemTargetKind | null {
    if (item.isRegularItem()) return agentItemFilter(item) ? 'items' : null;
    if (item.isAttachment()) return agentItemFilter(item) ? 'attachment' : null;
    if (item.isNote()) return safeIsInTrash(item) === false ? 'note' : null;
    return null;
}

/** Preference among readable attachments: the one a reader would open first. */
const ATTACHMENT_KIND_RANK: Record<string, number> = { pdf: 0, epub: 1, snapshot: 2, text: 3, image: 4 };

/**
 * A regular item's best readable attachment: a PDF, else an EPUB, else any
 * other kind the agent can read. Synchronous, so it only sees attachments whose
 * data Zotero has already loaded; anything else reads as "no attachment".
 */
export function bestReadableAttachment(item: Zotero.Item): Zotero.Item | null {
    let attachmentIds: number[];
    try {
        attachmentIds = item.getAttachments();
    } catch {
        return null;
    }
    let best: Zotero.Item | null = null;
    let bestRank = Infinity;
    for (const id of attachmentIds) {
        try {
            const attachment = Zotero.Items.get(id) as Zotero.Item | false;
            if (!attachment || !agentItemFilter(attachment)) continue;
            const rank = ATTACHMENT_KIND_RANK[getReadableContentKind(attachment) ?? ''] ?? 5;
            if (rank < bestRank) {
                best = attachment;
                bestRank = rank;
            }
        } catch {
            // An attachment whose data is not loaded can't be ranked; skip it.
        }
    }
    return best;
}

/** An attachment's regular parent, when an action can use it. */
function actionableParentItem(attachment: Zotero.Item): Zotero.Item | null {
    try {
        const parent = attachment.parentItem;
        return parent && parent.isRegularItem() && agentItemFilter(parent) ? parent : null;
    } catch {
        return null;
    }
}

/**
 * The item an action acts on in place of `item`, or null when it acts on
 * neither the item nor its paper/file counterpart.
 */
function itemForAction(item: Zotero.Item, accepted: ReadonlySet<ItemTargetKind>): Zotero.Item | null {
    const kind = itemTargetKind(item);
    if (!kind) return null;
    if (accepted.has(kind)) return item;
    if (kind === 'items' && accepted.has('attachment')) return bestReadableAttachment(item);
    if (kind === 'attachment' && accepted.has('items')) return actionableParentItem(item);
    return null;
}

const acceptedItemKinds = (targets: readonly ActionTargetType[]): Set<ItemTargetKind> =>
    new Set(targets.filter(isItemTargetKind));

export interface ResolvedItemTargets {
    /** What the action acts on, in selection order, without duplicates. */
    items: Zotero.Item[];
    /** The target type sent with the action: the first accepted kind present. */
    targetType: ItemTargetKind | null;
}

/**
 * Resolve an item selection to what an action with these targets acts on.
 * Items the action takes directly are kept; the rest are swapped for their
 * paper or file (see the module comment) or dropped.
 */
export function resolveItemTargets(
    targets: readonly ActionTargetType[],
    items: readonly Zotero.Item[],
): ResolvedItemTargets {
    const accepted = acceptedItemKinds(targets);
    const resolved: Zotero.Item[] = [];
    const seen = new Set<number>();
    if (accepted.size > 0) {
        for (const item of items) {
            const target = itemForAction(item, accepted);
            if (!target || seen.has(target.id)) continue;
            seen.add(target.id);
            resolved.push(target);
        }
    }
    const presentKinds = new Set(resolved.map(itemTargetKind));
    const targetType = ITEM_TARGET_KINDS.find(kind => accepted.has(kind) && presentKinds.has(kind)) ?? null;
    return { items: resolved, targetType };
}

/**
 * Which target kinds a selection satisfies, summarized once so a surface
 * listing many actions doesn't resolve the selection again for each one. A
 * paper with a readable file also satisfies `attachment`; a file with a
 * regular parent also satisfies `items`.
 */
export type ItemSelectionKinds = Record<ItemTargetKind, boolean>;

export function summarizeItemSelection(items: readonly Zotero.Item[]): ItemSelectionKinds {
    const kinds: ItemSelectionKinds = { items: false, attachment: false, note: false };
    for (const item of items) {
        const kind = itemTargetKind(item);
        if (!kind) continue;
        kinds[kind] = true;
        if (kind === 'items' && !kinds.attachment && bestReadableAttachment(item)) kinds.attachment = true;
        if (kind === 'attachment' && !kinds.items && actionableParentItem(item)) kinds.items = true;
    }
    return kinds;
}

/** Whether an action with these targets acts on a selection with these kinds. */
export function actsOnSelection(targets: readonly ActionTargetType[], kinds: ItemSelectionKinds): boolean {
    return targets.some(target => isItemTargetKind(target) && kinds[target]);
}

/** Whether a selection offers anything an action could act on. */
export function hasItemTargets(kinds: ItemSelectionKinds): boolean {
    return kinds.items || kinds.attachment || kinds.note;
}
