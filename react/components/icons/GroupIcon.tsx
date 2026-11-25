import React from "react";
import { CSSIcon, CSSItemTypeIcon } from "./zotero";
import type { GroupIconInfo } from "../../utils/actionVisibility";

/** The Zotero icon for an action group's source (item type or collection). */
const GroupIcon: React.FC<{ info: GroupIconInfo }> = ({ info }) =>
    info.type === 'item-type'
        ? <CSSItemTypeIcon itemType={info.name} className="icon-16" />
        : <CSSIcon name={info.name} className="icon-16" />;

export default GroupIcon;
