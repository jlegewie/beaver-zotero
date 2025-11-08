import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai';
import { currentReaderAttachmentAtom, readerTextSelectionAtom, currentLibraryIdsAtom, removeItemFromMessageAtom, currentCollectionIdsAtom } from '../../atoms/messageComposition';
import { TextSelectionButton } from '../input/TextSelectionButton';
// import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import AddSourcesMenu from '../ui/menus/AddSourcesMenu';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { MessageItemButton } from '../input/MessageItemButton';
import { currentMessageItemsAtom } from '../../atoms/messageComposition';
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
    const currentLibraryIds = useAtomValue(currentLibraryIdsAtom);
    const currentCollectionIds = useAtomValue(currentCollectionIdsAtom);
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
        <div className="display-flex flex-wrap gap-3 mb-2">
            <AddSourcesMenu
                // showText={currentMessageItems.length == 0 && threadSourceCount == 0 && !currentReaderAttachment}
                showText={currentMessageItems.length == 0 && !currentReaderAttachment && selectedLibraries.length == 0 && selectedCollections.length == 0}
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
