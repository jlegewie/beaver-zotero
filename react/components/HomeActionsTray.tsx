import React, { useRef } from "react";
import { useAtomValue } from "jotai";
import MenuButton from "@beaver/agent-ui/primitives/MenuButton";
import { MenuItem } from "@beaver/agent-ui/primitives/ContextMenu";
import { Icon, ArrowDownIcon, ZapIcon } from "./icons/icons";
import GroupIcon from "./icons/GroupIcon";
import { categoryIcon } from "./icons/categoryIcons";
import { actionGroupsAtom } from "../atoms/actions";
import { primaryActionGroup } from "../utils/actionVisibility";
import { useActionRunner } from "../hooks/useActionRunner";
import { useSlidePresence } from "../hooks/useSlidePresence";
import { useSurfaceWindow } from "../runtime/SurfaceWindowContext";

/**
 * Tray under the homepage input naming what Beaver would act on (the open
 * file, attached or selected items, the selected collection) and opening the
 * actions for it. It leads with the actions icon rather than the item's own
 * icon, so it doesn't read as another source chip. It slides out from under
 * the input when there is something to act on and back in when there no
 * longer is. Right-aligned, leaving the start of the line free for other
 * content.
 */
const HomeActionsTray: React.FC = () => {
    const group = primaryActionGroup(useAtomValue(actionGroupsAtom));
    const { runAction, isBusy } = useActionRunner();
    const surfaceWindow = useSurfaceWindow();
    const { ref, present, open, onTransitionEnd } = useSlidePresence<HTMLDivElement>(!!group);

    // While sliding out, keep showing what was there; let it go once gone.
    const lastGroupRef = useRef(group);
    if (group || !present) lastGroupRef.current = group;
    const shown = lastGroupRef.current;
    if (!present || !shown) return null;

    const menuItems: MenuItem[] = [
        ...shown.actions.map((action): MenuItem => ({
            label: action.title,
            icon: categoryIcon(action.category),
            disabled: isBusy || !group,
            onClick: () => runAction(action, shown.bind(action), surfaceWindow),
        })),
        { label: "", onClick: () => {}, isDivider: true },
        { label: "Type / in the message for all actions", onClick: () => {}, disabled: true },
    ];

    return (
        <div ref={ref} className="slide-presence" data-open={open} onTransitionEnd={onTransitionEnd}>
            <div className="slide-presence-clip">
                <div className="home-tray is-line home-actions-tray">
                    <MenuButton
                        variant="ghost"
                        className="home-actions-tray-button"
                        ariaLabel={`Actions for ${shown.label}`}
                        tooltipContent={`Actions for ${shown.subject ?? 'this selection'}`}
                        maxWidth="280px"
                        maxHeight="360px"
                        menuItems={menuItems}
                        align="end"
                        header={
                            <div className="home-actions-menu-header">
                                <div className="home-actions-menu-header-lead">Actions for</div>
                                <div className="home-actions-menu-header-name">
                                    {shown.iconInfo && (
                                        <span className="scale-80 flex-shrink-0 display-flex items-center">
                                            <GroupIcon info={shown.iconInfo} />
                                        </span>
                                    )}
                                    <span className="truncate">{shown.label}</span>
                                </div>
                            </div>
                        }
                        customContent={
                            <>
                                <Icon icon={ZapIcon} size={12} className="flex-shrink-0" />
                                <span className="truncate">{shown.shortLabel ?? shown.label}</span>
                                <Icon icon={ArrowDownIcon} size={10} className="flex-shrink-0 home-actions-tray-caret" />
                            </>
                        }
                    />
                </div>
            </div>
        </div>
    );
};

export default HomeActionsTray;
