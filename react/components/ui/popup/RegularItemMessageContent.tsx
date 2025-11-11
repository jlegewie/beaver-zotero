import React, { useState } from 'react';
import { truncateText } from '../../../utils/stringUtils';
import { CSSIcon, CSSItemTypeIcon, ArrowDownIcon, ArrowRightIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import Button from '../Button';
import { MessageItemSummary, useMessageItemSummary } from '../../../hooks/useMessageItemSummary';
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';

interface RegularItemMessageContentProps {
    item: Zotero.Item;
    summary?: MessageItemSummary | null;
}

/**
 * Custom popup content for displaying invalid items that were removed
 * Shows item icon, display name, and reason for removal
 */
export const RegularItemMessageContent: React.FC<RegularItemMessageContentProps> = ({ item, summary: summaryOverride }) => {
    const [validAttachmentsVisible, setValidAttachmentsVisible] = useState<boolean>(false);
    const [invalidAttachmentsVisible, setInvalidAttachmentsVisible] = useState<boolean>(false);

    const computedSummary = useMessageItemSummary(item);
    const summary = summaryOverride ?? computedSummary;

    const validAttachmentsCount = summary?.validAttachmentCount ?? 0;
    const invalidAttachments = summary?.invalidAttachments ?? [];
    const validAttachmentsList = summary?.validAttachments ?? [];

    const toggleValidAttachments = () => {
        setValidAttachmentsVisible((prev: boolean) => !prev);
    };

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

    return (
        <div className="display-flex flex-col gap-3 -ml-1">
            <div className="display-flex flex-row items-center gap-2 ml-15">
                <div className="font-color-secondary text-md">{truncateText(item.getDisplayTitle(), 200)}</div>
            </div>
            <div id="parent-item" className="display-flex flex-col gap-2">
                {/* Valid Attachments Section */}
                <Button
                    variant="ghost-secondary"
                    onClick={toggleValidAttachments}
                    rightIcon={validAttachmentsVisible ? ArrowDownIcon : validAttachmentsCount === 0 ? undefined : ArrowRightIcon}
                    iconClassName="scale-12 -ml-1"
                    disabled={validAttachmentsCount === 0}
                >
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.ATTACHMENTS} 
                        size={15} 
                        color="--accent-green"
                        className="mr-1"
                    />
                    <span className="font-color-secondary">{validAttachmentsCount} Attachment{validAttachmentsCount !== 1 ? 's' : ''} available</span>
                </Button>
                {validAttachmentsVisible && (
                    <div className="display-flex flex-col gap-2 max-height-200 overflow-y-auto">
                        {validAttachmentsList.map((attachment, index) => {
                            const displayName = getDisplayName(attachment);
                            
                            return (
                                <div key={attachment.key || index} className="display-flex flex-col gap-1 ml-4">
                                    <div className="display-flex flex-row items-start gap-1">
                                        <div className="flex-shrink-0 -mt-010 scale-80">
                                            <CSSItemTypeIcon itemType={attachment.getItemTypeIconName()} />
                                        </div>
                                        <div className="display-flex flex-col min-w-0 gap-1 text-sm">
                                            <div className="font-color-secondary text-md truncate">{displayName}</div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Invalid Attachments Section */}
                {invalidAttachments.length > 0 && (
                    <>
                        <Button
                            variant="ghost-secondary"
                            onClick={toggleInvalidAttachments}
                            rightIcon={invalidAttachmentsVisible ? ArrowDownIcon : ArrowRightIcon}
                            iconClassName="scale-12 -ml-1"
                        >
                            <CSSIcon name="x-8" className="icon-16 font-color-error scale-11 mr-1" style={{ fill: 'red' }}/>
                            <span>{invalidAttachments.length} Attachment{invalidAttachments.length !== 1 ? 's' : ''} skipped</span>
                        </Button>
                        {invalidAttachmentsVisible && (
                            <div className="display-flex flex-col gap-2 max-height-200 overflow-y-auto">
                                {invalidAttachments.map(({ item, reason }, index) => {
                                    const displayName = getDisplayName(item);
                                    
                                    return (
                                        <div key={item.key || index} className="display-flex flex-col gap-1 ml-4">
                                            <div className="display-flex flex-row items-start gap-1">
                                                <div className="flex-shrink-0 -mt-010 scale-80">
                                                    <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                                                </div>
                                                <div className="display-flex flex-col min-w-0 gap-1 text-sm">
                                                    <div className="font-color-secondary text-md truncate">{displayName}</div>
                                                </div>
                                            </div>
                                            {reason && (
                                                <div className="font-color-tertiary text-md ml-1 text-sm">
                                                    {parseTextWithLinksAndNewlines(reason)}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {/* No attachments message */}
                {validAttachmentsCount === 0 && (
                    <div className="font-color-tertiary text-md ml-15">
                        Only metadata (title etc.) shared with the model
                    </div>
                )}
            </div>
        </div>
    );
};
