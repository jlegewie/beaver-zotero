import React from "react";
import { useAtomValue } from "jotai";
import Button from "@beaver/agent-ui/primitives/Button";
import Tooltip from "@beaver/agent-ui/primitives/Tooltip";
import { ArrowUpRightIcon, ArrowRightIcon } from "./icons/icons";
import { Action, ActionCategory } from "@beaver/agent-core/types/actions";
import { actionsAtom, actionGroupsAtom } from "../atoms/actions";
import { bindingForAction } from "../utils/actionVisibility";
import { useActionRunner } from "../hooks/useActionRunner";
import { openPreferencesWindow } from "../ui/openPreferencesWindow";
import { buildActionPopup } from "@beaver/agent-ui/chat/actionPopup";
import { ChipPopupCard } from "@beaver/agent-ui/chat/ChipPopup";

interface CategoryPanelProps {
    category: ActionCategory;
    style?: React.CSSProperties;
}

/**
 * Homepage launcher panel for one category: the category's actions that work
 * without a selection. Actions for what is selected in Zotero live in the
 * actions tray under the input, so this list never changes with the
 * selection.
 */
const CategoryPanel: React.FC<CategoryPanelProps> = ({ category, style }) => {
    const allActions = useAtomValue(actionsAtom);
    const groups = useAtomValue(actionGroupsAtom);
    const { runAction, isBusy } = useActionRunner();

    const actions = allActions.filter(a => a.targets.includes('global') && a.category === category);

    const renderAction = (action: Action) => {
        const popup = buildActionPopup({
            title: action.title,
            description: action.description,
            prompt: action.text,
            category,
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
                    // An action that also takes a selection runs on it when
                    // one is in context, like it does from the slash menu.
                    onClick={(e) => runAction(action, bindingForAction(action, groups), e.currentTarget.ownerDocument.defaultView)}
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

    return (
        <div className="display-flex flex-col gap-4 p-1" style={style}>
            {actions.length === 0 ? (
                <div className="font-color-secondary text-sm px-2 py-2">
                    Create repeatable workflows for common research tasks
                </div>
            ) : (
                <div className="display-flex flex-col gap-0">
                    {actions.map(renderAction)}
                </div>
            )}

            <div className="display-flex flex-row items-center gap-2">
                <Button
                    variant="ghost"
                    onClick={() => openPreferencesWindow('actions', { category })}
                    rightIcon={ArrowRightIcon}
                    iconClassName="mt-010"
                    ariaLabel="Add custom action"
                    title="Add custom action"
                    style={{ padding: '4px 6px', gap: '4px' }}
                >
                    Add Custom Action
                </Button>
            </div>
        </div>
    );
};

export default CategoryPanel;
