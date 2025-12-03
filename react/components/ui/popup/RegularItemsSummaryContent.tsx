import React from 'react';
import { CSSItemTypeIcon, CSSIcon, Icon, TickIcon } from '../../icons/icons';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { truncateText } from '../../../utils/stringUtils';

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
        <div className="display-flex flex-col gap-15">
            {items.map((itemSummary) => {
                const displayName = itemSummary.item.isRegularItem()
                    ? truncateText(getDisplayNameFromItem(itemSummary.item), 50)
                    : itemSummary.item.getDisplayTitle();
                const itemType = itemSummary.item.getItemTypeIconName();
                const validCount = Math.max(itemSummary.totalAttachments - itemSummary.invalidAttachments, 0);
                
                return (
                    <div key={itemSummary.item.key} className="display-flex flex-col gap-2">
                        <div className="display-flex items-start gap-1">
                            <div className="flex-shrink-0 -mt-010 scale-80">
                                <CSSItemTypeIcon itemType={itemType} />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <div className="font-color-secondary truncate">
                                    {displayName}
                                </div>
                            </div>
                        </div>
                        {itemSummary.item.isRegularItem() && (
                            <div className="display-flex flex-row font-color-tertiary gap-2 ml-15 text-md">
                                <div className="display-flex items-center flex-row gap-1">
                                    {validCount > 0 && (
                                        <Icon icon={TickIcon} size={15} className="scale-12 font-color-accent-green" />
                                    )}
                                    {validCount === 0 && (
                                        <CSSIcon name="x-8" className="icon-16 font-color-error" style={{ fill: 'red' }}/>
                                    )}
                                    <span>{validCount} Attachment{validCount !== 1 ? 's' : ''} available</span>
                                </div>

                                {itemSummary.invalidAttachments > 0 && (
                                    <div className="display-flex items-center flex-row gap-1">
                                        <CSSIcon name="x-8" className="icon-16 font-color-error" style={{ fill: 'red' }}/>
                                        <span>{itemSummary.invalidAttachments} skipped</span>
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

