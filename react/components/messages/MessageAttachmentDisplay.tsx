import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai';
import { currentReaderAttachmentAtom, readerTextSelectionAtom, currentMessageFiltersAtom, removeItemFromMessageAtom, currentMessageItemsAtom, currentMessageCollectionsAtom, currentMessageExternalFilesAtom, removeExternalFileFromMessageAtom, clearMessageContextAtom } from '../../atoms/messageComposition';
import { currentNoteItemAtom } from '../../atoms/zoteroContext';
import { removePopupMessagesByTypeAtom } from '../../atoms/ui';
import { TextSelectionButton } from '../input/TextSelectionButton';
// import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import AddSourcesMenu from '../ui/menus/AddSourcesMenu';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';
import { MessageItemButton } from '../input/MessageItemButton';
import { MessageCollectionButton } from '../input/MessageCollectionButton';
import { ExternalFileButton } from '../input/ExternalFileButton';
import { collectionReferenceKey } from '../../types/zotero';
import { ChipWithPopup } from '../agentRuns/requestChips/ChipPopup';
import { buildItemsSummaryChipPopup } from '../input/MessageItemChipPopup';
import { getItemValidationAtom } from '../../atoms/itemValidation';

const MAX_ATTACHMENTS = 4;

const MessageAttachmentDisplay = ({
    isAddAttachmentMenuOpen,
    setIsAddAttachmentMenuOpen,
    menuPosition,
    setMenuPosition,
    inputRef,
    disabled = false,
    verticalPosition = 'above',
}: {
    isAddAttachmentMenuOpen: boolean;
    setIsAddAttachmentMenuOpen: (isAddAttachmentMenuOpen: boolean) => void;
    menuPosition: { x: number; y: number };
    setMenuPosition: (menuPosition: { x: number; y: number }) => void;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    disabled?: boolean;
    verticalPosition?: 'above' | 'below';
}) => {
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const currentNoteItem = useAtomValue(currentNoteItemAtom);
    const readerTextSelection = useAtomValue(readerTextSelectionAtom);
    const currentMessageFilters = useAtomValue(currentMessageFiltersAtom);
    const { libraryIds: currentLibraryIds, collectionIds: currentCollectionIds, tagSelections: currentTagSelections } = currentMessageFilters;
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const currentMessageCollections = useAtomValue(currentMessageCollectionsAtom);
    const currentMessageExternalFiles = useAtomValue(currentMessageExternalFilesAtom);
    const removeExternalFileFromMessage = useSetAtom(removeExternalFileFromMessageAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);
    const clearMessageContext = useSetAtom(clearMessageContextAtom);
    const removePopupMessagesByType = useSetAtom(removePopupMessagesByTypeAtom);
    const getValidation = useAtomValue(getItemValidationAtom);

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

    const filteredMessageItems = React.useMemo(
        () => currentMessageItems.filter(
            (item) => (!currentReaderAttachment || item.key !== currentReaderAttachment.key)
                && (!currentNoteItem || item.key !== currentNoteItem.key),
        ),
        [currentMessageItems, currentNoteItem, currentReaderAttachment],
    );
    const displayedMessageItems = React.useMemo(
        () => filteredMessageItems.slice(0, MAX_ATTACHMENTS),
        [filteredMessageItems],
    );
    const overflowMessageItems = React.useMemo(
        () => filteredMessageItems.slice(MAX_ATTACHMENTS),
        [filteredMessageItems],
    );
    const overflowCount = overflowMessageItems.length;
    const overflowPopup = React.useMemo(
        () => overflowCount > 0
            ? buildItemsSummaryChipPopup(overflowMessageItems, getValidation)
            : null,
        [getValidation, overflowCount, overflowMessageItems],
    );

    // Count of editable (removable) context items currently attached. Excludes
    // the non-removable reader attachment and note tab item.
    const removableContextCount =
        filteredMessageItems.length +
        selectedLibraries.length +
        selectedCollections.length +
        currentTagSelections.length +
        currentMessageCollections.length +
        currentMessageExternalFiles.length +
        (readerTextSelection ? 1 : 0);

    // Offer "Remove all" only when there is more than one removable item
    const handleRemoveAll = removableContextCount > 1
        ? () => {
            clearMessageContext();
            removePopupMessagesByType(['items_summary']);
        }
        : undefined;

    return (
        <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
            <AddSourcesMenu
                showText={
                    currentMessageItems.length == 0 &&
                    !currentReaderAttachment &&
                    !currentNoteItem &&
                    selectedLibraries.length == 0 &&
                    selectedCollections.length == 0 &&
                    currentTagSelections.length == 0 &&
                    currentMessageExternalFiles.length == 0
                }
                onClose={() => {
                    inputRef.current?.focus();
                    setIsAddAttachmentMenuOpen(false);
                }}
                isMenuOpen={isAddAttachmentMenuOpen}
                onOpen={() => setIsAddAttachmentMenuOpen(true)}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
                disabled={disabled}
                verticalPosition={verticalPosition}
            />

            {/* Selected Libraries */}
            {selectedLibraries.map(library => (
                <LibraryButton key={library.libraryID} library={library} onRemoveAll={handleRemoveAll} />
            ))}

            {/* Selected Collections */}
            {selectedCollections.map(collection => (
                <CollectionButton key={collection.id} collection={collection} onRemoveAll={handleRemoveAll} />
            ))}

            {/* Selected Tags */}
            {currentTagSelections.map(tag => (
                <TagButton key={tag.id} tag={tag} onRemoveAll={handleRemoveAll} />
            ))}

            {/* Current message collections */}
            {currentMessageCollections.map(col => (
                <MessageCollectionButton key={collectionReferenceKey(col)} collection={col} onRemoveAll={handleRemoveAll} />
            ))}

            {/* Current reader attachment */}
            {currentReaderAttachment && (
                <MessageItemButton item={currentReaderAttachment} canEdit={false} tabContextType="reader" />
            )}

            {/* Current note tab item */}
            {currentNoteItem && (
                <MessageItemButton item={currentNoteItem} canEdit={false} tabContextType="note" />
            )}

            {/* Current message items */}
            {displayedMessageItems.map((item) => (
                <MessageItemButton
                    key={item.key}
                    item={item}
                    onRemove={(item) => {
                        removeItemFromMessage(item);
                    }}
                    onRemoveAll={handleRemoveAll}
                />
            ))}

            {overflowPopup && (
                <ChipWithPopup popup={overflowPopup}>
                    <button
                        type="button"
                        className="variant-outline source-button"
                        style={{ height: '22px' }}
                        title={`${overflowCount} more attachment${overflowCount === 1 ? '' : 's'}`}
                    >
                        +{overflowCount}
                    </button>
                </ChipWithPopup>
            )}

            {/* External files */}
            {currentMessageExternalFiles.map((file) => (
                <ExternalFileButton
                    key={file.extKey}
                    extKey={file.extKey}
                    filename={file.filename}
                    contentKind={file.contentKind}
                    storedPath={file.storedPath}
                    onRemove={removeExternalFileFromMessage}
                    onRemoveAll={handleRemoveAll}
                />
            ))}

            {/* Current text selection */}
            {readerTextSelection && (
                <TextSelectionButton selection={readerTextSelection} onRemoveAll={handleRemoveAll} />
            )}
            
        </div>
    )
}

export default MessageAttachmentDisplay;
