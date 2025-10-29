import React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { readerTextSelectionAtom, currentLibraryIdsAtom } from '../../atoms/input';
import { currentReaderAttachmentAtom } from '../../atoms/messageComposition';
import { TextSelectionButton } from '../input/TextSelectionButton';
// import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import AddSourcesMenu from '../ui/menus/AddSourcesMenu';
import { LibraryButton } from '../library/LibraryButton';
import { MessageItemButton } from '../input/MessageItemButton';
import { currentMessageItemsAtom } from '../../atoms/messageComposition';

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
    const [currentMessageItems, setCurrentMessageItems] = useAtom<Zotero.Item[]>(currentMessageItemsAtom);

    const selectedLibraries = currentLibraryIds
        .map(id => Zotero.Libraries.get(id))
        .filter(lib => lib) as Zotero.Library[];

    return (
        <div className="display-flex flex-wrap gap-3 mb-2">
            <AddSourcesMenu
                // showText={currentMessageItems.length == 0 && threadSourceCount == 0 && !currentReaderAttachment}
                showText={currentMessageItems.length == 0 && !currentReaderAttachment && selectedLibraries.length == 0}
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

            {/* Current reader attachment */}
            {currentReaderAttachment && (
                <MessageItemButton item={currentReaderAttachment} canEdit={false} isReaderAttachment={true} />
            )}

            {/* Current message items */}
            {currentMessageItems
                .filter((item) => !currentReaderAttachment || item.key !== currentReaderAttachment.key)
                .map((item, index) => (
                    <MessageItemButton
                        key={index} item={item}
                        onRemove={(item) => {
                            setCurrentMessageItems(currentMessageItems.filter((i) => i.key !== item.key));
                        }}
                    />
                ))
            }

            {/* Current text selection */}
            {readerTextSelection && (
                <TextSelectionButton selection={readerTextSelection} />
            )}
            
        </div>
    )
}

export default MessageAttachmentDisplay;