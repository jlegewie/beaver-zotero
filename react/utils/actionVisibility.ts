/**
 * Action visibility — determines whether an action should be shown
 * (enabled) given the current context (Zotero state + manually attached items).
 *
 * Also provides `computeActionGroups` for building grouped slash-menu sections.
 */

import { Action, ActionTargetType } from '../types/actions';
import { ZoteroContext } from '../atoms/zoteroContext';
import { isSupportedItem } from '../../src/utils/sync';
import { getDisplayNameFromItem } from './sourceUtils';
import { truncateText } from './stringUtils';

// ---------------------------------------------------------------------------
// ActionContext — combines Zotero state with manually-attached message items
// ---------------------------------------------------------------------------

export interface ActionContext {
    zotero: ZoteroContext;
    manualItems: Zotero.Item[];  // from currentMessageItemsAtom
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LABEL_ITEM_LENGTH = 50;
const MAX_LABEL_ITEMS = 2;

// ---------------------------------------------------------------------------
// isActionVisible — each source checked independently (no mixing)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the action makes sense in the given context.
 *
 * Each source (reader, manual items, selected items) is checked independently.
 * An action is visible if ANY single source fully satisfies its requirements
 * on its own — sources are never combined to meet minItems thresholds.
 */
export function isActionVisible(action: Action, ctx: ActionContext): boolean {
    switch (action.targetType) {
        case 'items': {
            const min = action.minItems ?? 1;
            // Reader: parent item counts as 1 regular item
            if (ctx.zotero.type === 'reader' && ctx.zotero.readerAttachment) {
                const parent = ctx.zotero.readerAttachment.parentItem;
                if (parent?.isRegularItem() && min <= 1) return true;
            }
            // Manual items (standalone source)
            const manualRegular = ctx.manualItems.filter(i => i.isRegularItem()).length;
            if (manualRegular >= min) return true;
            // Selected items (standalone source)
            if (ctx.zotero.type === 'items_selected') {
                const selectedRegular = ctx.zotero.selectedItems.filter(i => i.isRegularItem()).length;
                if (selectedRegular >= min) return true;
            }
            return false;
        }
        case 'attachment':
            // Reader
            if (ctx.zotero.readerAttachment && isSupportedItem(ctx.zotero.readerAttachment)) return true;
            // Manual items
            if (ctx.manualItems.some(i => i.isAttachment() && isSupportedItem(i))) return true;
            // Selected items
            if (ctx.zotero.type === 'items_selected') {
                if (ctx.zotero.selectedItems.some(i => i.isAttachment() && isSupportedItem(i))) return true;
            }
            return false;
        case 'note':
            return ctx.zotero.type === 'note';
        case 'collection':
            return ctx.zotero.libraryView.treeRowType === 'collection';
        case 'global':
            return true;
    }
}

// ---------------------------------------------------------------------------
// Action groups for the slash menu
// ---------------------------------------------------------------------------

/** Icon info for group headers — rendered by UI components */
export interface GroupIconInfo {
    type: 'css-icon' | 'item-type';
    name: string;
}

export interface ActionGroup {
    id: string;
    label: string;
    actions: Action[];
    /** When set, resolveTargetTypeContext is called with this type on execution.
     *  When undefined (manual items group), no auto-attach — user's items are already in message. */
    targetType?: ActionTargetType;
    /** Icon to display in group headers */
    iconInfo?: GroupIconInfo;
}

/** Get icon info for an item, following the same parent-resolution as getItemLabel */
export function getIconInfoForItem(item: Zotero.Item): GroupIconInfo | undefined {
    try {
        const target = item.isRegularItem() ? item : (item.parentItem ?? item);
        const name = target.getItemTypeIconName();
        return name ? { type: 'item-type', name } : undefined;
    } catch {
        return undefined;
    }
}

/** Check if two item sets are identical by libraryID-key */
function sameItemSet(a: Zotero.Item[], b: Zotero.Item[]): boolean {
    if (a.length !== b.length) return false;
    const keys = new Set(a.map(i => `${i.libraryID}-${i.key}`));
    return b.every(i => keys.has(`${i.libraryID}-${i.key}`));
}

/**
 * Compute grouped action lists for the slash menu.
 * Groups are built in priority order; the same action CAN appear in multiple groups.
 * Manual and selected groups are merged if the underlying item sets are identical.
 */
export function computeActionGroups(allActions: Action[], ctx: ActionContext): ActionGroup[] {
    const groups: ActionGroup[] = [];

    const readerAtt = ctx.zotero.readerAttachment;
    const isReader = ctx.zotero.type === 'reader' && readerAtt && isSupportedItem(readerAtt);

    // --- 1. Reader group ---
    if (isReader) {
        const readerParent = readerAtt!.parentItem;
        const label = readerParent
            ? `${truncateText(getDisplayNameFromItem(readerParent), MAX_LABEL_ITEM_LENGTH)}`
            : `${truncateText(readerAtt!.getDisplayTitle(), MAX_LABEL_ITEM_LENGTH)}`;

        // Reader supports both attachment and items actions (parent is a regular item)
        const readerActions = allActions.filter(a => {
            if (a.targetType === 'attachment') return true;
            if (a.targetType === 'items' && readerParent?.isRegularItem()) {
                return (a.minItems ?? 1) <= 1;
            }
            return false;
        });

        if (readerActions.length > 0) {
            const iconInfo = getIconInfoForItem(readerParent ?? readerAtt!);
            groups.push({ id: 'reader', label, actions: readerActions, targetType: 'attachment', iconInfo });
        }
    }

    // --- 2. Manual items group ---
    const manualSupported = ctx.manualItems.filter(i => isSupportedItem(i));
    if (manualSupported.length > 0) {
        const manualAttachments = manualSupported.filter(i => i.isAttachment());
        const manualRegular = manualSupported.filter(i => i.isRegularItem());

        const manualActions = allActions.filter(a => {
            if (a.targetType === 'attachment' && manualAttachments.length > 0) return true;
            if (a.targetType === 'items' && manualRegular.length > 0) {
                return manualRegular.length >= (a.minItems ?? 1);
            }
            return false;
        });

        if (manualActions.length > 0) {
            const label = getManualLabel(manualSupported);
            const iconInfo = getIconInfoForItem(manualSupported[0]);
            // targetType undefined → no auto-attach, user's items already in message
            groups.push({ id: 'manual', label, actions: manualActions, targetType: undefined, iconInfo });
        }
    }

    // --- 3. Selected items group ---
    if (ctx.zotero.type === 'items_selected') {
        const selectedSupported = ctx.zotero.selectedItems.filter(i => isSupportedItem(i));
        if (selectedSupported.length > 0) {
            // Skip if identical to manual items
            if (manualSupported.length === 0 || !sameItemSet(manualSupported, selectedSupported)) {
                const selectedAttachments = selectedSupported.filter(i => i.isAttachment());
                const selectedRegular = selectedSupported.filter(i => i.isRegularItem());

                const selectedActions = allActions.filter(a => {
                    if (a.targetType === 'attachment' && selectedAttachments.length > 0) return true;
                    if (a.targetType === 'items' && selectedRegular.length > 0) {
                        return selectedRegular.length >= (a.minItems ?? 1);
                    }
                    return false;
                });

                if (selectedActions.length > 0) {
                    const label = getSelectedLabel(selectedSupported);
                    const iconInfo = getIconInfoForItem(selectedSupported[0]);
                    // For selected items, figure out the dominant target type
                    const targetType: ActionTargetType = selectedAttachments.length > 0 && selectedRegular.length === 0
                        ? 'attachment' : 'items';
                    groups.push({ id: 'selected', label, actions: selectedActions, targetType, iconInfo });
                }
            }
        }
    }

    // --- 4. Note group ---
    if (ctx.zotero.type === 'note') {
        const noteActions = allActions.filter(a => a.targetType === 'note');
        if (noteActions.length > 0) {
            const noteItem = ctx.zotero.noteItem;
            const label = noteItem
                ? truncateText(noteItem.getNoteTitle(), MAX_LABEL_ITEM_LENGTH)
                : 'Note';
            groups.push({ id: 'note', label, actions: noteActions, targetType: 'note', iconInfo: { type: 'css-icon', name: 'note' } });
        }
    }

    // --- 5. Collection group ---
    if (ctx.zotero.libraryView.treeRowType === 'collection') {
        const collectionActions = allActions.filter(a => a.targetType === 'collection');
        if (collectionActions.length > 0) {
            const name = ctx.zotero.libraryView.collectionName ?? 'Collection';
            groups.push({
                id: 'collection',
                label: name,
                actions: collectionActions,
                targetType: 'collection',
                iconInfo: { type: 'css-icon', name: 'collection' },
            });
        }
    }

    // --- 6. Global group ---
    const globalActions = allActions.filter(a => a.targetType === 'global');
    if (globalActions.length > 0) {
        groups.push({ id: 'global', label: 'General', actions: globalActions, targetType: 'global' });
    }

    return groups;
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function getManualLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) {
        const names = items.map(i => getItemLabel(i));
        return `${names.join(', ')} (attached)`;
    }
    return `${items.length} attached items`;
}

function getSelectedLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) {
        const names = items.map(i => getItemLabel(i));
        return `${names.join(', ')}`;
    }
    return `${items.length} selected items`;
}

function getItemLabel(item: Zotero.Item): string {
    if (item.isRegularItem()) {
        return truncateText(getDisplayNameFromItem(item), MAX_LABEL_ITEM_LENGTH);
    }
    const parent = item.parentItem;
    if (parent) {
        return truncateText(getDisplayNameFromItem(parent), MAX_LABEL_ITEM_LENGTH);
    }
    return truncateText(item.getDisplayTitle(), MAX_LABEL_ITEM_LENGTH);
}
