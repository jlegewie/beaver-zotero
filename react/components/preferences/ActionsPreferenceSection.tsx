import React, { useState, useCallback, useEffect, useMemo } from "react";
import { useAtom, useAtomValue } from 'jotai';
import { Icon, FilterIcon, TickIcon, ArrowDownIcon } from '../icons/icons';
import PlusSignIcon from '../icons/PlusSignIcon';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { Action, ActionCategory, ActionCategoryFilter, ActionTargetType, generateActionId, TARGET_TYPE_LABELS, CATEGORY_LABELS } from "../../types/actions";
import { actionsAtom, saveActionsAtom, hideActionAtom, restoreActionAtom, resetActionToDefaultAtom } from "../../atoms/actions";
import { pendingActionsCategoryFilterAtom } from "../../atoms/ui";
import { isBuiltinAction, getActionCustomizations, getHiddenBuiltinActions, importFromOldCustomPrompts, hasOldCustomPrompts } from "../../types/actionStorage";
import ActionCard from "./ActionCard";
import MenuButton from "../ui/MenuButton";
import { MenuItem } from "../ui/menu/ContextMenu";
import {SettingsGroup, SectionLabel, DocLink, SectionHeader} from "./components/SettingsElements";

// Filter dimensions. `targetType` is what an action binds to; `category` is the
// kind of work it is (both are shown on each action card).
const TARGET_FILTER_OPTIONS: ActionTargetType[] = ["items", "attachment", "note", "collection", "global"];
const CATEGORY_FILTER_OPTIONS: ActionCategory[] = ["research", "organize", "annotate"];

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
        const targetType = targetFilter ?? 'global';
        const category = categoryFilter && categoryFilter !== 'uncategorized' ? categoryFilter : undefined;
        const newAction: Action = {
            id: generateActionId(),
            title: "",
            text: "",
            targetType,
            category,
            sortOrder: 999,
        };
        saveActions([...actions, newAction]);
    }, [actions, saveActions, targetFilter, categoryFilter]);

    // --- Remove Action Handler ---
    const handleRemoveAction = useCallback((id: string) => {
        const newActions = actions.filter(a => a.id !== id);
        saveActions(newActions);
    }, [actions, saveActions]);

    // --- Filtered actions (AND across the two dimensions) ---
    const filteredActions = useMemo(() => actions.filter(a =>
        (targetFilter === null || a.targetType === targetFilter) &&
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

    // --- Import from old custom prompts ---
    const [showImportButton, setShowImportButton] = useState(() => hasOldCustomPrompts());
    const handleImportOldPrompts = useCallback(() => {
        const imported = importFromOldCustomPrompts();
        if (imported.length > 0) {
            saveActions([...actions, ...imported]);
        }
        setShowImportButton(false);
    }, [actions, saveActions]);

    const hiddenBuiltins = useMemo(() => getHiddenBuiltinActions(), [actions]);

    return (
        <>
            <div className="display-flex flex-row items-end justify-between">
                <SectionHeader>Actions</SectionHeader>
                <Button
                    variant="solid"
                    className="text-base mb-15"
                    icon={PlusSignIcon}
                    style={{ padding: '4px 6px' }}
                    onClick={handleAddAction}
                >
                    Add Action
                </Button>
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
                <SettingsGroup>
                    {filteredActions.map((action: Action, index: number) => {
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
                                isBuiltin={builtin}
                                isOverridden={overridden}
                                hasBorder={index > 0}
                            />
                        );
                    })}
                </SettingsGroup>
            )}

            {/* Deleted built-ins restore section. Built-ins can't be truly removed, so
                "Delete" hides them; they land here and can be restored. */}
            {hiddenBuiltins.length > 0 && (
                <details className="mt-4">
                    <summary className="text-sm font-color-tertiary cursor-pointer">
                        Deleted actions ({hiddenBuiltins.length})
                    </summary>
                    <div className="display-flex flex-col gap-2 mt-2">
                        {hiddenBuiltins.map(action => (
                            <div key={action.id} className="display-flex flex-row items-center justify-between px-2 py-1">
                                <span className="text-sm font-color-secondary">{action.title}</span>
                                <Button
                                    variant="ghost-secondary"
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

            {/* Import from old custom prompts */}
            {showImportButton && (
                <div className="mt-4">
                    <Button
                        variant="outline"
                        onClick={handleImportOldPrompts}
                        className="text-sm"
                    >
                        Import from old Actions
                    </Button>
                </div>
            )}
        </>
    );
};

export default ActionsPreferenceSection;
