import React, { createElement } from 'react';
import { CSSItemTypeIcon, CSSIcon, AlertIcon, Icon } from '../icons/icons';
import { useSetAtom, useAtomValue } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { removeItemFromMessageAtom } from '../../atoms/messageComposition';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { openPDFInNewWindow } from '../../utils/openPDFInNewWindow';
import { RegularItemMessageContent } from '../ui/popup/RegularItemMessageContent';
import PopupMessageHeader from '../ui/popup/PopupMessageHeader';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { useMessageItemSummary } from '../../hooks/useMessageItemSummary';
import { truncateText } from '../../utils/stringUtils';

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
    const summary = useMessageItemSummary(item);

    if (!item) {
        // If item becomes invalid while preview is open, close preview
        setActivePreview(null); 
        return null;
    }

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
            return (
                <div className="p-3 display-flex flex-col items-start gap-2">
                    <PopupMessageHeader
                        icon={createElement(CSSItemTypeIcon, { itemType: item.getItemTypeIconName() })}
                        title={getDisplayNameFromItem(item)}
                        handleDismiss={() => setActivePreview(null)}
                    />
                    <RegularItemMessageContent item={item} summary={summary} />
                </div>
            );
        } else if (item.isAttachment()) {
            // Show attachment info
            const validation = getValidation(item);
            const isInvalid = validation && !validation.isValid && !validation.isValidating;
            
            return (
                <div className="p-3 display-flex flex-col items-start gap-2">
                    <PopupMessageHeader
                        icon={!isInvalid
                            ? createElement(CSSItemTypeIcon, { itemType: item.getItemTypeIconName() })
                            : <Icon icon={AlertIcon} className="font-color-error scale-11 mt-020" />
                        }
                        title={isInvalid
                            ? `Invalid File "${item.getDisplayTitle()}"`
                            : getDisplayNameFromItem(item.parentItem ?? item)
                        }
                        // title={item.getDisplayTitle()}
                        handleDismiss={() => setActivePreview(null)}
                        fontColor={isInvalid ? 'font-color-error' : 'font-color-secondary'}
                    />
                    <div className="display-flex flex-col gap-3 -ml-1">
                        <div className="display-flex flex-row items-center gap-2 ml-15">
                            <div className={`text-md ${isInvalid ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                                {!isInvalid ? truncateText(item.getDisplayTitle(), 100) : validation?.reason}
                            </div>
                        </div>
                    </div>
                </div>
            );
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
            {renderContent()}
            {/* buttons */}
            {/* <div className="p-2 pt-1 display-flex flex-row items-center border-top-quinary">
                <div className="flex-1 gap-3 display-flex">
                    <Button
                        variant="ghost"
                        onClick={handleOpen}
                        // disabled={!annotation.parent_key} // Disable if parent info is missing
                    >
                        <ZoteroIcon
                            icon={ZOTERO_ICONS.OPEN}
                            size={12}
                        />
                        Open
                    </Button>
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
                </div>
                <div className="display-flex">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost"
                        onClick={() => setActivePreview(null)}
                    />
                </div>
            </div> */}
        </>
    );
};

export default ItemPreviewContent; 
