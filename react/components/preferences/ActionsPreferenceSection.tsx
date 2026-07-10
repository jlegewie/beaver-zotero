import React, { useState, useCallback, useEffect, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { Icon, TickIcon, ArrowDownIcon, UploadCircleIcon, ImportIcon } from '../icons/icons';
import PlusSignIcon from '../icons/PlusSignIcon';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { Action, ActionCategory, ActionCategoryFilter, ActionTargetType, generateActionId, TARGET_TYPE_LABELS, CATEGORY_LABELS } from "../../types/actions";
import { actionsAtom, saveActionsAtom, hideActionAtom, restoreActionAtom, resetActionToDefaultAtom, importActionAtom } from "../../atoms/actions";
import { pendingActionsCategoryFilterAtom, pendingActionEditRequestAtom } from "../../atoms/ui";
import { importActionFromFile } from "../../utils/actionShareFile";
import { addPopupMessageAtom } from "../../utils/popupMessageUtils";
import { getActionCommand } from "../../utils/slashCommands";
import { isBuiltinAction, getActionCustomizations, getHiddenBuiltinActions, hasOldCustomPrompts } from "../../types/actionStorage";
import ActionCard from "./ActionCard";
import MenuButton from "../ui/MenuButton";
import { MenuItem } from "../ui/menu/ContextMenu";
import {SectionLabel, DocLink, SectionHeader} from "./components/SettingsElements";

// Filter dimensions. `targets` is what an action binds to (the filter matches
// any action accepting the kind); `category` is the kind of work it is (both
// are shown on each action card).
const TARGET_FILTER_OPTIONS: ActionTargetType[] = ["items", "attachment", "note", "collection", "global"];
const CATEGORY_FILTER_OPTIONS: ActionCategory[] = ["research", "write", "organize", "annotate"];

/** A radio-style filter menu row with a leading check column for the active option. */
const filterMenuItem = (label: string, isSelected: boolean, onSelect: () => void): MenuItem => ({
    label,
    role: 'menuitemradio',
    ariaChecked: isSelected,
    onClick: onSelect,
    customContent: (
        <div className="display-flex flex-row items-center gap-2 w-full min-w-0">
            <span className="display-flex items-center justify-center flex-shrink-0" style={{ width: 14 }}>
                {isSelected && <Icon icon={TickIcon} size={14} className="font-color-secondary" />}
            </span>
            <span className="flex-1 truncate text-base font-color-primary">{label}</span>
        </div>
    ),
});

const ActionsPreferenceSection: React.FC = () => {

    // --- Atoms ---
    const actions = useAtomValue(actionsAtom);
    const saveActions = useSetAtom(saveActionsAtom);
    const hideAction = useSetAtom(hideActionAtom);
    const restoreAction = useSetAtom(restoreActionAtom);
    const resetActionToDefault = useSetAtom(resetActionToDefaultAtom);
    const importAction = useSetAtom(importActionAtom);
    const addPopupMessage = useSetAtom(addPopupMessageAtom);

    // --- Filter state (null = show all for that dimension) ---
    const [targetFilter, setTargetFilter] = useState<ActionTargetType | null>(null);
    const [categoryFilter, setCategoryFilter] = useState<ActionCategoryFilter | null>(null);
    const isFiltering = targetFilter !== null || categoryFilter !== null;

    const clearFilters = useCallback(() => {
        setTargetFilter(null);
        setCategoryFilter(null);
    }, []);

    // --- Incoming category-filter request (e.g. from the homepage "Edit Actions"
    // button) — apply it once, then clear it so it doesn't reapply on remount ---
    const [pendingCategoryFilter, setPendingCategoryFilter] = useAtom(pendingActionsCategoryFilterAtom);
    useEffect(() => {
        if (!pendingCategoryFilter) return;
        setTargetFilter(null);
        setCategoryFilter(pendingCategoryFilter.filter);
        setPendingCategoryFilter(null);
    }, [pendingCategoryFilter, setPendingCategoryFilter]);

    // --- Incoming action-edit request (e.g. clicking an action pill in the
    // chat input). This effect only clears the filters so the target card is
    // rendered; the matching ActionCard consumes and clears the request once
    // it has actually mounted. Clearing the atom here would be batched with
    // the filter update, so a card hidden by an active filter would never see
    // the request. ---
    const [pendingActionEdit, setPendingActionEdit] = useAtom(pendingActionEditRequestAtom);
    useEffect(() => {
        if (!pendingActionEdit) return;
        // Unknown target (e.g. a deleted or hidden action) — drop the request.
        if (!actions.some(a => a.id === pendingActionEdit.actionId)) {
            setPendingActionEdit(null);
            return;
        }
        clearFilters();
    }, [pendingActionEdit, actions, clearFilters, setPendingActionEdit]);
    const handleForceEditHandled = useCallback(() => {
        setPendingActionEdit(null);
    }, [setPendingActionEdit]);

    // --- Action Change Handler ---
    const handleActionChange = useCallback((updatedAction: Action) => {
        const newActions = actions.map(a => a.id === updatedAction.id ? updatedAction : a);
        saveActions(newActions);
    }, [actions, saveActions]);

    // --- Add Action Handler ---
    // New action inherits the currently active target/category filters (falling back to
    // global target / no category when a dimension is unfiltered). Since it always matches
    // the active filter by construction, filters are left as-is and the new card appears
    // right in the filtered list.
    const handleAddAction = useCallback(() => {
        const targets: ActionTargetType[] = [targetFilter ?? 'global'];
        const category = categoryFilter && categoryFilter !== 'uncategorized' ? categoryFilter : undefined;
        const newAction: Action = {
            id: generateActionId(),
            title: "",
            text: "",
            targets,
            category,
            sortOrder: 999,
        };
        saveActions([...actions, newAction]);
    }, [actions, saveActions, targetFilter, categoryFilter]);

    // --- Import Action Handler ---
    // Pick a `.beaveraction` file, import it (resolving id + /command clashes),
    // then reveal the new action and open it in edit mode so the user can review
    // it. A renamed command is surfaced in a popup.
    const handleImportAction = useCallback(() => {
        (async () => {
            const result = await importActionFromFile();
            if (!result) return; // user cancelled the file picker
            if (!result.ok) {
                addPopupMessage({ type: 'error', title: 'Import failed', text: result.error, expire: true });
                return;
            }
            const { action, command, commandRenamed } = importAction(result.action);
            if (commandRenamed) {
                addPopupMessage({
                    type: 'info',
                    title: 'Action imported',
                    text: `A /${getActionCommand(result.action)} command already existed, so this one was added as /${command}.`,
                    expire: true,
                });
            }
            // Reveal the new card and open it in edit mode.
            setPendingActionEdit({ actionId: action.id, requestId: Date.now() });
        })().catch(() => {
            addPopupMessage({ type: 'error', title: 'Import failed', text: 'Could not import the action.', expire: true });
        });
    }, [importAction, addPopupMessage, setPendingActionEdit]);

    // --- Remove Action Handler ---
    const handleRemoveAction = useCallback((id: string) => {
        const newActions = actions.filter(a => a.id !== id);
        saveActions(newActions);
    }, [actions, saveActions]);

    // --- Duplicate Action Handler ---
    // Reuse the import path: it mints a fresh id (the source id always collides)
    // and a suffixed /command, appends a custom copy, and we open it in edit mode.
    const handleDuplicateAction = useCallback((action: Action) => {
        const { action: copy } = importAction({
            ...action,
            title: `${action.title} (copy)`,
        });
        setPendingActionEdit({ actionId: copy.id, requestId: Date.now() });
    }, [importAction, setPendingActionEdit]);

    // --- Filtered actions (AND across the two dimensions) ---
    const filteredActions = useMemo(() => actions.filter(a =>
        (targetFilter === null || a.targets.includes(targetFilter)) &&
        (categoryFilter === null
            || (categoryFilter === 'uncategorized' ? !a.category : a.category === categoryFilter))
    ), [actions, targetFilter, categoryFilter]);

    // --- Filter menu items ---
    const targetFilterItems: MenuItem[] = useMemo(() => [
        filterMenuItem('All targets', targetFilter === null, () => setTargetFilter(null)),
        { label: '', isDivider: true, onClick: () => {} },
        ...TARGET_FILTER_OPTIONS.map(tt =>
            filterMenuItem(TARGET_TYPE_LABELS[tt], targetFilter === tt, () => setTargetFilter(tt))
        ),
    ], [targetFilter]);

    const categoryFilterItems: MenuItem[] = useMemo(() => [
        filterMenuItem('All categories', categoryFilter === null, () => setCategoryFilter(null)),
        { label: '', isDivider: true, onClick: () => {} },
        ...CATEGORY_FILTER_OPTIONS.map(cat =>
            filterMenuItem(CATEGORY_LABELS[cat], categoryFilter === cat, () => setCategoryFilter(cat))
        ),
        filterMenuItem('Uncategorized', categoryFilter === 'uncategorized', () => setCategoryFilter('uncategorized')),
    ], [categoryFilter]);

    const targetButtonLabel = targetFilter ? TARGET_TYPE_LABELS[targetFilter] : 'All targets';
    const categoryButtonLabel = categoryFilter === null
        ? 'All categories'
        : categoryFilter === 'uncategorized'
            ? 'Uncategorized'
            : CATEGORY_LABELS[categoryFilter];

    // No background when a filter dimension is unset ("All ..."); a filled, bordered
    // chip once it's narrowed down, so the active filters stand out at a glance.
    const targetButtonVariant = targetFilter !== null ? 'surface' : 'outline';
    const categoryButtonVariant = categoryFilter !== null ? 'surface' : 'outline';

    // --- Override Status ---
    const overriddenBuiltinIds = useMemo(() => {
        const c = getActionCustomizations();
        return new Set(
            Object.entries(c.overrides)
                .filter(([id, override]) =>
                    isBuiltinAction(id) &&
                    Object.keys(override).some(k => k !== 'hidden' && override[k as keyof typeof override] !== undefined)
                )
                .map(([id]) => id)
        );
    }, [actions]);

    const hiddenBuiltins = useMemo(() => getHiddenBuiltinActions(), [actions]);

    return (
        <>
            <div className="display-flex flex-row items-end justify-between">
                <SectionHeader>Actions</SectionHeader>
                <div className="display-flex flex-row items-center gap-4 mb-15">
                    <Button
                        variant="outline"
                        className="text-base"
                        icon={ImportIcon}
                        style={{ padding: '4px 6px' }}
                        onClick={handleImportAction}
                        title="Import an action from a .beaveraction file"
                    >
                        Import
                    </Button>
                    <Button
                        variant="solid"
                        className="text-base"
                        icon={PlusSignIcon}
                        style={{ padding: '4px 6px' }}
                        onClick={handleAddAction}
                    >
                        Add Action
                    </Button>
                </div>
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Actions are reusable prompts for common research tasks.
                They appear based on what you're doing in Zotero: on the Beaver homepage, in the slash menu, and Zotero's right-click menu.
                Each action targets items, collections, or your whole library, and Beaver shows the relevant ones automatically.
                {' '}<DocLink path="actions">Learn more</DocLink>.
            </div>

            {/* Filter toolbar — narrow the list by target and/or category */}
            <div className="display-flex flex-row flex-1 items-center gap-3 flex-wrap mb-15 mt-4" style={{ paddingLeft: '2px' }}>
                <div className="display-flex flex-row items-center gap-1 p-1">
                    {/* <Icon icon={FilterIcon} size={14} className="font-color-primary flex-shrink-0" /> */}
                    <span className="text-base font-color-secondary">Show:</span>
                </div>
                <MenuButton
                    menuItems={targetFilterItems}
                    buttonLabel={targetButtonLabel}
                    variant={targetButtonVariant}
                    rightIcon={ArrowDownIcon}
                    ariaLabel="Filter by target"
                    className="text-sm"
                    style={{ padding: '3px 8px' }}
                    maxWidth="200px"
                />
                <MenuButton
                    menuItems={categoryFilterItems}
                    buttonLabel={categoryButtonLabel}
                    variant={categoryButtonVariant}
                    rightIcon={ArrowDownIcon}
                    ariaLabel="Filter by category"
                    className="text-sm"
                    style={{ padding: '3px 8px' }}
                    maxWidth="200px"
                />
                {isFiltering && (
                    <>
                        <Button
                            variant="ghost-secondary"
                            style={{ padding: "3px 8px" }}
                            onClick={clearFilters}
                        >
                            Clear
                        </Button>
                        <div className="flex-1"></div>
                        <span className="text-base font-color-secondary px-15">
                            {filteredActions.length} of {actions.length}
                        </span>
                    </>
                )}
            </div>

            {filteredActions.length === 0 ? (
                <div className="text-base font-color-tertiary" style={{ padding: '12px 4px' }}>
                    No actions match the selected filters.
                </div>
            ) : (
                <div className="display-flex flex-col" style={{ gap: '8px' }}>
                    {filteredActions.map((action: Action) => {
                        const builtin = isBuiltinAction(action.id);
                        const overridden = overriddenBuiltinIds.has(action.id);
                        return (
                            <ActionCard
                                key={action.id}
                                action={action}
                                onChange={handleActionChange}
                                onRemove={() => handleRemoveAction(action.id)}
                                onHide={builtin ? () => hideAction(action.id) : undefined}
                                onResetToDefault={builtin && overridden ? () => resetActionToDefault(action.id) : undefined}
                                onDuplicate={() => handleDuplicateAction(action)}
                                isBuiltin={builtin}
                                isOverridden={overridden}
                                forceEdit={pendingActionEdit?.actionId === action.id}
                                onForceEditHandled={handleForceEditHandled}
                            />
                        );
                    })}
                </div>
            )}

            {/* Deleted built-ins restore section. Built-ins can't be truly removed, so
                "Delete" hides them; they land here and can be restored. */}
            {hiddenBuiltins.length > 0 && (
                <details className="mt-4">
                    <summary className="text-sm font-color-secondary cursor-pointer">
                        Deleted actions ({hiddenBuiltins.length})
                    </summary>
                    <div className="display-flex flex-col gap-2 mt-2">
                        {hiddenBuiltins.map(action => (
                            <div key={action.id} className="display-flex flex-row items-center justify-between px-2 py-1">
                                <span className="text-sm font-color-secondary">{action.title}</span>
                                <Button
                                    variant="outline"
                                    style={{ padding: "2px 8px" }}
                                    onClick={() => restoreAction(action.id)}
                                >
                                    <span className="text-xs">Restore</span>
                                </Button>
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </>
    );
};

export default ActionsPreferenceSection;
