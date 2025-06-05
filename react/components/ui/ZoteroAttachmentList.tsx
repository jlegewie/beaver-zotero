import React, { useState, useEffect } from 'react';
import { CSSItemTypeIcon } from '../icons/icons';
import { FailedFileReference, FailedItemReference } from '../../types/zotero';
import { errorMapping } from '../../atoms/files';
import { selectItemById } from '../../../src/utils/selectItem';

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
    errorCode?: string;
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
                    if (item) items.push({ item, selectionItemId: item.id, errorCode: attachment.errorCode });
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [attachments]);

    
    const handleItemClick = (selectionItemId: number) => {
        selectItemById(selectionItemId);
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
                const {item, selectionItemId, errorCode} = itemWithSelectionId;
                const itemId = `${item.libraryID}-${item.key}`;
                const isHovered = hoveredItemId === itemId;
                const errorMessage = errorCode ? errorMapping[errorCode as keyof typeof errorMapping] || "Unknown error" : null;
                
                return (
                    <div
                        key={itemId} 
                        className={`display-flex flex-row flex-1 rounded-md gap-2 items-center min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
                        onClick={() => handleItemClick(selectionItemId)}
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
                        {errorMessage && (
                            <div className="text-sm font-color-tertiary fit-content min-w-0 truncate">
                                {errorMessage}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroAttachmentList;