import React from "react";
import { useAtomValue } from "jotai";
import Button from "./ui/Button";
import Tooltip from "./ui/Tooltip";
import { CSSIcon, CSSItemTypeIcon } from "./icons/zotero";
import { SettingsIcon, ArrowUpRightIcon } from "./icons/icons";
import { Action, ActionCategory, TARGET_TYPE_LABELS } from "../types/actions";
import { actionsForContextAtom, actionContextAtom } from "../atoms/actions";
import { GroupIconInfo, splitCategoryActions, getActiveTarget } from "../utils/actionVisibility";
import { useActionRunner } from "../hooks/useActionRunner";
import { openPreferencesWindow } from "../../src/ui/openPreferencesWindow";
import { buildActionPopup } from "./agentRuns/requestChips/actionPopup";
import { ChipPopupCard } from "./agentRuns/requestChips/ChipPopup";

interface CategoryPanelProps {
    /** A skill category, or `null` for the uncategorized "Actions" bucket. */
    category: ActionCategory | null;
    style?: React.CSSProperties;
}

/** Section header — the selected target (with its item icon) or "Library-wide". */
const SectionHeader: React.FC<{ label: string; iconInfo?: GroupIconInfo, className?: string }> = ({ label, iconInfo, className }) => (
    <div
        className={`display-flex flex-row items-center gap-1 min-w-0 font-color-primary opacity-90 ${className}`}
        style={{
            fontSize: '0.925rem',
            padding: iconInfo ? '3px' : '6px',
            paddingTop: '6px',
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
    const { runAction, isBusy } = useActionRunner();

    const active = getActiveTarget(ctx);
    const { targetActions, globalActions } = splitCategoryActions(contextActions, category, active?.targetType ?? null);

    // The uncategorized "Actions" bucket maps to the "uncategorized" filter value.
    const categoryFilter = category ?? "uncategorized";

    const renderAction = (action: Action) => {
        const popup = buildActionPopup({
            title: action.title,
            description: action.description,
            prompt: action.text,
            category: action.category ?? category ?? undefined,
        });
        popup.action = {
            icon: ArrowUpRightIcon,
            label: "Click to run action",
        };

        return (
            <Tooltip
                key={action.id}
                content={popup.title}
                customContent={<ChipPopupCard {...popup} />}
                width="260px"
                padding={false}
                horizontalAlign="start"
                anchorDisplay="block"
            >
                <Button
                    variant="ghost"
                    onClick={(e) => runAction(action, e.currentTarget.ownerDocument.defaultView)}
                    disabled={isBusy}
                    className="w-full justify-between"
                    style={{ padding: '6px 6px' }}
                    rightIcon={ArrowUpRightIcon}
                >
                    <span className="text-base truncate">{action.title}</span>
                </Button>
            </Tooltip>
        );
    };

    const hasAny = targetActions.length > 0 || globalActions.length > 0;

    return (
        <div className="display-flex flex-col gap-4 p-1" style={style}>
            {!hasAny && (
                <div className="font-color-secondary text-sm px-2 py-2">
                    Create repeatable workflows for common research tasks
                </div>
            )}

            {globalActions.length > 0 && (
                <div className="display-flex flex-col gap-1">
                    {/* <SectionHeader label="Library-wide" /> */}
                    {globalActions.map(renderAction)}
                </div>
            )}

            {targetActions.length > 0 && (
                <div className={`display-flex flex-col gap-1 ${globalActions.length > 0 ? 'border-top-quinary' : ''}`}>
                    <SectionHeader
                        label={active?.label ?? (active ? TARGET_TYPE_LABELS[active.targetType] : '')}
                        iconInfo={active?.iconInfo}
                    />
                    {targetActions.map(renderAction)}
                </div>
            )}

            {/* Footer — edit actions + not-synced warning */}
            <div className="display-flex flex-row items-center gap-2 pt-3">
                <div className="flex-1" />
                <Button
                    variant="ghost"
                    onClick={() => openPreferencesWindow('actions', categoryFilter)}
                    icon={SettingsIcon}
                    ariaLabel="Edit actions"
                    title="Edit actions"
                    style={{ padding: '4px 6px' }}
                >
                    Edit
                </Button>
            </div>
        </div>
    );
};

export default CategoryPanel;
