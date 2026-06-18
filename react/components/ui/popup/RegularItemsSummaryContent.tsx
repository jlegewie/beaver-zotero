import React from 'react';
import { CSSItemTypeIcon, CSSIcon, Icon, TickIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import { toAnnotation } from '../../../types/attachments/converters';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { truncateText } from '../../../utils/stringUtils';

/**
 * Icon for a row in the overflow items summary preview.
 */
function ItemSummaryIcon({ item }: { item: Zotero.Item }) {
    if (item.isAnnotation()) {
        const annotation = toAnnotation(item);
        const icon = annotation?.annotation_type
            ? ANNOTATION_ICON_BY_TYPE[annotation.annotation_type] || ZOTERO_ICONS.ANNOTATION
            : ZOTERO_ICONS.ANNOTATION;
        return <ZoteroIcon icon={icon} size={14} className="mt-1"/>;
    }

    const itemType = item.getItemTypeIconName();
    return (
        <span className="scale-80">
            <CSSItemTypeIcon itemType={itemType} />
        </span>
    );
}

/**
 * Display label for a row in the overflow items summary preview.
 */
function getItemSummaryDisplayName(item: Zotero.Item): string {
    if (item.isAnnotation()) {
        const annotation = toAnnotation(item);
        if (annotation?.annotation_type) {
            return ANNOTATION_TEXT_BY_TYPE[annotation.annotation_type] || 'Annotation';
        }
        return 'Annotation';
    }
    if (item.isRegularItem()) {
        return truncateText(getDisplayNameFromItem(item), 50);
    }
    return item.getDisplayTitle();
}

interface RegularItemSummary {
    item: Zotero.Item;
    totalAttachments: number;
    readableAttachments: number;
    unreadableAttachments: number;
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
                const displayName = getItemSummaryDisplayName(itemSummary.item);
                const readableCount = Math.max(itemSummary.readableAttachments, 0);
                const hasNoAttachments = itemSummary.totalAttachments === 0;
                
                return (
                    <div key={itemSummary.item.key} className="display-flex flex-col gap-2">
                        <div className="display-flex items-start gap-1">
                            <div className="flex-shrink-0 -mt-010">
                                <ItemSummaryIcon item={itemSummary.item} />
                            </div>
                            <div className="display-flex flex-col gap-1">
                                <div className="font-color-secondary truncate">
                                    {displayName}
                                </div>
                            </div>
                        </div>
                        {itemSummary.item.isRegularItem() && (
                            <div className="display-flex flex-row font-color-tertiary gap-2 ml-15 text-md">
                                {hasNoAttachments ? (
                                    <span>Only metadata (title etc.) shared with the model</span>
                                ) : (
                                    <div className="display-flex items-center flex-row gap-1">
                                        {readableCount > 0 && (
                                            <Icon icon={TickIcon} size={15} className="scale-12 font-color-accent-green" />
                                        )}
                                        {readableCount === 0 && (
                                            <CSSIcon name="x-8" className="icon-16 font-color-error" style={{ fill: 'red' }}/>
                                        )}
                                        <span>{readableCount}/{itemSummary.totalAttachments} Attachment{itemSummary.totalAttachments !== 1 ? 's' : ''} readable</span>
                                    </div>
                                )}

                                {!hasNoAttachments && itemSummary.unreadableAttachments > 0 && (
                                    <div className="display-flex items-center flex-row gap-1">
                                        <CSSIcon name="x-8" className="icon-16 font-color-error" style={{ fill: 'red' }}/>
                                        <span>{itemSummary.unreadableAttachments} not readable</span>
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
