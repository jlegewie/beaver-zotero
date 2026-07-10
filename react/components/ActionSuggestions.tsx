import React from "react";
import Button from "./ui/Button";
import { useAtomValue } from "jotai";
import { Action } from "../types/actions";
import { actionsForContextAtom, actionContextAtom } from "../atoms/actions";
import { useActionRunner } from "../hooks/useActionRunner";
import { getActiveTarget } from "../utils/actionVisibility";
import { searchableLibraryIdsAtom } from "../atoms/profile";
import { CSSIcon, CSSItemTypeIcon } from "./icons/zotero";
import Icon from "./icons/Icon";
import { AlertIcon, SettingsIcon, ZapIcon } from './icons/icons';
import { openPreferencesWindow } from "../../src/ui/openPreferencesWindow";
import IconButton from "./ui/IconButton";

interface ActionSuggestionsProps {
    /** When true, global actions are always shown. When false, global actions only appear if no context-specific actions match. */
    showGlobal?: boolean;
    style?: React.CSSProperties;
    /**
     * Layout variant.
     * - `default`: self-contained block with an "Actions for …" header on top.
     * - `panel`:   the header is omitted (the caller renders its own category
     *              control) and the target-item label is moved to a footer
     *              below the action list.
     */
    variant?: 'default' | 'panel';
}


const ActionSuggestions: React.FC<ActionSuggestionsProps> = ({ showGlobal = true, style, variant = 'default' }) => {
    const contextActions = useAtomValue(actionsForContextAtom);
    const ctx = useAtomValue(actionContextAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const { runAction, isBusy } = useActionRunner();

    // Check if the current library is supported
    const currentLibraryId = ctx.zotero.isLibraryTab
        ? ctx.zotero.libraryView.libraryId
        : ctx.zotero.readerAttachment?.libraryID ?? ctx.zotero.noteItem?.libraryID ?? null;
    const isLibrarySupported = currentLibraryId && searchableLibraryIds.includes(currentLibraryId);

    // Determine the single active target type the surface binds to
    const active = getActiveTarget(ctx);

    const targetActions = active
        ? contextActions.filter(a => a.targets.includes(active.targetType))
        : [];
    const globalActions = contextActions.filter(a =>
        a.targets.includes('global') && !targetActions.includes(a)
    );

    let actions: Action[];
    if (targetActions.length > 0) {
        actions = showGlobal ? [...targetActions, ...globalActions] : targetActions;
    } else {
        actions = globalActions;
    }

    // The default variant renders nothing when there are no actions. The panel
    // variant always renders so the expanded category shows an empty hint and
    // its footer (target item + edit control).
    if (variant === 'default' && actions.length === 0) return null;

    // Only show context label when context-specific actions are displayed
    const contextLabel = targetActions.length > 0 ? active?.label ?? null : null;


    const contextLabelElement = contextLabel ? (
        <div
            className="font-color-secondary display-flex items-center gap-1 min-w-0"
            style={{ fontSize: '0.925rem' }}
        >
            {active?.iconInfo && (
                <span className="scale-80 flex-shrink-0" style={{ filter: 'grayscale(1)' }}>
                    {active.iconInfo.type === 'item-type'
                        ? <CSSItemTypeIcon itemType={active.iconInfo.name} className="icon-16" />
                        : <CSSIcon name={active.iconInfo.name} className="icon-16" />}
                </span>
            )}
            {/* <span className="font-semibold truncate">{truncateText(contextLabel, 40)}</span> */}
            <span className="font-medium truncate">{contextLabel}</span>
        </div>
    ) : null;

    const actionButtons = actions.map((action) => (
        <Button
            key={action.id}
            variant="ghost"
            onClick={(e) => runAction(action, e.currentTarget.ownerDocument.defaultView)}
            disabled={isBusy || !isLibrarySupported}
            className="w-full justify-between"
            style={{ padding: '6px 6px' }}
        >
            <span className="text-base truncate">
                {action.title}
            </span>
        </Button>
    ));

    const notSyncedWarning = !isLibrarySupported ? (
        <div className="display-flex flex-row gap-1 items-start font-color-tertiary mt-3">
            <Icon icon={AlertIcon} className="mt-010" />
            <div className="text-sm">
                This library is not synced with Beaver
            </div>
        </div>
    ) : null;

    // Panel variant: no header (the launcher row owns the category control) and
    // the target item is shown in a footer below the actions ("the item the
    // action applies to" moves to the bottom).
    if (variant === 'panel') {
        return (
            <div className="display-flex flex-col gap-05 px-1" style={style}>
                {actions.length > 0 ? actionButtons : (
                    <div className="font-color-tertiary text-sm px-1 py-2">
                        No actions available for the current selection.
                    </div>
                )}
                <div className="display-flex flex-row items-center gap-2 mt-2 pt-2 border-top-quinary">
                    <div className="flex-1 min-w-0">
                        {contextLabelElement}
                    </div>
                    <IconButton
                        variant="ghost-tertiary"
                        onClick={() => openPreferencesWindow('actions')}
                        icon={SettingsIcon}
                        ariaLabel="Edit actions"
                        title="Edit actions"
                    />
                </div>
                {notSyncedWarning}
            </div>
        );
    }

    return (
        <div className="display-flex flex-col gap-05 mt-3 ml-1" style={style}>
            <div className="display-flex flex-row gap-1 items-center mb-1 font-color-tertiary" style={style}>
                <Icon icon={ZapIcon} />
                <div className="display-flex flex-row gap-1 items-center min-w-0">
                    <div className="font-color-tertiary font-semibold flex-shrink-0" style={{ whiteSpace: 'nowrap', fontSize: '0.925rem' }}>
                        Actions {contextLabel ? `for` : ''}
                    </div>
                    {contextLabelElement}
                </div>

                <div className="flex-1" />
                <IconButton
                    variant="ghost-tertiary"
                    onClick={() => openPreferencesWindow('actions')}
                    icon={SettingsIcon}
                />

            </div>
            {actionButtons}
            {notSyncedWarning}
        </div>
    );
};

export default ActionSuggestions;
