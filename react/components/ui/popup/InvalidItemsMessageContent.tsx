import React from 'react';
import { CSSItemTypeIcon } from '../../icons/icons';
import { truncateText } from '../../../utils/stringUtils';

const MAX_ITEM_TEXT_LENGTH = 40;

interface InvalidItemInfo {
    item: Zotero.Item;
    reason: string;
}

interface InvalidItemsMessageContentProps {
    invalidItems: InvalidItemInfo[];
}

/**
 * Custom popup content for displaying invalid items that were removed
 * Shows item icon, display name, and reason for removal
 */
export const InvalidItemsMessageContent: React.FC<InvalidItemsMessageContentProps> = ({ invalidItems }) => {
    return (
        <div id="invalid-items-message-content" className="display-flex flex-col gap-3">
            {invalidItems.map(({ item, reason }, index) => {                
                return (
                    <div key={item.key || index} className="display-flex flex-col gap-1">
                        <div className="font-color-tertiary text-md ml-05">{reason}</div>
                    </div>
                );
            })}
        </div>
    );
};

