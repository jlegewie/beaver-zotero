import React, { useState, useCallback, useMemo } from "react";
import { useAtomValue } from 'jotai';
import { Icon } from '../icons/icons';
import PlusSignIcon from '../icons/PlusSignIcon';
import Button from "../ui/Button";
import { useSetAtom } from 'jotai';
import { Action, ActionTargetType, generateActionId } from "../../types/actions";
import { actionsAtom, saveActionsAtom, hideActionAtom, restoreActionAtom, resetActionToDefaultAtom } from "../../atoms/actions";
import { isBuiltinAction, getActionCustomizations, getHiddenBuiltinActions, importFromOldCustomPrompts, hasOldCustomPrompts } from "../../types/actionStorage";
import ActionCard from "./ActionCard";
import MenuButton from "../ui/MenuButton";
import { MenuItem } from "../ui/menu/ContextMenu";
import {SettingsGroup, SectionLabel, DocLink} from "./components/SettingsElements";


const ActionsPreferenceSection: React.FC = () => {

    // --- Atoms ---
    const actions = useAtomValue(actionsAtom);
    const saveActions = useSetAtom(saveActionsAtom);
    const hideAction = useSetAtom(hideActionAtom);
    const restoreAction = useSetAtom(restoreActionAtom);
    const resetActionToDefault = useSetAtom(resetActionToDefaultAtom);

    // --- Action Change Handler ---
    const handleActionChange = useCallback((updatedAction: Action) => {
        const newActions = actions.map(a => a.id === updatedAction.id ? updatedAction : a);
        saveActions(newActions);
    }, [actions, saveActions]);

    // --- Add Action Handler ---
    const handleAddAction = useCallback((targetType: ActionTargetType) => {
        const newAction: Action = {
            id: generateActionId(),
            title: "",
            text: "",
            targetType,
            sortOrder: 999,
        };
        saveActions([...actions, newAction]);
    }, [actions, saveActions]);

    // --- Remove Action Handler ---
    const handleRemoveAction = useCallback((id: string) => {
        const newActions = actions.filter(a => a.id !== id);
        saveActions(newActions);
    }, [actions, saveActions]);

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
    const [hasImported, setHasImported] = useState(false);
    const handleImportOldPrompts = useCallback(() => {
        const imported = importFromOldCustomPrompts();
        if (imported.length > 0) {
            saveActions([...actions, ...imported]);
        }
        setHasImported(true);
    }, [actions, saveActions]);

    const hiddenBuiltins = useMemo(() => getHiddenBuiltinActions(), [actions]);
    const showImportButton = useMemo(() => !hasImported && hasOldCustomPrompts(), [hasImported]);

    // --- Add Action Menu Items ---
    const addActionMenuItems: MenuItem[] = useMemo(() => [
        {
            label: 'Items',
            onClick: () => handleAddAction('items'),
            customContent: (
                <div className="display-flex flex-col">
                    <span className="text-sm font-color-primary">Item</span>
                    <span className="text-sm font-color-tertiary">Works with library items</span>
                </div>
            ),
        },
        {
            label: 'PDF',
            onClick: () => handleAddAction('attachment'),
            customContent: (
                <div className="display-flex flex-col">
                    <span className="text-sm font-color-primary">PDF Attachment</span>
                    <span className="text-sm font-color-tertiary">Works with PDF attachments</span>
                </div>
            ),
        },
        // {
        //     label: 'Note',
        //     onClick: () => handleAddAction('note'),
        //     customContent: (
        //         <div className="display-flex flex-col">
        //             <span className="text-sm font-color-primary">Note</span>
        //             <span className="text-sm font-color-tertiary">Works with the Zotero notes</span>
        //         </div>
        //     ),
        // },
        {
            label: 'Collection',
            onClick: () => handleAddAction('collection'),
            customContent: (
                <div className="display-flex flex-col">
                    <span className="text-sm font-color-primary">Collection</span>
                    <span className="text-sm font-color-tertiary">Works with collections</span>
                </div>
            ),
        },
        {
            label: 'Global',
            onClick: () => handleAddAction('global'),
            customContent: (
                <div className="display-flex flex-col">
                    <span className="text-sm font-color-primary">Global</span>
                    <span className="text-sm font-color-tertiary">Works anywhere, no context needed</span>
                </div>
            ),
        },
    ], [handleAddAction]);

    return (
        <>
            <div className="display-flex flex-row items-end justify-between">
                <SectionLabel>Actions</SectionLabel>
                <MenuButton
                    menuItems={addActionMenuItems}
                    buttonLabel="Add Action"
                    variant="outline"
                    className="text-sm mb-15"
                    width="220px"
                    customContent={
                        <span className="display-flex items-center gap-1">
                            <Icon icon={PlusSignIcon} className="scale-80" />
                            <span>Add Action</span>
                        </span>
                    }
                />
            </div>
            <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                Reusable prompts you can trigger from the slash menu or homepage.
                Use <code className="text-xs" style={{ padding: '1px 4px', borderRadius: '3px', background: 'var(--material-mix-quarternary)' }}>{"{{active_item}}"}</code>,{' '}
                <code className="text-xs" style={{ padding: '1px 4px', borderRadius: '3px', background: 'var(--material-mix-quarternary)' }}>{"{{selected_items}}"}</code>, or{' '}
                <code className="text-xs" style={{ padding: '1px 4px', borderRadius: '3px', background: 'var(--material-mix-quarternary)' }}>{"{{recent_items}}"}</code> to insert context.
                {' '}<DocLink path="actions">Learn more</DocLink>.
            </div>
            <SettingsGroup>
                {actions.map((action: Action, index: number) => {
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

            {/* Hidden built-ins restore section */}
            {hiddenBuiltins.length > 0 && (
                <details className="mt-4">
                    <summary className="text-sm font-color-tertiary cursor-pointer">
                        Hidden actions ({hiddenBuiltins.length})
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
