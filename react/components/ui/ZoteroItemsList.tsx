import React, { useState, useEffect } from 'react';
import { truncateText } from '../../utils/stringUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { ItemMetadataAttachment, SourceAttachment } from '../../types/attachments/apiTypes';
import { ZoteroItemReference } from '../../types/zotero';
import { selectItemById } from '../../../src/utils/selectItem';

export interface ZoteroItemReferenceWithLabel extends ZoteroItemReference {
    label: string;
}

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
    muted?: boolean;
    label?: string;
}

interface ZoteroItemsListProps {
    messageAttachments: (
        SourceAttachment |
        ItemMetadataAttachment |
        ZoteroItemReference |
        ZoteroItemReferenceWithLabel
    )[];
    oneLine?: boolean;
    muted?: boolean;
}

const ZoteroItemsList: React.FC<ZoteroItemsListProps> = ({
    messageAttachments,
    oneLine = false,
    muted = false
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
                    if (item) items.push({
                        item: item.parentItem || item,
                        selectionItemId: item.id,
                        label: 'label' in attachment ? attachment.label : undefined
                    });
                }
                setResolvedItems(items);
            }
        };
        
        fetchItems();
    }, [messageAttachments]);

    
    const handleItemClick = (selectionItemId: number) => {
        selectItemById(selectionItemId);
    };

    const fontColor = muted ? 'font-color-tertiary' : 'font-color-primary';

    return (
        <div className="min-w-0">
            {resolvedItems.map((itemWithSelectionId: ItemWithSelectionId) => {
                const {item, selectionItemId, label} = itemWithSelectionId;
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
                        {oneLine ? (
                            <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                <div className="text-sm whitespace-nowrap">
                                    {getDisplayNameFromItem(item)}
                                </div>
                                <div className="truncate text-sm">
                                    {item.getDisplayTitle()}
                                </div>
                            </div>
                        ) : (
                            <div className={`display-flex flex-col flex-1 gap-1 min-w-0 ${fontColor}`}>
                                <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                    <div className={`truncate text-sm ${fontColor}`}>
                                        {getDisplayNameFromItem(item)}
                                    </div>
                                    {!oneLine && label &&
                                         <>
                                            <div className="flex-1" />
                                            <div className="text-sm display-flex min-w-0 font-color-tertiary mr-1">
                                                {truncateText(label, 15)}
                                            </div>
                                        </>
                                    }
                                </div>
                                <div className={`truncate text-sm ${muted ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                                    {item.getDisplayTitle()}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroItemsList;