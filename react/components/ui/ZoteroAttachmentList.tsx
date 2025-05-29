import React, { useState, useEffect } from 'react';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { FileHashReference, ZoteroItemReference } from '../../types/zotero';

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
}

interface ZoteroAttachmentListProps {
    attachments: FileHashReference[] | ZoteroItemReference[];
}

const ZoteroAttachmentList: React.FC<ZoteroAttachmentListProps> = ({
    attachments
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
                    if (item) items.push({ item, selectionItemId: item.id });
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [attachments]);

    
    const handleItemClick = (selectionItemId: number) => {
        // TODO: Go to library view if in reader view
        // @ts-ignore selectItem exists
        Zotero.getActiveZoteroPane().itemsView.selectItem(selectionItemId);
    };

    return (
        <div className="display-flex flex-col w-full -ml-1 min-w-0">
            {resolvedItems.map((itemWithSelectionId: ItemWithSelectionId) => {
                const {item, selectionItemId} = itemWithSelectionId;
                const itemId = `${item.libraryID}-${item.key}`;
                const isHovered = hoveredItemId === itemId;
                
                return (
                    <div
                        key={itemId} 
                        className={`display-flex flex-row rounded-md gap-2 -ml-020 items-center min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
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
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroAttachmentList;