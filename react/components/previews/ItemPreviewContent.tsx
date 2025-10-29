import React, { createElement, useEffect, useState } from 'react';
import { CancelIcon, CSSItemTypeIcon, CSSIcon } from '../icons/icons';
import { useSetAtom, useAtomValue } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { removeItemFromMessageAtom } from '../../atoms/messageComposition';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { openPDFInNewWindow } from '../../utils/openPDFInNewWindow';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { RegularItemMessageContent } from '../ui/popup/RegularItemMessageContent';
import PopupMessageHeader from '../ui/popup/PopupMessageHeader';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';

interface ItemPreviewContentProps {
    item: Zotero.Item;
    maxContentHeight: number;
    canRemove?: boolean;
}

const ItemPreviewContent: React.FC<ItemPreviewContentProps> = ({ 
    item, 
    maxContentHeight,
    canRemove = true 
}) => {
    const setActivePreview = useSetAtom(activePreviewAtom);
    const removeItem = useSetAtom(removeItemFromMessageAtom);
    const getValidation = useAtomValue(getItemValidationAtom);
    
    const [children, setChildren] = useState<Zotero.Item[]>([]);
    const [attachmentCount, setAttachmentCount] = useState<number>(0);
    const [noteCount, setNoteCount] = useState<number>(0);

    if (!item) {
        // If item becomes invalid while preview is open, close preview
        setActivePreview(null); 
        return null;
    }

    // Load children (attachments and notes) for regular items
    useEffect(() => {
        if (!item.isRegularItem()) return;
        
        const attachmentIds = item.getAttachments();
        const noteIds = item.getNotes();
        setAttachmentCount(attachmentIds.length);
        setNoteCount(noteIds.length);
        
        const childItems = [...attachmentIds, ...noteIds].map(id => Zotero.Items.get(id));
        setChildren(childItems);
    }, [item]);

    const handleRemove = () => {
        removeItem(item);
        setActivePreview(null);
    };

    const handleOpen = async () => {
        if (item.isNote()) {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
        } else {
            await openPDFInNewWindow(item);
        }
        setActivePreview(null);
    };

    // Determine if the item can be opened
    const canOpen =
        item.isPDFAttachment() ||
        (item.isRegularItem() && item.getAttachments().some(att => Zotero.Items.get(att).isPDFAttachment())) ||
        item.isNote();

    // Render validation icon for an item
    const renderValidationIcon = (childItem: Zotero.Item) => {
        const validation = getValidation(childItem);
        
        if (validation?.isValidating) {
            return <CSSIcon name="spinner" className="icon-12 scale-11" />;
        }
        
        if (validation && !validation.isValid) {
            return (
                <CSSIcon 
                    name="x-8" 
                    className="icon-16 font-color-error scale-11" 
                    style={{ fill: 'red' }}
                    title={validation.reason}
                />
            );
        }
        
        if (validation?.backendChecked && validation.isValid) {
            return <CSSIcon name="checkmark" className="icon-12 text-green" />;
        }
        
        // Default: show item icon
        return <CSSItemTypeIcon className="scale-85" itemType={childItem.getItemTypeIconName()} />;
    };

    // Render item preview content
    const renderContent = () => {
        const isRegularItem = item.isRegularItem();
        
        if (isRegularItem) {
            const invalidChildren = children
                .map(item => ({ item, validation: getValidation(item) }))
                .filter(({ validation }) => validation && !validation.isValid);
            const validItemIds = children.filter(child => !invalidChildren.some(invalidChild => invalidChild.item.id === child.id)).map(child => child.id);
            const invalidCount = invalidChildren.length;
            const validCount = children.length - invalidCount;
            // return (
            //     <div className="p-3 display-flex flex-col items-start gap-2">
            //         <PopupMessageHeader
            //             icon={createElement(CSSItemTypeIcon, { itemType: item.getItemTypeIconName() })}
            //             title={getDisplayNameFromItem(item)}
            //             handleDismiss={() => setActivePreview(null)}
            //         />
            //         <RegularItemMessageContent item={item} attachments={children} invalidAttachments={invalidChildren} />
            //     </div>
            // );
            return (
                <div className="mt-3">
                    <div className="display-flex items-center font-color-secondary mb-2">
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={15} 
                            color="--accent-green"
                            className="mr-2"
                        />
                        <span>{validCount} Attachment{validCount !== 1 ? 's' : ''}</span>
                        
                        <span className="mx-1"></span>
                        
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.NOTES}
                            size={15}
                            color="--accent-yellow"
                            className="mr-2"
                        />
                        <span>{invalidCount} Note{invalidCount !== 1 ? 's' : ''}</span>
                    </div>
                    
                    <div className="ml-6 display-flex flex-col gap-2">
                        {/* Attachments List */}
                        {children.map((child: Zotero.Item) => (
                            <div 
                                key={`att-${child.id}`}
                                className={`display-flex items-center ${validItemIds.includes(child.id) ? 'font-color-secondary' : 'font-color-red'}`}
                            >
                                <span className="mr-1 fit-content">
                                    {validItemIds.includes(child.id) ? (
                                    <CSSItemTypeIcon className="scale-85" itemType={child.getItemTypeIconName()} />
                                    ) : (
                                    <CSSIcon name="x-8" className="icon-16 font-color-error scale-11" style={{ fill: 'red' }}/>
                                    )}
                                </span>
                                {child.getDisplayTitle()}
                            </div>
                        ))}
                        
                        {/* Show message if no attachments or notes */}
                        {/* {attachmentNumber === 0 && noteNumber === 0 && (
                            <div className="text-gray-400 italic">No attachments or notes</div>
                        )} */}
                    </div>
                </div>
            )

        } else if (item.isAttachment()) {
            // Show attachment info
            const validation = getValidation(item);
            const isInvalid = validation && !validation.isValid && !validation.isValidating;
            
            try {
                const filename = item.attachmentFilename || 'Unnamed attachment';
                const contentType = item.attachmentContentType || 'Unknown type';
                const parentItem = item.parentItem;
                
                return (
                    <div className="space-y-2">
                        <div className="display-flex items-start gap-2">
                            <span className="mt-1 flex-shrink-0">
                                {renderValidationIcon(item)}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className={`font-weight-medium ${isInvalid ? 'font-color-red' : ''}`}>
                                    {filename}
                                </div>
                                <div className="text-sm font-color-secondary">{contentType}</div>
                            </div>
                        </div>
                        {isInvalid && validation.reason && (
                            <div className="text-sm font-color-error mt-2">{validation.reason}</div>
                        )}
                        {parentItem && (
                            <div className="mt-2">
                                <div className="text-sm font-color-tertiary">Parent:</div>
                                <div className="text-sm">{parentItem.getField('title') as string}</div>
                            </div>
                        )}
                    </div>
                );
            } catch (error) {
                return <div className="font-color-secondary">Unable to load attachment details</div>;
            }
        } else if (item.isNote()) {
            // Show note preview
            try {
                const noteContent = item.getNote();
                const plainText = noteContent.replace(/<[^>]*>/g, '').substring(0, 200);
                
                return (
                    <div className="space-y-2">
                        <div className="display-flex items-start gap-2">
                            <span className="mt-1">
                                <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="font-weight-medium">Note</div>
                                <div className="text-sm font-color-secondary mt-1">{plainText}...</div>
                            </div>
                        </div>
                    </div>
                );
            } catch (error) {
                return <div className="font-color-secondary">Unable to load note</div>;
            }
        }
        
        return <div className="font-color-secondary">Unknown item type</div>;
    };

    return (
        <>
            {/* Content Area */}
            <div 
                className="source-content p-3"
                style={{ maxHeight: `${maxContentHeight}px` }}
            >
                {renderContent()}
            </div>

            {/* Action buttons */}
            <div className="p-2 pt-1 display-flex flex-row items-center border-top-quinary">
                <div className="gap-3 display-flex">
                    <Button
                        variant="ghost"
                        onClick={handleOpen}
                        disabled={!canOpen}
                    >
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.OPEN} 
                            size={12}
                        />
                        Open
                    </Button>
                    {canRemove && (
                        <Button 
                            variant="ghost"
                            onClick={handleRemove}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.TRASH} 
                                size={12}
                            />
                            Remove
                        </Button>
                    )}
                </div>
                <div className="flex-1"/>
                <div className="display-flex">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost"
                        onClick={() => setActivePreview(null)}
                    />
                </div>
            </div>
        </>
    );
};

export default ItemPreviewContent; 