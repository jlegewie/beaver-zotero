import React from "react";
import { useAtomValue } from "jotai";
import MenuButton from "@beaver/agent-ui/primitives/MenuButton";
import { MenuItem } from "@beaver/agent-ui/primitives/ContextMenu";
import { Icon, ArrowDownIcon, FolderDetailIcon } from "./icons/icons";
import { CSSIcon, CSSItemTypeIcon } from "./icons/zotero";
import { categoryIcon } from "./icons/categoryIcons";
import { actionGroupsAtom } from "../atoms/actions";
import { primaryActionGroup, type ActionGroup } from "../utils/actionVisibility";
import { useActionRunner } from "../hooks/useActionRunner";
import { useSurfaceWindow } from "../runtime/SurfaceWindowContext";

const ProjectChip: React.FC = () => (
    <MenuButton
        variant="ghost"
        className="home-context-bar__chip home-context-bar__project"
        ariaLabel="Project"
        maxWidth="240px"
        menuItems={[{ label: "Projects are coming soon", onClick: () => {}, disabled: true }]}
        customContent={
            <>
                <Icon icon={FolderDetailIcon} size={14} className="flex-shrink-0" />
                <span className="truncate">No project</span>
                <Icon icon={ArrowDownIcon} size={10} className="flex-shrink-0 home-context-bar__caret" />
            </>
        }
    />
);

const GroupIcon: React.FC<{ group: ActionGroup }> = ({ group }) => {
    const info = group.iconInfo;
    if (!info) return null;
    return (
        <span className="scale-80 flex-shrink-0 display-flex items-center">
            {info.type === 'item-type'
                ? <CSSItemTypeIcon itemType={info.name} className="icon-16" />
                : <CSSIcon name={info.name} className="icon-16" />}
        </span>
    );
};

/**
 * Bar tucked under the homepage composer. The project sits on the left and is
 * always shown; what Beaver would act on (the open file, attached or selected
 * items, the selected collection) sits on the right, only when there is
 * something, and opens the actions for it. The bar keeps its height either
 * way, so selecting things in Zotero never moves the rest of the homepage.
 */
const HomeContextBar: React.FC = () => {
    const group = primaryActionGroup(useAtomValue(actionGroupsAtom));
    const { runAction, isBusy } = useActionRunner();
    const surfaceWindow = useSurfaceWindow();

    const menuItems: MenuItem[] = group
        ? [
            { label: "Actions", onClick: () => {}, isGroupHeader: true },
            ...group.actions.map((action): MenuItem => ({
                label: action.title,
                icon: categoryIcon(action.category),
                disabled: isBusy,
                onClick: () => runAction(action, group.bind(action), surfaceWindow),
            })),
            { label: "", onClick: () => {}, isDivider: true },
            { label: "Type / in the message for all actions", onClick: () => {}, disabled: true },
        ]
        : [];

    return (
        <div className="home-context-bar">
            <ProjectChip />
            {group && (
                <div className="home-context-bar__selection">
                    <MenuButton
                        variant="ghost"
                        className="home-context-bar__chip"
                        ariaLabel={`Actions for ${group.label}`}
                        tooltipContent="Actions for this selection"
                        maxWidth="280px"
                        maxHeight="360px"
                        menuItems={menuItems}
                        customContent={
                            <>
                                <GroupIcon group={group} />
                                <span className="truncate">{group.label}</span>
                                <Icon icon={ArrowDownIcon} size={10} className="flex-shrink-0 home-context-bar__caret" />
                            </>
                        }
                    />
                </div>
            )}
        </div>
    );
};

export default HomeContextBar;
