import React from "react";
import { useAtomValue } from "jotai";
import Button from "./ui/Button";
import IconButton from "./ui/IconButton";
import Icon from "./icons/Icon";
import { CSSIcon, CSSItemTypeIcon } from "./icons/zotero";
import { AlertIcon, SettingsIcon } from "./icons/icons";
import { Action, ActionCategory, TARGET_TYPE_LABELS } from "../types/actions";
import { actionsForContextAtom, actionContextAtom } from "../atoms/actions";
import { searchableLibraryIdsAtom } from "../atoms/profile";
import { GroupIconInfo, splitCategoryActions } from "../utils/actionVisibility";
import { getActiveTarget } from "./ActionSuggestions";
import { useActionRunner } from "../hooks/useActionRunner";
import { openPreferencesWindow } from "../../src/ui/openPreferencesWindow";

interface CategoryPanelProps {
    /** A skill category, or `null` for the uncategorized "Actions" bucket. */
    category: ActionCategory | null;
    style?: React.CSSProperties;
}

/** Section header — the selected target (with its item icon) or "Library-wide". */
const SectionHeader: React.FC<{ label: string; iconInfo?: GroupIconInfo }> = ({ label, iconInfo }) => (
    <div
        className="display-flex flex-row items-center gap-1 min-w-0 font-color-primary opacity-90"
        style={{
            fontSize: '0.925rem',
            padding: iconInfo ? '3px' : '6px',
        }}
    >
        {iconInfo && (
            <span className="scale-80 flex-shrink-0" style={{ filter: 'grayscale(1)' }}>
                {iconInfo.type === 'item-type'
                    ? <CSSItemTypeIcon itemType={iconInfo.name} className="icon-16" />
                    : <CSSIcon name={iconInfo.name} className="icon-16" />}
            </span>
        )}
        <span className="font-medium truncate">{label}</span>
    </div>
);

/**
 * Homepage launcher panel for one bucket — a skill category (Research /
 * Organize / Annotate) or the uncategorized "Actions" bucket (`category={null}`).
 */
const CategoryPanel: React.FC<CategoryPanelProps> = ({ category, style }) => {
    const contextActions = useAtomValue(actionsForContextAtom);
    const ctx = useAtomValue(actionContextAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const { runAction, isBusy } = useActionRunner();

    // Whether the current library is synced with Beaver (mirrors ActionSuggestions).
    const currentLibraryId = ctx.zotero.isLibraryTab
        ? ctx.zotero.libraryView.libraryId
        : ctx.zotero.readerAttachment?.libraryID ?? ctx.zotero.noteItem?.libraryID ?? null;
    const isLibrarySupported = !!(currentLibraryId && searchableLibraryIds.includes(currentLibraryId));

    const active = getActiveTarget(ctx);
    const { targetActions, globalActions } = splitCategoryActions(contextActions, category, active?.targetType ?? null);

    const renderAction = (action: Action) => (
        // <div className="border-bottom-quinary">
            <Button
                key={action.id}
                variant="ghost"
                onClick={() => runAction(action)}
                disabled={!isLibrarySupported || isBusy}
                className="w-full justify-between"
                style={{ padding: '6px 6px' }}
            >
                <span className="text-base truncate">{action.title}</span>
            </Button>
        // </div>
    );

    const hasAny = targetActions.length > 0 || globalActions.length > 0;

    return (
        <div className="display-flex flex-col gap-5 p-1" style={style}>
            {!hasAny && (
                <div className="font-color-tertiary text-sm px-1 py-2">
                    No actions available for the current selection.
                </div>
            )}

            {globalActions.length > 0 && (
                <div className="display-flex flex-col gap-1">
                    <SectionHeader label="Library-wide" />
                    {globalActions.map(renderAction)}
                </div>
            )}

            {targetActions.length > 0 && (
                <div className="display-flex flex-col gap-1">
                    <SectionHeader
                        label={active?.label ?? (active ? TARGET_TYPE_LABELS[active.targetType] : '')}
                        iconInfo={active?.iconInfo}
                    />
                    {targetActions.map(renderAction)}
                </div>
            )}

            {/* Footer — edit actions + not-synced warning */}
            <div className="display-flex flex-row items-center gap-2 mt-2 pt-2 border-top-quinary">
                <div className="flex-1" />
                <Button
                    variant="outline"
                    onClick={() => openPreferencesWindow('actions')}
                    icon={SettingsIcon}
                    ariaLabel="Edit actions"
                    title="Edit actions"
                >
                    Configure
                </Button>
            </div>
            {!isLibrarySupported && (
                <div className="display-flex flex-row gap-1 items-start font-color-tertiary mt-1">
                    <Icon icon={AlertIcon} className="mt-010" />
                    <div className="text-sm">
                        This library is not synced with Beaver
                    </div>
                </div>
            )}
        </div>
    );
};

export default CategoryPanel;
