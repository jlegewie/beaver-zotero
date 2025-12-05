import React, { useMemo } from 'react';
import { useRef } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { useAtomValue } from 'jotai';
import { userAttachmentsAtom } from '../../atoms/threads';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { MessageAttachmentWithId, MessageAttachmentWithRequiredItem } from '../../types/attachments/uiTypes';
import { MessageItemButton } from '../input/MessageItemButton';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const userAttachments = useAtomValue(userAttachmentsAtom);
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);

    // Enrich message attachments with item data
    const messageAttachments: MessageAttachmentWithId[] = useMemo(() => {
        return userAttachments
            .filter((a: MessageAttachmentWithId) => a.messageId === message.id)
            .map((a: MessageAttachmentWithId) => {
                const item = Zotero.Items.getByLibraryAndKey(a.library_id, a.zotero_key);
                return {...a, item: item || undefined};
            });
    }, [userAttachments, message.id]);

    const {
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    return (
        <div id={`message-${message.id}`} className="px-3 py-1">
            <div className="user-message-display">

                {/* Message attachments and filters */}
                {(
                    messageAttachments.filter((a): a is MessageAttachmentWithRequiredItem => Boolean(a.item)).length > 0 ||
                    (message.filters && message.filters.libraries) ||
                    (message.filters && message.filters.collections) ||
                    (message.filters && message.filters.tags)
                ) && (
                    <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                        {/* Message filters */}
                        {message.filters && message.filters.libraries && (
                            message.filters.libraries
                                .map((library) => Zotero.Libraries.get(library.library_id))
                                .filter((library): library is Zotero.Library => Boolean(library))
                                .map((library) => (
                                    <LibraryButton key={library.libraryID} library={library} canEdit={false} />
                                ))
                        )}

                        {/* Message collections */}
                        {message.filters && message.filters.collections && (
                            message.filters.collections
                                .map((collection) => Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key))
                                .filter((collection): collection is Zotero.Collection => Boolean(collection))
                                .map((collection) => (
                                    <CollectionButton key={collection.id} collection={collection} canEdit={false} />
                                ))
                        )}

                        {/* Message tags */}
                        {message.filters && message.filters.tags && (
                            message.filters.tags
                                .map((tag) => (
                                    <TagButton key={tag.id} tag={tag} canEdit={false} />
                                ))
                        )}

                        {/* Message attachments */}
                        {messageAttachments
                            .filter((a): a is MessageAttachmentWithRequiredItem => Boolean(a.item))
                            .map((attachment, index) => (
                                <MessageItemButton
                                    key={index}
                                    item={attachment.item}
                                    canEdit={false}
                                />
                            ))}
                    </div>
                )}
                

                {/* Message content */}
                <div className="-ml-1 user-select-text" ref={contentRef} onContextMenu={handleContextMenu}>
                    {message.content}
                </div>

                {/* Text selection context menu */}
                <ContextMenu
                    menuItems={selectionMenuItems}
                    isOpen={isSelectionMenuOpen}
                    onClose={closeSelectionMenu}
                    position={selectionMenuPosition}
                    useFixedPosition={true}
                />
            </div>
        </div>
    );
};

export default UserMessageDisplay;