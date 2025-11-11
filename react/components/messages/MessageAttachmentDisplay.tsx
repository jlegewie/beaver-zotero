import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai';
import { currentReaderAttachmentAtom, readerTextSelectionAtom, currentMessageFiltersAtom, removeItemFromMessageAtom, currentMessageItemsAtom } from '../../atoms/messageComposition';
import { TextSelectionButton } from '../input/TextSelectionButton';
// import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import AddSourcesMenu from '../ui/menus/AddSourcesMenu';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';
import { MessageItemButton } from '../input/MessageItemButton';
import { usePreviewHover } from '../../hooks/usePreviewHover';
import { activePreviewAtom } from '../../atoms/ui';

const MAX_ATTACHMENTS = 4;

const MessageAttachmentDisplay = ({
    isAddAttachmentMenuOpen,
    setIsAddAttachmentMenuOpen,
    menuPosition,
    setMenuPosition,
    inputRef
}: {
    isAddAttachmentMenuOpen: boolean;
    setIsAddAttachmentMenuOpen: (isAddAttachmentMenuOpen: boolean) => void;
    menuPosition: { x: number; y: number };
    setMenuPosition: (menuPosition: { x: number; y: number }) => void;
    inputRef: React.RefObject<HTMLTextAreaElement>;
}) => {
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const readerTextSelection = useAtomValue(readerTextSelectionAtom);
    const currentMessageFilters = useAtomValue(currentMessageFiltersAtom);
    const { libraryIds: currentLibraryIds, collectionIds: currentCollectionIds, tagSelections: currentTagSelections } = currentMessageFilters;
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);
    const setActivePreview = useSetAtom(activePreviewAtom);

    const selectedLibraries = currentLibraryIds
        .map(id => Zotero.Libraries.get(id))
        .filter(lib => lib) as Zotero.Library[];

    const selectedCollections = currentCollectionIds
        .map(id => {
            try {
                return Zotero.Collections.get(id);
            } catch {
                return null;
            }
        })
        .filter((collection): collection is Zotero.Collection => Boolean(collection));

    const filteredMessageItems = currentMessageItems.filter(
        (item) => !currentReaderAttachment || item.key !== currentReaderAttachment.key
    );
    const displayedMessageItems = filteredMessageItems.slice(0, MAX_ATTACHMENTS);
    const overflowMessageItems = filteredMessageItems.slice(MAX_ATTACHMENTS);
    const overflowCount = overflowMessageItems.length;

    const { hoverEventHandlers: overflowHoverHandlers } = usePreviewHover(
        overflowCount > 0 ? { type: 'itemsSummary', content: overflowMessageItems } : null,
        { isEnabled: overflowCount > 0 }
    );

    return (
        <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
            <AddSourcesMenu
                // showText={currentMessageItems.length == 0 && threadSourceCount == 0 && !currentReaderAttachment}
                showText={currentMessageItems.length == 0 && !currentReaderAttachment && selectedLibraries.length == 0 && selectedCollections.length == 0 && currentTagSelections.length == 0}
                onClose={() => {
                    inputRef.current?.focus();
                    setIsAddAttachmentMenuOpen(false);
                }}
                isMenuOpen={isAddAttachmentMenuOpen}
                onOpen={() => setIsAddAttachmentMenuOpen(true)}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
            />

            {/* Selected Libraries */}
            {selectedLibraries.map(library => (
                <LibraryButton key={library.libraryID} library={library} />
            ))}

            {/* Selected Collections */}
            {selectedCollections.map(collection => (
                <CollectionButton key={collection.id} collection={collection} />
            ))}

            {/* Selected Tags */}
            {currentTagSelections.map(tag => (
                <TagButton key={tag.id} tag={tag} />
            ))}

            {/* Current reader attachment */}
            {currentReaderAttachment && (
                <MessageItemButton item={currentReaderAttachment} canEdit={false} isReaderAttachment={true} />
            )}

            {/* Current message items */}
            {displayedMessageItems.map((item) => (
                <MessageItemButton
                    key={item.key}
                    item={item}
                    onRemove={(item) => {
                        removeItemFromMessage(item);
                        setActivePreview((prev) => {
                            if (prev && prev.type === 'item' && prev.content.key === item.key) {
                                return null;
                            }
                            return prev;
                        });
                    }}
                />
            ))}

            {overflowCount > 0 && (
                <button
                    type="button"
                    className="variant-outline source-button"
                    style={{ height: '22px' }}
                    title={`${overflowCount} more attachment${overflowCount === 1 ? '' : 's'}`}
                    {...overflowHoverHandlers}
                >
                    +{overflowCount}
                </button>
            )}

            {/* Current text selection */}
            {readerTextSelection && (
                <TextSelectionButton selection={readerTextSelection} />
            )}
            
        </div>
    )
}

export default MessageAttachmentDisplay;
