import React from 'react';
import { useAtomValue } from 'jotai';
import { SourceButton } from "./SourceButton";
import { ChatMessage } from '../types/messages';
import { isStreamingAtom, threadSourcesAtom } from '../atoms/threads';
// @ts-ignore no idea why
import { useRef } from 'react';
import ContextMenu from './ContextMenu';
import useSelectionContextMenu from '../hooks/useSelectionContextMenu';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const threadSources = useAtomValue(threadSourcesAtom);
    const messageSources = threadSources.filter(r => r.messageId === message.id);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    return (
        <div className="user-message-display">
            
            {/* Message sources */}
            {messageSources.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-2">
                    {messageSources.map((source, index) => (
                        <SourceButton
                            key={index}
                            source={source}
                            disabled={true}
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
    );
};

export default UserMessageDisplay;