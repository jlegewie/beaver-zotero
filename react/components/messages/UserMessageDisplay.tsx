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
                {/* Message sources */}
                {messageAttachments.length > 0 && (
                    <div className="display-flex flex-wrap gap-3 mb-2">
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