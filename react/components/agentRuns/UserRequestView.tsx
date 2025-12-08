import React, { useMemo, useRef } from 'react';
import { BeaverAgentPrompt } from '../../agents/types';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { MessageItemButton } from '../input/MessageItemButton';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';

interface UserRequestViewProps {
    userPrompt: BeaverAgentPrompt;
}

/**
 * Renders the user's request in an agent run.
 * Displays attachments, filters, and the userPrompt content.
 */
export const UserRequestView: React.FC<UserRequestViewProps> = ({ userPrompt }) => {
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
        if (!userPrompt.attachments) return [];
        return userPrompt.attachments
            .map((att) => {
                const item = Zotero.Items.getByLibraryAndKey(att.library_id, att.zotero_key);
                return item ? { attachment: att, item } : null;
            })
            .filter((a): a is { attachment: typeof userPrompt.attachments[0]; item: Zotero.Item } => a !== null);
    }, [userPrompt.attachments]);

    // Check if we have content to display in the filters/attachments section
    const hasFiltersOrAttachments = 
        attachmentItems.length > 0 ||
        (userPrompt.filters?.libraries && userPrompt.filters.libraries.length > 0) ||
        (userPrompt.filters?.collections && userPrompt.filters.collections.length > 0) ||
        (userPrompt.filters?.tags && userPrompt.filters.tags.length > 0);

    return (
        <div className="px-3 py-1">
            <div className="user-message-display">

                {/* Message attachments and filters */}
                {hasFiltersOrAttachments && (
                    <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                        {/* Library filters */}
                        {userPrompt.filters?.libraries && (
                            userPrompt.filters.libraries
                                .map((library) => Zotero.Libraries.get(library.library_id))
                                .filter((library): library is Zotero.Library => Boolean(library))
                                .map((library) => (
                                    <LibraryButton key={library.libraryID} library={library} canEdit={false} />
                                ))
                        )}

                        {/* Collection filters */}
                        {userPrompt.filters?.collections && (
                            userPrompt.filters.collections
                                .map((collection) => Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key))
                                .filter((collection): collection is Zotero.Collection => Boolean(collection))
                                .map((collection) => (
                                    <CollectionButton key={collection.id} collection={collection} canEdit={false} />
                                ))
                        )}

                        {/* Tag filters */}
                        {userPrompt.filters?.tags?.map((tag) => (
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
                    {userPrompt.content}
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

