import React, { useState } from 'react';
import { CSSIcon, CSSItemTypeIcon, ArrowDownIcon, ArrowRightIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import Button from '../Button';

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
    const [invalidAttachmentsVisible, setInvalidAttachmentsVisible] = useState<boolean>(false);

    const validAttachments = attachments.length - invalidAttachments.length;

    const toggleInvalidAttachments = () => {
        setInvalidAttachmentsVisible((prev: boolean) => !prev);
    };

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
                    <div className="display-flex items-center font-color-secondary mb-1 mt-1">
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={15} 
                            color="--accent-green"
                            className="mr-2"
                        />
                        <span>{validAttachments} Attachment{validAttachments !== 1 ? 's' : ''} added</span>
                        
                        <span className="mx-1"></span>
                        
                        <CSSIcon name="x-8" className="icon-16 font-color-error scale-11" style={{ fill: 'red' }}/>
                        <span>{invalidAttachments.length} attachment{invalidAttachments.length !== 1 ? 's' : ''} skipped</span>
                    </div>
                    {validAttachments === 0 && (
                        <div className="font-color-secondary text-md">
                            All attachments are invalid. Only item metadata (title, authors, etc.) will be shared with the model.
                        </div>
                    )}
                </div>
                {invalidAttachments.length > 0 && (
                    <Button
                        variant="ghost-secondary"
                        onClick={toggleInvalidAttachments}
                        icon={invalidAttachmentsVisible ? ArrowDownIcon : ArrowRightIcon}
                        iconClassName="mr-0 scale-12 -ml-1"
                    >
                        <span>
                            Show skipped attachment{invalidAttachments.length === 1 ? '' : 's'}
                        </span>
                    </Button>
                )}
                {invalidAttachmentsVisible && invalidAttachments.map(({ item, reason }, index) => {
                    const displayName = getDisplayName(item);
                    
                    return (
                        <div key={item.key || index} className="display-flex flex-col gap-1 ml-1">
                            <div className="display-flex flex-row items-start gap-1">
                                <div className="flex-shrink-0 -mt-010 scale-80">
                                    {/* <CSSIcon name="x-8" className="icon-16 font-color-error scale-11" style={{ fill: 'red' }}/> */}
                                    <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                                </div>
                                <div className="display-flex flex-col min-w-0 gap-1 text-sm">
                                    <div className="font-color-secondary text-md truncate">{displayName}</div>
                                </div>
                            </div>
                            <div className="font-color-tertiary text-md ml-1 text-sm">{reason}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

