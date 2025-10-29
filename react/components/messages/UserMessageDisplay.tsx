import React from 'react';
import { useRef } from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const contentRef = useRef<HTMLDivElement | null>(null);

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
                {/* {messageSources.length > 0 && (
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
                                    validationType={SourceValidationType.LOCAL_ONLY}
                                />
                            )
                        ))}
                    </div>
                )} */}
                

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