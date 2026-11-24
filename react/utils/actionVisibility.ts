/**
 * Action visibility — which actions apply to the current context (Zotero state
 * plus items attached to the message), grouped by what they would act on.
 *
 * Every surface uses the same rule. An action applies to a source (the open
 * reader file, the attached items, the selected items, the open note, the
 * selected collections) when it accepts that source's kind; for items, a paper
 * and its file stand in for each other (`src/services/actions/actionItemTargets`).
 * Category never affects visibility — it only sets the icon.
 *
 * `computeActionGroups` builds one group per source in priority order. The
 * first context group is what the homepage context bar acts on; the slash menu
 * lists them all. Each group binds a picked action to its source.
 */

import { Action, ActionTargetType } from '@beaver/agent-core/types/actions';
// Type-only: this module must not pull the Jotai atom graph (and the Supabase
// client behind it) into consumers that only need the visibility rules.
import type { ZoteroContext, LibraryViewInfo, SelectedCollectionInfo, SelectedViewInfo } from '../atoms/zoteroContext';
import {
    actsOnSelection,
    hasItemTargets,
    itemTargetKind,
    resolveItemTargets,
    summarizeItemSelection,
} from '../../src/services/actions/actionItemTargets';
import { getDisplayNameFromItem } from './sourceUtils';
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { readOrFallback } from '../../src/utils/zoteroDataLoading';

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
/** Most selected items an action launched from a menu attaches. */
const MAX_BOUND_SELECTED_ITEMS = 10;

// ---------------------------------------------------------------------------
// Collection selection rule
// ---------------------------------------------------------------------------

/** What a collection-targeted action acts on in the collections pane. */
export interface CollectionTargetSelection {
    /** Selected collections; attached to the message as references. */
    collections: SelectedCollectionInfo[];
    /** Selected saved searches and special views (Unfiled Items, …); attached
     *  to the message as view attachments. */
    views: SelectedViewInfo[];
}

const NO_COLLECTION_TARGET: CollectionTargetSelection = { collections: [], views: [] };

/**
 * The rows a collection-targeted action should act on.
 *
 * Returns the selected collections and collection-like views, but only when
 * the selection is nothing but those rows. A selection that includes a library
 * root, Duplicate Items, or the Trash has no single collection meaning, so
 * callers treat it as "no collection target" and fall back to their other
 * behavior.
 *
 * This is the shared rule behind every in-app action surface (slash menu, home
 * launcher, prompt-variable resolution); the context menu mirrors it over its
 * own menu-context rows. On Zotero versions without multi-row selection the
 * selection is always a single row, so this collapses to "the selected
 * collection or view, if one is selected".
 */
export function collectionTargetSelection(libraryView: LibraryViewInfo): CollectionTargetSelection {
    const { selectedCollections, selectedViews, selectedRowCount } = libraryView;
    const targetRowCount = selectedCollections.length + selectedViews.length;
    if (targetRowCount === 0 || targetRowCount !== selectedRowCount) return NO_COLLECTION_TARGET;
    return { collections: selectedCollections, views: selectedViews };
}

function hasCollectionTarget(selection: CollectionTargetSelection): boolean {
    return selection.collections.length > 0 || selection.views.length > 0;
}


// ---------------------------------------------------------------------------
// Action groups
// ---------------------------------------------------------------------------

/** Icon info for group headers — rendered by UI components */
export interface GroupIconInfo {
    type: 'css-icon' | 'item-type';
    name: string;
}

/** How picking an action from a group binds it to that group's source. */
export interface ActionBinding {
    /** Target type sent with the action. Undefined when the action runs on the
     *  items already attached to the message, so nothing is added. */
    targetType?: ActionTargetType;
    /** Items to attach instead of resolving `targetType` against the live
     *  Zotero state (attached items swapped for their paper or file). */
    items?: Zotero.Item[];
}

export interface ActionGroup {
    id: 'reader' | 'note' | 'manual' | 'selected' | 'collection' | 'global';
    label: string;
    actions: Action[];
    /** Icon to display in group headers */
    iconInfo?: GroupIconInfo;
    /** Binding for an action picked from this group. */
    bind: (action: Action) => ActionBinding;
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

/** Items an action can use at all (supported, not in the trash). */
const usableItems = (items: Zotero.Item[]): Zotero.Item[] => items.filter(i => itemTargetKind(i) !== null);

/** A group over an item source. Binds to the target type the source resolves to. */
function itemGroup(
    id: 'reader' | 'manual' | 'selected',
    items: Zotero.Item[],
    allActions: Action[],
    label: string,
    bind: (action: Action) => ActionBinding,
): ActionGroup | null {
    const kinds = summarizeItemSelection(items);
    if (!hasItemTargets(kinds)) return null;
    const actions = allActions.filter(a => actsOnSelection(a.targets, kinds));
    if (actions.length === 0) return null;
    return { id, label, actions, iconInfo: getIconInfoForItem(items[0]), bind };
}

/**
 * Compute the action groups for the current context, in priority order:
 * reader file, open note, attached items, selected items, selected
 * collections, then actions that need no context.
 *
 * A multi-target action appears in every context group that has something it
 * acts on, but never in the global group once a context group lists it: the
 * global entry would bind to nothing and silently drop the selection it was
 * meant to run on. The selected-items group is skipped when it is the same
 * set as the attached items.
 */
export function computeActionGroups(allActions: Action[], ctx: ActionContext): ActionGroup[] {
    const groups: ActionGroup[] = [];
    const push = (group: ActionGroup | null) => { if (group) groups.push(group); };

    // --- Reader: the open file. Its parent stands in for item actions, and
    // the live reader context resolves both (see resolveTargetContext).
    const readerAtt = ctx.zotero.type === 'reader' ? ctx.zotero.readerAttachment : null;
    if (readerAtt && itemTargetKind(readerAtt) === 'attachment') {
        push(itemGroup('reader', [readerAtt], allActions, getItemLabel(readerAtt), action => ({
            targetType: resolveItemTargets(action.targets, [readerAtt]).targetType ?? undefined,
        })));
    }

    // --- Open note
    if (ctx.zotero.type === 'note') {
        const noteActions = allActions.filter(a => a.targets.includes('note'));
        if (noteActions.length > 0) {
            const noteItem = ctx.zotero.noteItem;
            groups.push({
                id: 'note',
                label: noteItem ? getNoteLabel(noteItem) : 'Note',
                actions: noteActions,
                iconInfo: { type: 'css-icon', name: 'note' },
                bind: () => ({ targetType: 'note' }),
            });
        }
    }

    // --- Items attached to the message. An action taking them as they are
    // adds nothing; one that needs their paper or file attaches it.
    const manual = usableItems(ctx.manualItems);
    if (manual.length > 0) {
        push(itemGroup('manual', manual, allActions, getManualLabel(manual), action => {
            const resolved = resolveItemTargets(action.targets, manual);
            const manualIds = new Set(manual.map(i => i.id));
            if (resolved.items.every(i => manualIds.has(i.id))) return {};
            return { targetType: resolved.targetType ?? undefined, items: resolved.items };
        }));
    }

    // --- Selected items
    if (ctx.zotero.type === 'items_selected') {
        const selected = usableItems(ctx.zotero.selectedItems);
        if (selected.length > 0 && !sameItemSet(manual, selected)) {
            push(itemGroup('selected', selected, allActions, getSelectedLabel(selected), action => {
                const resolved = resolveItemTargets(action.targets, selected);
                return {
                    targetType: resolved.targetType ?? undefined,
                    items: resolved.items.slice(0, MAX_BOUND_SELECTED_ITEMS),
                };
            }));
        }
    }

    // --- Selected collections, saved searches or views
    const collectionTarget = collectionTargetSelection(ctx.zotero.libraryView);
    if (hasCollectionTarget(collectionTarget)) {
        const collectionActions = allActions.filter(a => a.targets.includes('collection'));
        if (collectionActions.length > 0) {
            groups.push({
                id: 'collection',
                label: getCollectionLabel(collectionTarget),
                actions: collectionActions,
                iconInfo: getCollectionIconInfo(collectionTarget),
                bind: () => ({ targetType: 'collection' }),
            });
        }
    }

    // --- No context needed
    const inContextGroup = new Set(groups.flatMap(g => g.actions));
    const globalActions = allActions.filter(a => a.targets.includes('global') && !inContextGroup.has(a));
    if (globalActions.length > 0) {
        groups.push({ id: 'global', label: 'Anywhere', actions: globalActions, bind: () => ({ targetType: 'global' }) });
    }

    return groups;
}

/** The context the homepage context bar acts on: the first context group. */
export function primaryActionGroup(groups: ActionGroup[]): ActionGroup | null {
    return groups.find(g => g.id !== 'global') ?? null;
}

/**
 * Binding for an action launched outside a group (a homepage category list):
 * the first context group that lists it, else no context.
 */
export function bindingForAction(action: Action, groups: ActionGroup[]): ActionBinding {
    const group = groups.find(g => g.id !== 'global' && g.actions.includes(action));
    return group ? group.bind(action) : { targetType: 'global' };
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function getManualLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) return `${getItemLabel(items[0])} (attached)`;
    if (items.every(i => i.isAttachment())) return `${items.length} attached attachments`;
    if (items.every(i => i.isRegularItem())) return `${items.length} attached items`;
    if (items.every(i => i.isNote())) return `${items.length} attached notes`;
    return `${items.length} attached items`;
}

function getSelectedLabel(items: Zotero.Item[]): string {
    if (items.length <= MAX_LABEL_ITEMS) {
        return items[0].isNote() ? getNoteLabel(items[0]) : getItemLabel(items[0]);
    }
    if (items.every(i => i.isAttachment())) return `${items.length} selected attachments`;
    if (items.every(i => i.isNote())) return `${items.length} selected notes`;
    return `${items.length} selected items`;
}


/**
 * Label for a collection-target selection: the row's name when one is
 * selected, otherwise a count — listing several names is unreadable in the
 * narrow launcher and slash-menu headers.
 */
function getCollectionLabel({ collections, views }: CollectionTargetSelection): string {
    if (collections.length === 1 && views.length === 0) {
        return truncateText(collections[0].collectionName || 'Collection', MAX_LABEL_ITEM_LENGTH);
    }
    if (views.length === 1 && collections.length === 0) {
        const fallback = views[0].type === 'search' ? 'Saved search' : 'Collection';
        return truncateText(views[0].name || fallback, MAX_LABEL_ITEM_LENGTH);
    }
    if (views.length === 0) return `${collections.length} collections selected`;
    return `${collections.length + views.length} views selected`;
}

/** Collections-pane icon for a collection-target selection. */
function getCollectionIconInfo({ collections, views }: CollectionTargetSelection): GroupIconInfo {
    // Zotero's collections-tree icon names match the row types
    if (collections.length === 0 && views.length > 0 && views.every(v => v.type === views[0].type)) {
        return { type: 'css-icon', name: views[0].type };
    }
    return { type: 'css-icon', name: 'collection' };
}

/**
 * Display name for any item type — regular items use author/year, others their
 * display title. An item whose data is not loaded yet (a library not opened
 * this session) gets a generic label instead of throwing; the composer loads
 * the data and re-renders with the real one.
 */
function getItemLabel(item: Zotero.Item): string {
    const fallback = item.isNote() ? 'Note' : item.isAttachment() ? 'Attachment' : 'Item';
    return readOrFallback(() => {
        if (item.isRegularItem()) {
            return truncateText(getDisplayNameFromItem(item), MAX_LABEL_ITEM_LENGTH);
        }
        return truncateText(item.getDisplayTitle(), MAX_LABEL_ITEM_LENGTH);
    }, fallback);
}

function getNoteLabel(note: Zotero.Item): string {
    return readOrFallback(() => truncateText(note.getNoteTitle(), MAX_LABEL_ITEM_LENGTH), 'Note');
}
