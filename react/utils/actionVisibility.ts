/**
 * Action visibility — determines whether an action should be shown
 * (enabled) given the current context (Zotero state + manually attached items).
 *
 * The rule is a single predicate: an action is visible when at least one
 * context source contains an eligible item of a kind the action targets.
 * Binding (which single target type an invocation resolves to) is decided by
 * the entry point — slash-menu group, context menu, or the active target for
 * launcher surfaces (`getActiveTarget`).
 *
 * Also provides `computeActionGroups` for building grouped slash-menu sections.
 */

import { Action, ActionCategory, ActionTargetType } from '../types/actions';
import { ZoteroContext } from '../atoms/zoteroContext';
import { agentItemFilter } from '../../src/utils/agentItemSupport';
import { getDisplayNameFromItem } from './sourceUtils';
import { truncateText } from './stringUtils';
import { safeIsInTrash } from '../../src/utils/zoteroUtils';

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
const MAX_LABEL_ITEMS = 1;

// ---------------------------------------------------------------------------
// isActionableItem — enhanced item check for action visibility
// ---------------------------------------------------------------------------

/**
 * Returns `true` when an item is both supported and actionable.
 * Adds a trash check on top of `isAgentSupportedItem` (type-only).
 */
export function isActionableItem(item: Zotero.Item): boolean {
    return agentItemFilter(item);
}

// ---------------------------------------------------------------------------
// isActionVisible — OR over the action's target set
// ---------------------------------------------------------------------------

/** Whether a single target kind is satisfied by the current context. */
function isTargetSatisfied(target: ActionTargetType, ctx: ActionContext): boolean {
    switch (target) {
        case 'items': {
            // Reader: parent item counts as a regular item
            if (ctx.zotero.type === 'reader' && ctx.zotero.readerAttachment) {
                if (!safeIsInTrash(ctx.zotero.readerAttachment)) {
                    const parent = ctx.zotero.readerAttachment.parentItem;
                    if (parent?.isRegularItem()) return true;
                }
            }
            // Manual items
            if (ctx.manualItems.some(i => i.isRegularItem() && !safeIsInTrash(i))) return true;
            // Selected items
            if (ctx.zotero.type === 'items_selected') {
                if (ctx.zotero.selectedItems.some(i => i.isRegularItem() && !safeIsInTrash(i))) return true;
            }
            return false;
        }
        case 'attachment':
            // Reader
            if (ctx.zotero.readerAttachment && isActionableItem(ctx.zotero.readerAttachment)) return true;
            // Manual items
            if (ctx.manualItems.some(i => i.isAttachment() && isActionableItem(i))) return true;
            // Selected items
            if (ctx.zotero.type === 'items_selected') {
                if (ctx.zotero.selectedItems.some(i => i.isAttachment() && isActionableItem(i))) return true;
            }
            return false;
        case 'note':
            if (ctx.zotero.type === 'note') return true;
            // Selected notes in library view
            if (ctx.zotero.type === 'items_selected') {
                if (ctx.zotero.selectedItems.some(i => i.isNote())) return true;
            }
            return false;
        case 'collection':
            return ctx.zotero.libraryView.treeRowType === 'collection';
        case 'global':
            return true;
    }
}

/**
 * Returns `true` when the action makes sense in the given context: at least
 * one of its target kinds is satisfied by some source (reader, manual items,
 * selected items). Sources are checked independently, never combined.
 */
export function isActionVisible(action: Action, ctx: ActionContext): boolean {
    return action.targets.some(t => isTargetSatisfied(t, ctx));
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
    /** The resolved target type for this group: when set, resolveTargetTypeContext
     *  is called with this type on execution.
     *  When undefined (manual items group), no auto-attach — user's items are already in message. */
    targetType?: ActionTargetType;
    /** Icon to display in group headers */
    iconInfo?: GroupIconInfo;
}

/** Get icon info for an item, following the same parent-resolution as getItemLabel */
export function getIconInfoForItem(item: Zotero.Item): GroupIconInfo | undefined {
    try {
        const name = item.getItemTypeIconName();
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
 * Groups are built in priority order; the same action CAN appear in multiple
 * groups (a multi-target action appears in every group whose kind it accepts).
 * Manual and selected groups are merged if the underlying item sets are identical.
 */
export function computeActionGroups(allActions: Action[], ctx: ActionContext): ActionGroup[] {
    const groups: ActionGroup[] = [];

    const readerAtt = ctx.zotero.readerAttachment;
    const isReader = ctx.zotero.type === 'reader' && readerAtt && isActionableItem(readerAtt);

    // --- 1. Reader group ---
    if (isReader) {
        const label = truncateText(readerAtt!.getDisplayTitle(), MAX_LABEL_ITEM_LENGTH);

        const readerActions = allActions.filter(a => a.targets.includes('attachment'));

        if (readerActions.length > 0) {
            const iconInfo = getIconInfoForItem(readerAtt!);
            groups.push({ id: 'reader', label, actions: readerActions, targetType: 'attachment', iconInfo });
        }
    }

    // --- 2. Manual items group ---
    const manualSupported = ctx.manualItems.filter(i => isActionableItem(i));
    if (manualSupported.length > 0) {
        const hasManualAttachments = manualSupported.some(i => i.isAttachment());
        const hasManualRegular = manualSupported.some(i => i.isRegularItem());

        const manualActions = allActions.filter(a =>
            (hasManualAttachments && a.targets.includes('attachment')) ||
            (hasManualRegular && a.targets.includes('items'))
        );

        if (manualActions.length > 0) {
            const label = getManualLabel(manualSupported);
            const iconInfo = getIconInfoForItem(manualSupported[0]);
            // targetType undefined → no auto-attach, user's items already in message
            groups.push({ id: 'manual', label, actions: manualActions, targetType: undefined, iconInfo });
        }
    }

    // --- 3. Selected items group(s) ---
    // When the selection contains both regular items and attachments, create
    // separate groups so each group's resolved target matches its items exactly.
    if (ctx.zotero.type === 'items_selected') {
        const selectedSupported = ctx.zotero.selectedItems.filter(i => isActionableItem(i));
        if (selectedSupported.length > 0) {
            // Skip if identical to manual items
            if (manualSupported.length === 0 || !sameItemSet(manualSupported, selectedSupported)) {
                const selectedAttachments = selectedSupported.filter(i => i.isAttachment());
                const selectedRegular = selectedSupported.filter(i => i.isRegularItem());

                // Items group
                if (selectedRegular.length > 0) {
                    const itemActions = allActions.filter(a => a.targets.includes('items'));
                    if (itemActions.length > 0) {
                        groups.push({
                            id: 'selected-items',
                            label: getSelectedLabel(selectedRegular),
                            actions: itemActions,
                            targetType: 'items',
                            iconInfo: getIconInfoForItem(selectedRegular[0]),
                        });
                    }
                }

                // Attachments group
                if (selectedAttachments.length > 0) {
                    const attachmentActions = allActions.filter(a => a.targets.includes('attachment'));
                    if (attachmentActions.length > 0) {
                        groups.push({
                            id: 'selected-attachments',
                            label: getSelectedLabel(selectedAttachments),
                            actions: attachmentActions,
                            targetType: 'attachment',
                            iconInfo: getIconInfoForItem(selectedAttachments[0]),
                        });
                    }
                }
            }
        }
    }

    // --- 3b. Selected notes group ---
    if (ctx.zotero.type === 'items_selected') {
        const selectedNotes = ctx.zotero.selectedItems.filter(i => i.isNote());
        if (selectedNotes.length > 0) {
            const noteActions = allActions.filter(a => a.targets.includes('note'));
            if (noteActions.length > 0) {
                const label = selectedNotes.length === 1
                    ? truncateText(selectedNotes[0].getNoteTitle(), MAX_LABEL_ITEM_LENGTH)
                    : `${selectedNotes.length} selected notes`;
                groups.push({
                    id: 'selected-notes',
                    label,
                    actions: noteActions,
                    targetType: 'note',
                    iconInfo: { type: 'css-icon', name: 'note' },
                });
            }
        }
    }

    // --- 4. Note group ---
    if (ctx.zotero.type === 'note') {
        const noteActions = allActions.filter(a => a.targets.includes('note'));
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
        const collectionActions = allActions.filter(a => a.targets.includes('collection'));
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
    const globalActions = allActions.filter(a => a.targets.includes('global'));
    if (globalActions.length > 0) {
        groups.push({ id: 'global', label: 'General', actions: globalActions, targetType: 'global' });
    }

    return groups;
}

// ---------------------------------------------------------------------------
// Active target — the single context target launcher surfaces bind to
// ---------------------------------------------------------------------------

export interface ActiveTarget {
    targetType: ActionTargetType;
    label: string | null;
    iconInfo?: GroupIconInfo;
}

/**
 * Priority chain for determining the single active action target type.
 * Launcher surfaces (Actions panel, category skill panels) show the actions
 * that accept this kind and bind invocations to it.
 *
 * 1. Reader (non-library tab + supported PDF) → 'attachment'
 * 2. Note (non-library tab + note) → 'note'
 * 3. Manual items (currentMessageItemsAtom has supported items):
 *    - All attachments → 'attachment'
 *    - Has regular items → 'items'
 * 4. Selected items (items_selected context with supported items):
 *    - All attachments → 'attachment'
 *    - Has regular items → 'items'
 * 5. Collection (treeRowType === 'collection') → 'collection'
 * 6. Fallback → null (global only)
 */
export function getActiveTarget(ctx: ActionContext): ActiveTarget | null {
    const { zotero, manualItems } = ctx;

    // 1. Reader
    if (zotero.type === 'reader') {
        const att = zotero.readerAttachment;
        if (att && isActionableItem(att)) {
            return { targetType: 'attachment', label: getItemLabel(att), iconInfo: getIconInfoForItem(att) };
        }
    }

    // 2. Note
    if (zotero.type === 'note') {
        const noteItem = zotero.noteItem;
        const label = noteItem
            ? truncateText(noteItem.getNoteTitle(), MAX_LABEL_ITEM_LENGTH)
            : null;
        return { targetType: 'note', label, iconInfo: { type: 'css-icon', name: 'note' } };
    }

    // 3. Manual items
    const manualSupported = manualItems.filter(i => isActionableItem(i));
    if (manualSupported.length > 0) {
        const allAttachments = manualSupported.every(i => i.isAttachment());
        const targetType: ActionTargetType = allAttachments ? 'attachment' : 'items';
        return { targetType, label: formatItemNames(manualSupported, 'attached'), iconInfo: getIconInfoForItem(manualSupported[0]) };
    }

    // 4. Selected items
    if (zotero.type === 'items_selected') {
        const supported = zotero.selectedItems.filter(i => isActionableItem(i));
        if (supported.length > 0) {
            const allAttachments = supported.every(i => i.isAttachment());
            const targetType: ActionTargetType = allAttachments ? 'attachment' : 'items';
            const labelItems = targetType === 'attachment'
                ? supported.filter(i => i.isAttachment())
                : supported.filter(i => i.isRegularItem());
            const displayItems = labelItems.length > 0 ? labelItems : supported;
            return { targetType, label: formatItemNames(displayItems, 'selected'), iconInfo: getIconInfoForItem(displayItems[0]) };
        }
    }

    // 4b. Selected notes (when no actionable items found in step 4)
    if (zotero.type === 'items_selected') {
        const selectedNotes = zotero.selectedItems.filter(i => i.isNote());
        if (selectedNotes.length > 0) {
            const label = selectedNotes.length === 1
                ? truncateText(selectedNotes[0].getNoteTitle(), MAX_LABEL_ITEM_LENGTH)
                : `${selectedNotes.length} selected notes`;
            return { targetType: 'note', label, iconInfo: { type: 'css-icon', name: 'note' } };
        }
    }

    // 5. Collection
    if (zotero.libraryView.treeRowType === 'collection') {
        return {
            targetType: 'collection',
            label: zotero.libraryView.collectionName ?? null,
            iconInfo: { type: 'css-icon', name: 'collection' },
        };
    }

    // 6. No specific context
    return null;
}

/**
 * The single target type an action invocation binds to when launched without
 * a pre-resolved group (home launcher, action suggestions): the active
 * target if the action accepts it, else 'global' if the action works
 * anywhere, else the action's primary target (its context is auto-attached
 * at send time if present).
 */
export function resolveActionBinding(action: Action, active: ActiveTarget | null): ActionTargetType {
    if (active && action.targets.includes(active.targetType)) return active.targetType;
    if (action.targets.includes('global')) return 'global';
    return action.targets[0];
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function formatItemNames(items: Zotero.Item[], source: 'selected' | 'attached'): string {
    const prefix = source === 'selected' ? 'selected' : 'attached';
    if (items.length > MAX_LABEL_ITEMS) {
        if (source === 'attached' && items.some(i => i.isAttachment()) && items.some(i => i.isRegularItem())) {
            return `${items.length} ${prefix} items and attachments`;
        }
        if (items.every(i => i.isAttachment())) {
            return `${items.length} ${prefix} attachments`;
        }
        if (items.every(i => i.isNote())) {
            return `${items.length} ${prefix} notes`;
        }
        return `${items.length} ${prefix} items`;
    }
    const names = items
        .slice(0, MAX_LABEL_ITEMS)
        .map(i => getItemLabel(i));
    const remaining = items.length - MAX_LABEL_ITEMS;
    if (remaining > 0) names.push(`+${remaining} more`);
    return names.join(', ');
}

function getManualLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) {
        const names = items.map(i => getItemLabel(i));
        return `${names.join(', ')} (attached)`;
    }
    if (items.every(i => i.isAttachment())) return `${items.length} attached attachments`;
    if (items.every(i => i.isRegularItem())) return `${items.length} attached items`;
    if (items.every(i => i.isNote())) return `${items.length} attached notes`;
    return `${items.length} attached items and attachments`;
}

function getSelectedLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) {
        const names = items.map(i => getItemLabel(i));
        return `${names.join(', ')}`;
    }
    if (items.every(i => i.isAttachment())) return `${items.length} selected attachments`;
    if (items.every(i => i.isRegularItem())) return `${items.length} selected items`;
    return `${items.length} selected items`;
}

/** Display name for any item type — regular items use author/year, others use parent or display title */
function getItemLabel(item: Zotero.Item): string {
    if (item.isRegularItem()) {
        return truncateText(getDisplayNameFromItem(item), MAX_LABEL_ITEM_LENGTH);
    }
    return truncateText(item.getDisplayTitle(), MAX_LABEL_ITEM_LENGTH);
}

// ---------------------------------------------------------------------------
// Category split for the homepage skill panels
//
// Skill panels (Research / Organize / Annotate) show only the actions in a
// category that apply to the current selection, split into two sections: the
// selected target and library-wide (global). Visibility filtering happens
// upstream (actionsForContextAtom); this only scopes by category and splits.
// ---------------------------------------------------------------------------

/**
 * Split a context-visible action list into the selected target's actions and
 * the library-wide (global) actions for one bucket. An action accepting both
 * the active target and 'global' only appears in the target section.
 */
export function splitCategoryActions(
    contextActions: Action[],
    category: ActionCategory | null,
    activeTargetType: ActionTargetType | null,
): { targetActions: Action[]; globalActions: Action[] } {
    const scoped = category === null
        ? contextActions.filter(a => a.category == null)
        : contextActions.filter(a => a.category === category);
    const targetActions = activeTargetType ? scoped.filter(a => a.targets.includes(activeTargetType)) : [];
    const globalActions = scoped.filter(a => a.targets.includes('global') && !targetActions.includes(a));
    return { targetActions, globalActions };
}
