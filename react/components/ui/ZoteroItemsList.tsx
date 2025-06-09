import React, { useState, useEffect } from 'react';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { SourceAttachment } from '../../types/attachments/apiTypes';
import { ZoteroItemReference } from '../../types/zotero';
import { selectItemById } from '../../../src/utils/selectItem';

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
}

interface ZoteroItemsListProps {
    messageAttachments: SourceAttachment[] | ZoteroItemReference[];
}

const ZoteroItemsList: React.FC<ZoteroItemsListProps> = ({
    messageAttachments
}) => {
    const [resolvedItems, setResolvedItems] = useState<ItemWithSelectionId[]>([]);
    const [hoveredItemId, setHoveredItemId] = useState<number | null>(null);

    // Fetch Zotero items when results are visible
    useEffect(() => {
        const fetchItems = async () => {
            if (messageAttachments) {
                const items: ItemWithSelectionId[] = [];
                for (const attachment of messageAttachments) {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.library_id, 
                        attachment.zotero_key
                    );
                    if (item) items.push({ item: item.parentItem || item, selectionItemId: item.id });
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [messageAttachments]);

    
    const handleItemClick = (selectionItemId: number) => {
        selectItemById(selectionItemId);
    };

    return (
        <div className="min-w-0">
            {resolvedItems.map((itemWithSelectionId: ItemWithSelectionId) => {
                const {item, selectionItemId} = itemWithSelectionId;
                const isHovered = hoveredItemId === selectionItemId;
                
                return (
                    <div
                        key={selectionItemId} 
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
                        onClick={() => handleItemClick(selectionItemId)}
                        onMouseEnter={() => setHoveredItemId(selectionItemId)}
                        onMouseLeave={() => setHoveredItemId(null)}
                        title="Click to reveal in Zotero"
                    >
                        <span className="scale-75" style={{ marginTop: '-2px' }}>
                            <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                        </span>
                        <div className="display-flex flex-col gap-1 min-w-0 font-color-primary">
                            <span className="truncate text-sm font-color-primary">
                                {getDisplayNameFromItem(item)}
                            </span>
                            <span className="truncate text-sm font-color-secondary min-w-0">
                                {item.getDisplayTitle()}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroItemsList;