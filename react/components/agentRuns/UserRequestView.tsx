import React, { useMemo, useRef } from 'react';
import { BeaverAgentPrompt } from '../../../src/services/chatServiceWS';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { MessageItemButton } from '../input/MessageItemButton';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';

interface UserRequestViewProps {
    message: BeaverAgentPrompt;
}

/**
 * Renders the user's request in an agent run.
 * Displays attachments, filters, and the message content.
 */
export const UserRequestView: React.FC<UserRequestViewProps> = ({ message }) => {
    const contentRef = useRef<HTMLDivElement | null>(null);

    const {
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    // Get Zotero items for attachments
    const attachmentItems = useMemo(() => {
        if (!message.attachments) return [];
        return message.attachments
            .map((att) => {
                const item = Zotero.Items.getByLibraryAndKey(att.library_id, att.zotero_key);
                return item ? { attachment: att, item } : null;
            })
            .filter((a): a is { attachment: typeof message.attachments[0]; item: Zotero.Item } => a !== null);
    }, [message.attachments]);

    // Check if we have content to display in the filters/attachments section
    const hasFiltersOrAttachments = 
        attachmentItems.length > 0 ||
        (message.filters?.libraries && message.filters.libraries.length > 0) ||
        (message.filters?.collections && message.filters.collections.length > 0) ||
        (message.filters?.tags && message.filters.tags.length > 0);

    return (
        <div className="px-3 py-1">
            <div className="user-message-display">

                {/* Message attachments and filters */}
                {hasFiltersOrAttachments && (
                    <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                        {/* Library filters */}
                        {message.filters?.libraries && (
                            message.filters.libraries
                                .map((library) => Zotero.Libraries.get(library.library_id))
                                .filter((library): library is Zotero.Library => Boolean(library))
                                .map((library) => (
                                    <LibraryButton key={library.libraryID} library={library} canEdit={false} />
                                ))
                        )}

                        {/* Collection filters */}
                        {message.filters?.collections && (
                            message.filters.collections
                                .map((collection) => Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key))
                                .filter((collection): collection is Zotero.Collection => Boolean(collection))
                                .map((collection) => (
                                    <CollectionButton key={collection.id} collection={collection} canEdit={false} />
                                ))
                        )}

                        {/* Tag filters */}
                        {message.filters?.tags?.map((tag) => (
                            <TagButton key={tag.id} tag={tag} canEdit={false} />
                        ))}

                        {/* Attachments */}
                        {attachmentItems.map(({ item }, index) => (
                            <MessageItemButton
                                key={index}
                                item={item}
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

export default UserRequestView;

