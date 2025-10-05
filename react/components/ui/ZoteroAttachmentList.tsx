import React, { useState, useEffect } from 'react';
import { CSSItemTypeIcon } from '../icons/icons';
import { FailedFileReference, FailedItemReference } from '../../types/zotero';
import { errorMapping } from '../../atoms/errors';
import { selectItemById } from '../../../src/utils/selectItem';
import IconButton from './IconButton';

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
    errorCode?: string;
    buttonText?: string;
    buttonAction?: () => void;
    buttonIcon?: React.ComponentType<any>;
}

interface ZoteroAttachmentListProps {
    attachments: FailedFileReference[] | FailedItemReference[];
    maxHeight?: string | number;
}

const ZoteroAttachmentList: React.FC<ZoteroAttachmentListProps> = ({
    attachments,
    maxHeight
}) => {
    const [resolvedItems, setResolvedItems] = useState<ItemWithSelectionId[]>([]);
    const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

    // Fetch Zotero items when results are visible
    useEffect(() => {
        const fetchItems = async () => {
            if (attachments) {
                const items: ItemWithSelectionId[] = [];
                for (const attachment of attachments) {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.library_id,
                        attachment.zotero_key
                    );
                    if (item) {
                        items.push({ 
                            item, 
                            selectionItemId: item.id, 
                            errorCode: attachment.errorCode,
                            buttonText: attachment.buttonText,
                            buttonAction: attachment.buttonAction,
                            buttonIcon: attachment.buttonIcon
                        });
                    }
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [attachments]);

    
    const handleItemClick = (selectionItemId: number, event: React.MouseEvent) => {
        // Prevent item selection when clicking on button
        if ((event.target as HTMLElement).closest('button')) {
            return;
        }
        selectItemById(selectionItemId);
    };

    const handleButtonClick = (action: () => void, event: React.MouseEvent) => {
        event.stopPropagation();
        action();
    };

    // Build container style based on maxHeight prop
    const containerStyle = maxHeight ? { maxHeight } : {};
    const containerClassName = `display-flex flex-col w-full -ml-1 min-w-0 ${maxHeight ? 'overflow-y-auto scrollbar' : ''}`;

    return (
        <div 
            className={containerClassName}
            style={containerStyle}
        >
            {resolvedItems.map((itemWithSelectionId: ItemWithSelectionId) => {
                const {item, selectionItemId, errorCode, buttonText, buttonAction, buttonIcon} = itemWithSelectionId;
                const itemId = `${item.libraryID}-${item.key}`;
                const isHovered = hoveredItemId === itemId;
                const errorMessage = errorCode ? errorMapping[errorCode as keyof typeof errorMapping] || "Unknown error" : null;
                const hasButton = buttonText && buttonAction;
                
                return (
                    <div
                        key={itemId} 
                        className={`display-flex flex-row flex-1 rounded-md gap-2 items-center min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
                        onClick={(e) => handleItemClick(selectionItemId, e)}
                        onMouseEnter={() => setHoveredItemId(itemId)}
                        onMouseLeave={() => setHoveredItemId(null)}
                        title="Click to reveal in Zotero"
                    >
                        <div className="scale-90" style={{ marginTop: '-2px' }}>
                            <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                        </div>
                        <div className="truncate text-sm font-color-secondary flex-1 min-w-0">
                            {item.attachmentFilename}
                        </div>
                        <div className="display-flex flex-row gap-2 fit-content min-w-0 items-center">
                            {errorMessage && (
                                <div className="text-sm font-color-tertiary min-w-0 truncate">
                                    {errorMessage}
                                </div>
                            )}
                            {hasButton && buttonIcon && (
                                <IconButton
                                    variant="ghost-secondary"
                                    title={buttonText}
                                    icon={buttonIcon}
                                    onClick={(e) => handleButtonClick(buttonAction, e)}
                                />
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroAttachmentList;