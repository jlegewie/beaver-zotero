/**
 * Zotero 8 context menu integration via MenuManager API.
 *
 * Registers right-click context menus in Zotero's library pane that let
 * users run Beaver actions directly from item/collection selections.
 *
 * Gated behind a capability check: if `Zotero.MenuManager` is not available
 * (Zotero 7), this module is a complete no-op.
 *
 * IMPORTANT: This module lives in the esbuild bundle. It must NOT import from
 * `react/types/actionStorage` or `react/types/settings` because those
 * transitively pull in `react/store` (Jotai), which is only available in
 * the webpack bundle. Instead, we duplicate the minimal merge logic here,
 * importing only from safe sources (builtinActions, actions types, prefs).
 */

import {
    Action,
    ActionCustomizations,
    isActionCustomizations,
    isAction,
} from '../../react/types/actions';
import { BUILTIN_ACTIONS } from '../../react/types/builtinActions';
import { getPref } from '../utils/prefs';
import { openPreferencesWindow } from '../ui/openPreferencesWindow';
import config from '../../package.json';

// ---------------------------------------------------------------------------
// Inlined helpers — can't import from sync.ts or zoteroUtils.ts because they
// transitively pull in react/store (webpack-only). These mirror isSupportedItem,
// safeIsInTrash, and isActionableItem from actionVisibility.ts.
// ---------------------------------------------------------------------------

function safeIsInTrash(item: any): boolean {
    try {
        return typeof item?.isInTrash === 'function' && item.isInTrash();
    } catch { return false; }
}

function isActionableContextItem(item: any): boolean {
    if (!item) return false;
    const supported = item.isRegularItem?.() || item.isPDFAttachment?.();
    return !!supported && !safeIsInTrash(item);
}

const ITEM_MENU_ID = 'beaver-item-context-menu';
const COLLECTION_MENU_ID = 'beaver-collection-context-menu';
const PLUGIN_ID = config.config.addonID;

// Store the namespaced keys returned by MenuManager.registerMenu().
// MenuManager internally namespaces the menuID with the pluginID
// (e.g. "beaver@jlegewie.com-beaver-item-context-menu") and
// unregisterMenu() requires that namespaced key, not the raw menuID.
let registeredItemKey: string | null = null;
let registeredCollectionKey: string | null = null;
let prefObserverSymbol: symbol | null = null;

// ---------------------------------------------------------------------------
// Minimal action merge (avoids importing actionStorage → settings → store)
// ---------------------------------------------------------------------------

function getActionCustomizations(): ActionCustomizations {
    try {
        const raw = getPref('actions');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (isActionCustomizations(parsed)) {
                parsed.custom = parsed.custom.filter(isAction);
                return parsed;
            }
        }
    } catch (_e) { /* ignore */ }
    return { version: 1, overrides: {}, custom: [] };
}

function getMergedActions(): Action[] {
    const c = getActionCustomizations();
    const actions: Action[] = [];

    for (const builtin of BUILTIN_ACTIONS) {
        const override = c.overrides[builtin.id];
        if (override?.hidden) continue;
        if (builtin.deprecated && !override) continue;

        const merged: Action = { ...builtin };
        if (override) {
            if (override.title !== undefined) merged.title = override.title;
            if (override.text !== undefined) merged.text = override.text;
            if (override.id_model !== undefined) merged.id_model = override.id_model;
            if (override.targetType !== undefined) merged.targetType = override.targetType;
            if (override.sortOrder !== undefined) merged.sortOrder = override.sortOrder;
            if (override.minItems !== undefined) merged.minItems = override.minItems;
        }
        actions.push(merged);
    }

    for (const custom of c.custom) {
        actions.push({ ...custom });
    }

    actions.sort((a, b) => {
        const orderDiff = (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
        if (orderDiff !== 0) return orderDiff;
        return a.title.localeCompare(b.title);
    });

    return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initContextMenus(): void {
    if (typeof (Zotero as any).MenuManager?.registerMenu !== 'function') {
        ztoolkit.log('zoteroContextMenu: MenuManager not available, skipping');
        return;
    }
    registerMenus();
    startPrefObserver();
}

export function cleanupContextMenus(): void {
    stopPrefObserver();

    // MenuManager's auto-cleanup doesn't seem remove DOM (selector mismatch).
    // We unregister from cache and manually remove stale DOM elements.
    unregisterMenus();
    removeStaleMenuDOM();
}

// ---------------------------------------------------------------------------
// Menu registration
// ---------------------------------------------------------------------------

function unregisterMenus(): void {
    const MenuManager = (Zotero as any).MenuManager;
    if (!MenuManager) return;

    if (registeredItemKey) {
        try { MenuManager.unregisterMenu(registeredItemKey); } catch (_e) { /* ignore */ }
        registeredItemKey = null;
    }
    if (registeredCollectionKey) {
        try { MenuManager.unregisterMenu(registeredCollectionKey); } catch (_e) { /* ignore */ }
        registeredCollectionKey = null;
    }
}

function registerMenus(): void {
    const MenuManager = (Zotero as any).MenuManager;
    if (!MenuManager) return;

    // Unregister existing menus first using stored namespaced keys
    unregisterMenus();

    const actions = getMergedActions();

    // --- Item context menu ---
    // Note actions are excluded for now — enable by adding 'note' back to this filter
    const itemActions = actions.filter(a =>
        a.targetType === 'items' || a.targetType === 'attachment'
    );

    // Always register — at minimum shows "Add custom action..."
    const itemKey = MenuManager.registerMenu({
        menuID: ITEM_MENU_ID,
        pluginID: PLUGIN_ID,
        target: 'main/library/item',
        menus: [{
            menuType: 'submenu' as const,
            l10nID: 'beaver-context-menu-submenu',
            onShowing: (_event: any, context: any) => {
                const { items, setVisible } = context;
                if (!items || items.length === 0) {
                    setVisible(false);
                    return;
                }
                // Hide for annotations — not yet supported
                const allAnnotations = items.every((i: any) => i.isAnnotation?.());
                if (allAnnotations) {
                    setVisible(false);
                    return;
                }
                // Hide for notes — not yet supported (re-enable by removing this block)
                const allNotes = items.every((i: any) => i.isNote());
                if (allNotes) {
                    setVisible(false);
                    return;
                }
                // Filter to actionable items (supported type + not in trash)
                const actionable = items.filter((i: any) => isActionableContextItem(i));
                if (actionable.length === 0) {
                    setVisible(false);
                    return;
                }
                // Hide if selection contains both regular items and PDF attachments
                // (mixed target types — same safety as ActionSuggestions' getActiveTarget)
                const hasRegular = actionable.some((i: any) => i.isRegularItem());
                const hasAttachment = actionable.some((i: any) => i.isPDFAttachment());
                if (hasRegular && hasAttachment) {
                    setVisible(false);
                    return;
                }
                setVisible(true);
            },
            menus: buildItemMenuItems(itemActions),
        }],
    });
    if (itemKey) registeredItemKey = itemKey;

    // --- Collection context menu ---
    const collectionActions = actions.filter(a => a.targetType === 'collection');

    const collectionKey = MenuManager.registerMenu({
        menuID: COLLECTION_MENU_ID,
        pluginID: PLUGIN_ID,
        target: 'main/library/collection',
        menus: [{
            menuType: 'submenu' as const,
            l10nID: 'beaver-context-menu-submenu',
            onShowing: (_event: any, context: any) => {
                const { collectionTreeRow, setVisible } = context;
                setVisible(collectionTreeRow?.isCollection?.() === true);
            },
            menus: buildCollectionMenuItems(collectionActions),
        }],
    });
    if (collectionKey) registeredCollectionKey = collectionKey;

    ztoolkit.log(`zoteroContextMenu: Registered menus (${itemActions.length} item actions, ${collectionActions.length} collection actions)`);
}

// ---------------------------------------------------------------------------
// Menu item builders
// ---------------------------------------------------------------------------

function buildItemMenuItems(itemActions: Action[]): any[] {
    const items: any[] = itemActions.map(action => ({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-action',
        l10nArgs: JSON.stringify({ title: action.title }),
        onShowing: (_event: any, context: any) => {
            filterItemAction(action, context);
        },
        onCommand: (_event: any, context: any) => {
            dispatchAction(action, context);
        },
    }));

    if (items.length > 0) {
        items.push({ menuType: 'separator' as const });
    }

    items.push({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-add-action',
        onCommand: () => {
            openPreferencesWindow('actions');
        },
    });

    return items;
}

function buildCollectionMenuItems(collectionActions: Action[]): any[] {
    const items: any[] = collectionActions.map(action => ({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-action',
        l10nArgs: JSON.stringify({ title: action.title }),
        onShowing: (_event: any, context: any) => {
            filterCollectionAction(action, context);
        },
        onCommand: (_event: any, context: any) => {
            dispatchAction(action, context);
        },
    }));

    if (items.length > 0) {
        items.push({ menuType: 'separator' as const });
    }

    items.push({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-add-action',
        onCommand: () => {
            openPreferencesWindow('actions');
        },
    });

    return items;
}

// ---------------------------------------------------------------------------
// Action visibility (onShowing filters)
// ---------------------------------------------------------------------------

function filterItemAction(action: Action, context: any): void {
    const { items, setVisible } = context;
    if (!items || items.length === 0) {
        setVisible(false);
        return;
    }

    // Use isActionableContextItem (isSupportedItem + safeIsInTrash) consistently
    const actionable = items.filter((i: any) => isActionableContextItem(i));

    switch (action.targetType) {
        case 'items': {
            const min = action.minItems ?? 1;
            const regular = actionable.filter((i: any) => i.isRegularItem());
            setVisible(regular.length >= min);
            break;
        }
        case 'attachment': {
            const hasAttachment = actionable.some((i: any) => i.isPDFAttachment());
            setVisible(hasAttachment);
            break;
        }
        case 'note': {
            const allNotes = items.length > 0 && items.every((i: any) => i.isNote());
            setVisible(allNotes);
            break;
        }
        default:
            setVisible(false);
    }
}

function filterCollectionAction(_action: Action, context: any): void {
    const { collectionTreeRow, setVisible } = context;
    setVisible(collectionTreeRow?.isCollection?.() === true);
}

// ---------------------------------------------------------------------------
// Event dispatch (onCommand handler)
// ---------------------------------------------------------------------------

function dispatchAction(action: Action, context: any): void {
    const win = Zotero.getMainWindow();
    const eventBus = win?.__beaverEventBus;
    if (!eventBus) return;

    // Filter items to the winning target type — never send mismatched items
    const allItems: any[] = context.items ?? [];
    let filteredItems: any[];
    switch (action.targetType) {
        case 'items':
            filteredItems = allItems.filter((i: any) => i.isRegularItem() && !safeIsInTrash(i));
            break;
        case 'attachment':
            filteredItems = allItems.filter((i: any) => i.isPDFAttachment() && !safeIsInTrash(i));
            break;
        default:
            filteredItems = allItems;
    }

    const itemIds: number[] = filteredItems.map((i: any) => i.id);
    const collectionId: number | null = context.collectionTreeRow?.ref?.id ?? null;

    eventBus.dispatchEvent(new win.CustomEvent('contextMenuAction', {
        detail: {
            actionId: action.id,
            actionText: action.text,
            targetType: action.targetType,
            itemIds,
            collectionId,
        },
    }));
}

// ---------------------------------------------------------------------------
// DOM cleanup (workaround for Zotero MenuManager _key vs mainKey mismatch)
// ---------------------------------------------------------------------------

const CUSTOM_MENU_CLASS = 'zotero-custom-menu-item';

function removeStaleMenuDOM(): void {
    try {
        const win = Zotero.getMainWindow();
        if (!win?.document) return;

        for (const popupId of ['zotero-itemmenu', 'zotero-collectionmenu']) {
            const popup = win.document.getElementById(popupId);
            if (!popup) continue;
            const stale = popup.querySelectorAll(`.${CUSTOM_MENU_CLASS}`);
            if (stale.length > 0) {
                stale.forEach((el: Element) => el.remove());
            }
        }
    } catch (_e) {
        // Best-effort — popup may not exist
    }
}

// ---------------------------------------------------------------------------
// Pref observer — re-registers menus when actions change
// ---------------------------------------------------------------------------

function startPrefObserver(): void {
    if (prefObserverSymbol) return;
    prefObserverSymbol = Zotero.Prefs.registerObserver(
        'extensions.zotero.beaver.actions',
        () => {
            ztoolkit.log('zoteroContextMenu: Actions pref changed, re-registering menus');
            registerMenus();
        },
        true, // global pref name
    );
}

function stopPrefObserver(): void {
    if (prefObserverSymbol) {
        Zotero.Prefs.unregisterObserver(prefObserverSymbol);
        prefObserverSymbol = null;
    }
}
