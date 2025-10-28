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
    const getDisplayName = (item: Zotero.Item): string => {
        try {
            let name = item.getField('title') as string;
            if (!name || name.trim() === '') {
                name = Zotero.ItemTypes.getLocalizedString(item.itemTypeID);
            }
            // return truncateText(name, MAX_ITEM_TEXT_LENGTH);
            return name;
        } catch (error) {
            return 'Unknown Item';
        }
    };

    const getIconName = (item: Zotero.Item): string | null => {
        try {
            return item.getItemTypeIconName();
        } catch (error) {
            return null;
        }
    };

    return (
        <div id="invalid-items-message-content" className="display-flex flex-col gap-3">
            {invalidItems.map(({ item, reason }, index) => {
                const iconName = getIconName(item);
                const displayName = getDisplayName(item);
                
                return (
                    <div key={item.key || index} className="display-flex flex-col gap-1">
                        <div className="display-flex flex-row items-start gap-2">
                            {iconName && (
                                <div className="flex-shrink-0 -mt-010 scale-95">
                                    <CSSItemTypeIcon itemType={iconName} />
                                </div>
                            )}
                            {/* <div className="display-flex flex-col min-w-0 gap-1"> */}
                                <div className="font-color-secondary text-md truncate">{displayName}</div>
                            {/* </div> */}
                        </div>
                        <div className="font-color-tertiary text-md ml-05">{reason}</div>
                    </div>
                );
            })}
        </div>
    );
};

