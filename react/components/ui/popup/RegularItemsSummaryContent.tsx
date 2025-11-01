import React from 'react';
import { CSSItemTypeIcon, CSSIcon } from '../../icons/icons';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { truncateText } from '../../../utils/stringUtils';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';

interface RegularItemSummary {
    item: Zotero.Item;
    totalAttachments: number;
    invalidAttachments: number;
}

interface RegularItemsSummaryContentProps {
    items: RegularItemSummary[];
}

/**
 * Summary content for multiple regular items showing their attachment status
 */
export const RegularItemsSummaryContent: React.FC<RegularItemsSummaryContentProps> = ({ items }) => {
    return (
        <div className="display-flex flex-col gap-3">
            {items.map((itemSummary) => {
                const displayName = itemSummary.item.isRegularItem()
                    ? truncateText(getDisplayNameFromItem(itemSummary.item), 50)
                    : itemSummary.item.getDisplayTitle();
                const itemType = itemSummary.item.getItemTypeIconName();
                
                return (
                    <div key={itemSummary.item.key} className="display-flex flex-col gap-1">
                        <div className="display-flex items-start gap-1">
                            <div className="flex-shrink-0 mt-0.5">
                                <CSSItemTypeIcon itemType={itemType} />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <div className="truncate">
                                    {displayName}
                                </div>
                            </div>
                        </div>
                            {/* <div className="text-xs text-gray-600 dark:text-gray-400">
                                {itemSummary.totalAttachments} Attachment{itemSummary.totalAttachments !== 1 ? 's' : ''}
                                {itemSummary.invalidAttachments > 0 && (
                                    <span className="text-red-600 dark:text-red-400">
                                        {' '}· {itemSummary.invalidAttachments} Invalid
                                    </span>
                                )}
                            </div> */}
                            {itemSummary.item.isRegularItem() && (
                                <div className="display-flex flex-row font-color-tertiary gap-1">
                                    <div className="display-flex items-center flex-row">
                                        <ZoteroIcon 
                                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                                            size={14} 
                                            color="--fill-tertiary"
                                            className="mr-2"
                                        />
                                        <span>{itemSummary.totalAttachments} Attachment{itemSummary.totalAttachments !== 1 ? 's' : ''}</span>
                                    </div>

                                    {itemSummary.invalidAttachments > 0 && (
                                        <div className="display-flex items-center flex-row">
                                            <CSSIcon name="x-8" className="icon-16 scale-11" style={{ fill: 'var(--tag-red)' }}/>
                                            <span>{itemSummary.invalidAttachments} unavailable</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        
                        
                    </div>
                );
            })}
        </div>
    );
};

