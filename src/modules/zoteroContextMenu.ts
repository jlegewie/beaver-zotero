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

// ---------------------------------------------------------------------------
// Winning target type — determined per popup-show by submenu onShowing,
// consumed by filterItemAction. Safe because submenu onShowing always fires
// before inner menu items' onShowing (parent popup → submenu popup order).
// ---------------------------------------------------------------------------

interface WinningTarget { type: 'items' | 'attachment' | 'note'; count: number }
let winningTarget: WinningTarget | null = null;

/**
 * Determine the single winning target type from selected items.
 * Priority: regular items > PDF attachments > notes (mirrors getActiveTarget in ActionSuggestions).
 */
function getWinningTarget(items: any[]): WinningTarget | null {
    const actionable = items.filter((i: any) => isActionableContextItem(i));
    const regular = actionable.filter((i: any) => i.isRegularItem());
    if (regular.length > 0) return { type: 'items', count: regular.length };
    const pdfs = actionable.filter((i: any) => i.isPDFAttachment());
    if (pdfs.length > 0) return { type: 'attachment', count: pdfs.length };
    const notes = items.filter((i: any) => i.isNote?.() && !safeIsInTrash(i));
    if (notes.length > 0) return { type: 'note', count: notes.length };
    return null;
}

/** Build a human-readable label for the winning target (e.g. "3 items", "1 attachment"). */
function winningTargetLabel(wt: WinningTarget): string {
    if (wt.type === 'items') return `${wt.count} item${wt.count !== 1 ? 's' : ''}`;
    if (wt.type === 'note') return `${wt.count} note${wt.count !== 1 ? 's' : ''}`;
    return `${wt.count} attachment${wt.count !== 1 ? 's' : ''}`;
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

export function getMergedActions(): Action[] {
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
    // Clear stale Beaver DOM left by a prior version that didn't get a chance
    // to clean up (e.g., upgraded mid-session).
    removeStaleMenuDOM();
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

/**
 * Wrap an onShowing handler to swallow any throw and default to hidden.
 * `label` identifies the handler in logs so a failing action is traceable
 * when many wrappers share the same root cause.
 */
function safeOnShowing(
    label: string,
    fn: (event: any, context: any) => void,
): (event: any, context: any) => void {
    // Log at most once per wrapped handler to avoid spamming on every
    // popupshowing when a handler throws consistently.
    let logged = false;
    return (event: any, context: any) => {
        try {
            fn(event, context);
        } catch (e) {
            try { context?.setVisible?.(false); } catch { /* ignore */ }
            if (!logged) {
                logged = true;
                try {
                    ztoolkit.log(`zoteroContextMenu: onShowing threw in "${label}", hiding menu item: ${e}`);
                } catch { /* ignore — logger must not break the wrapper guarantee */ }
            }
        }
    };
}

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
    const itemActions = actions.filter(a =>
        a.targetType === 'items' || a.targetType === 'attachment' || a.targetType === 'note'
    );

    // Always register — at minimum shows "Add custom action..."
    const itemKey = MenuManager.registerMenu({
        menuID: ITEM_MENU_ID,
        pluginID: PLUGIN_ID,
        target: 'main/library/item',
        menus: [{
            menuType: 'submenu' as const,
            l10nID: 'beaver-context-menu-submenu',
            onShowing: safeOnShowing('item-submenu', (_event: any, context: any) => {
                const { items, setVisible } = context;

                // Reset module-level state
                winningTarget = null;

                if (!items || items.length === 0) {
                    setVisible(false);
                    return;
                }
                // Hide for annotations — not yet supported
                if (items.every((i: any) => i.isAnnotation?.())) {
                    setVisible(false);
                    return;
                }

                // Determine the single winning target type (items > attachments > notes)
                winningTarget = getWinningTarget(items);
                if (!winningTarget) {
                    setVisible(false);
                    return;
                }

                setVisible(true);
            }),
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
            onShowing: safeOnShowing('collection-submenu', (_event: any, context: any) => {
                const { collectionTreeRow, setVisible } = context;
                setVisible(collectionTreeRow?.isCollection?.() === true);
            }),
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
    const menus: any[] = [];

    // Disabled context header — only visible when some selected items are
    // filtered out (mixed types, trashed, notes, etc.)
    menus.push({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-context-header',
        l10nArgs: JSON.stringify({ context: '' }),
        onShowing: safeOnShowing('context-header', (_event: any, context: any) => {
            const { items, setVisible, setEnabled, setL10nArgs } = context;
            const totalSelected = items?.length ?? 0;
            if (winningTarget && winningTarget.count < totalSelected) {
                setL10nArgs(JSON.stringify({ context: winningTargetLabel(winningTarget) }));
                setEnabled(false);
                setVisible(true);
            } else {
                setVisible(false);
            }
        }),
    });

    // Action items
    for (const action of itemActions) {
        menus.push({
            menuType: 'menuitem' as const,
            l10nID: 'beaver-context-menu-action',
            l10nArgs: JSON.stringify({ title: action.title }),
            onShowing: safeOnShowing(`item-action:${action.id}`, (_event: any, context: any) => {
                filterItemAction(action, context);
            }),
            onCommand: (_event: any, context: any) => {
                dispatchAction(action, context);
            },
        });
    }

    if (itemActions.length > 0) {
        menus.push({ menuType: 'separator' as const });
    }

    menus.push({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-add-action',
        onCommand: () => {
            openPreferencesWindow('actions');
        },
    });

    return menus;
}

function buildCollectionMenuItems(collectionActions: Action[]): any[] {
    const items: any[] = collectionActions.map(action => ({
        menuType: 'menuitem' as const,
        l10nID: 'beaver-context-menu-action',
        l10nArgs: JSON.stringify({ title: action.title }),
        onShowing: safeOnShowing(`collection-action:${action.id}`, (_event: any, context: any) => {
            filterCollectionAction(action, context);
        }),
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
    if (!items || items.length === 0 || !winningTarget) {
        setVisible(false);
        return;
    }

    // Only show actions matching the winning target type
    if (action.targetType !== winningTarget.type) {
        setVisible(false);
        return;
    }

    switch (action.targetType) {
        case 'items': {
            const min = action.minItems ?? 1;
            const actionable = items.filter((i: any) => isActionableContextItem(i));
            const regular = actionable.filter((i: any) => i.isRegularItem());
            setVisible(regular.length >= min);
            break;
        }
        case 'attachment': {
            const actionable = items.filter((i: any) => isActionableContextItem(i));
            const hasAttachment = actionable.some((i: any) => i.isPDFAttachment());
            setVisible(hasAttachment);
            break;
        }
        case 'note': {
            const notes = items.filter((i: any) => i.isNote?.() && !safeIsInTrash(i));
            setVisible(notes.length > 0);
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
        case 'note':
            filteredItems = allItems.filter((i: any) => i.isNote?.() && !safeIsInTrash(i));
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
    // Scoped to Beaver's own l10n IDs so we never wipe other plugins' menu
    // items (they share CUSTOM_MENU_CLASS via Zotero's MenuManager).
    try {
        const win = Zotero.getMainWindow();
        if (!win?.document) return;

        const selector = `.${CUSTOM_MENU_CLASS}[data-l10n-id^="beaver-context-menu-"]`;
        for (const popupId of ['zotero-itemmenu', 'zotero-collectionmenu']) {
            const popup = win.document.getElementById(popupId);
            if (!popup) continue;
            const stale = popup.querySelectorAll(selector);
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
