import React from 'react';
import { useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { SourceButton } from "../sources/SourceButton";
import { ChatMessage } from '../../types/chat/uiTypes';
import { userAddedSourcesAtom } from '../../atoms/threads';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { InputSource } from '../../types/sources';
import { organizeSourcesByRegularItems } from '../../utils/sourceUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/input';
import { AnnotationButton } from '../AnnotationButton';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const userAddedSources = useAtomValue(userAddedSourcesAtom);
    const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const messageSources: InputSource[] = useMemo(() => {
        const messageSources = userAddedSources.filter(s => s.messageId === message.id);
            // .filter(s => s.messageId === message.id && s.itemKey !== currentReaderAttachmentKey);
        const organizedSources = organizeSourcesByRegularItems(messageSources);
        return organizedSources;
    }, [userAddedSources, currentReaderAttachmentKey]);

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
                {messageSources.length > 0 && (
                    <div className="display-flex flex-wrap gap-3 mb-2">
                        {messageSources.map((source, index) => (
                            source.type === "annotation" ? (
                                <AnnotationButton
                                    key={index}
                                    source={source}
                                    canEdit={false}
                                />
                            ) : (
                                <SourceButton
                                    key={index}
                                    source={source}
                                    canEdit={false}
                                />
                            )
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