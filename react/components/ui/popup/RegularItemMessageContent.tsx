import React from 'react';
import { CSSIcon, CSSItemTypeIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';

interface InvalidItemInfo {
    item: Zotero.Item;
    reason: string;
}

interface RegularItemMessageContentProps {
    item: Zotero.Item;
    attachments: Zotero.Item[];
    invalidAttachments: InvalidItemInfo[];
}

/**
 * Custom popup content for displaying invalid items that were removed
 * Shows item icon, display name, and reason for removal
 */
export const RegularItemMessageContent: React.FC<RegularItemMessageContentProps> = ({ item, attachments, invalidAttachments }) => {
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
        <div className="display-flex flex-col gap-3">
            <div id="parent-item" className="display-flex flex-col gap-3">
                <div className="display-flex flex-col font-color-secondary text-md gap-2">
                    <div className="display-flex items-center font-color-secondary mb-2">
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={15} 
                            color="--accent-green"
                            className="mr-2"
                        />
                        <span>{attachments.length} Attachment{invalidAttachments.length !== 1 ? 's' : ''} added</span>
                        
                        <span className="mx-1"></span>
                        
                        <CSSIcon name="x-8" className="icon-16 font-color-error scale-11" style={{ fill: 'red' }}/>
                        <span>{invalidAttachments.length} attachment{invalidAttachments.length !== 1 ? 's' : ''} skipped</span>
                    </div>
                    <div className="font-color-secondary text-md">
                        Some attachments are invalid. Valid attachments and metadata have been added to the conversation.
                    </div>
                </div>
                {/* {attachments.map((item, index) => {
                    const displayName = getDisplayName(item);
                    
                    return (
                        <div key={item.key || index} className="display-flex flex-col gap-1">
                            <div className="display-flex flex-row items-start gap-1">
                                <div className="flex-shrink-0 -mt-010 scale-95">
                                    <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                                </div>
                                <div className="display-flex flex-col min-w-0 gap-1">
                                    <div className="font-color-secondary text-md truncate">{displayName}</div>
                                </div>
                            </div>
                        </div>
                    );
                })} */}
                {invalidAttachments.map(({ item, reason }, index) => {
                    const displayName = getDisplayName(item);
                    
                    return (
                        <div key={item.key || index} className="display-flex flex-col gap-1">
                            <div className="display-flex flex-row items-start gap-1">
                                <div className="flex-shrink-0 -mt-010 scale-95">
                                    {/* <CSSItemTypeIcon itemType={item.getItemTypeIconName()} /> */}
                                    <CSSIcon name="x-8" className="icon-16 font-color-error scale-11" style={{ fill: 'red' }}/>
                                </div>
                                <div className="display-flex flex-col min-w-0 gap-1">
                                    <div className="font-color-secondary text-md truncate">{displayName}</div>
                                    <div className="font-color-tertiary text-md">{reason}</div>
                                </div>
                            </div>
                            {/* <div className="font-color-tertiary text-md ml-05">{reason}</div> */}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

