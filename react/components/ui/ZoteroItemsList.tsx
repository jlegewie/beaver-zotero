import React, { useState, useEffect } from 'react';
import { truncateText } from '../../utils/stringUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { ItemMetadataAttachment, SourceAttachment } from '../../types/attachments/apiTypes';
import { ZoteroItemReference } from '../../types/zotero';
import { selectItemById } from '../../../src/utils/selectItem';

export interface ZoteroItemReferenceWithLabel extends ZoteroItemReference {
    label: string;
    faded?: boolean;
}

const NOTE_TITLE_MAX_LENGTH = 100;
const NOTE_PREVIEW_MAX_LENGTH = 200;

function getNoteContentPreview(item: Zotero.Item, maxLength: number): string {
    try {
        // @ts-ignore unescapeHTML exists on Zotero.Utilities
        let plainText: string = Zotero.Utilities.unescapeHTML(item.getNote());
        const noteTitle = item.getNoteTitle();
        if (noteTitle && plainText.startsWith(noteTitle)) {
            plainText = plainText.substring(noteTitle.length);
        }
        plainText = plainText.replace(/^\s+/, '').replace(/\s+/g, ' ');
        return truncateText(plainText, maxLength);
    } catch {
        return '';
    }
}

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
    displayName: string;
    subtitle: string;
    muted?: boolean;
    label?: string;
    faded?: boolean;
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
    showParentItem?: boolean;
}

const ZoteroItemsList: React.FC<ZoteroItemsListProps> = ({
    messageAttachments,
    showParentItem = true,
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
                    if (item) {
                        const displayItem = showParentItem ? (item.parentItem || item) : item;
                        const isNote = displayItem.isNote();
                        const displayName = isNote
                            ? truncateText(displayItem.getNoteTitle(), NOTE_TITLE_MAX_LENGTH)
                            : getDisplayNameFromItem(displayItem);
                        const subtitle = isNote
                            ? getNoteContentPreview(displayItem, NOTE_PREVIEW_MAX_LENGTH)
                            : displayItem.getDisplayTitle();
                        items.push({
                            item: displayItem,
                            selectionItemId: item.id,
                            displayName,
                            subtitle,
                            label: 'label' in attachment ? attachment.label : undefined,
                            faded: 'faded' in attachment ? attachment.faded : false
                        });
                    }
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
                const {item, selectionItemId, displayName, subtitle, label, faded} = itemWithSelectionId;
                const isHovered = hoveredItemId === selectionItemId;
                const hasSubtitle = subtitle.length > 0;
                
                return (
                    <div
                        key={selectionItemId}
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''} ${faded ? 'opacity-50' : ''}`}
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
                                    {displayName}
                                </div>
                                {hasSubtitle && (
                                    <div className="truncate text-sm">
                                        {subtitle}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className={`display-flex flex-col flex-1 gap-1 min-w-0 ${fontColor}`}>
                                <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                    <div className={`truncate text-sm ${fontColor}`}>
                                        {displayName}
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
                                {hasSubtitle && (
                                    <div className={`truncate text-sm ${muted ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                                        {subtitle}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroItemsList;