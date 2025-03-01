import React from 'react';
import { CancelIcon, ClockIcon, PlusSignIcon } from './icons';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { threadMessagesAtom, currentUserMessageAtom } from '../atoms/messages';
import { resetCurrentResourcesAtom, threadResourcesAtom, updateResourcesFromZoteroSelectionAtom } from '../atoms/resources';
import { useAtom, useSetAtom } from 'jotai';
import IconButton from './IconButton';
import Tooltip from './Tooltip';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    const [threadMessages, setThreadMessages] = useAtom(threadMessagesAtom);
    const setThreadResources = useSetAtom(threadResourcesAtom);
    const setCurrentUserMessage = useSetAtom(currentUserMessageAtom);
    const resetCurrentResources = useSetAtom(resetCurrentResourcesAtom);
    const updateResourcesFromZoteroSelection = useSetAtom(updateResourcesFromZoteroSelectionAtom);
    
    const handleNewThread = async () => {
        setThreadMessages([]);
        setThreadResources([]);
        setCurrentUserMessage('');
        resetCurrentResources();
        await updateResourcesFromZoteroSelection();
    }

    return (
        <div id="beaver-header" className="flex flex-row p-3 pb-2">
            <div className="flex-1">
                <Tooltip content="Close chat" showArrow singleLine>
                    <IconButton
                        icon={CancelIcon}
                        onClick={() => triggerToggleChat(Zotero.getMainWindow())}
                        className="scale-14"
                        ariaLabel="Close chat"
                    />
                </Tooltip>
            </div>
            <div className="flex gap-4">
                {/* <button className="icon-button scale-14">
                    <Icon icon={Settings02Icon} />
                </button> */}
                <Tooltip content="Chat history" showArrow singleLine>
                    <IconButton
                        icon={ClockIcon}
                        className="scale-14"
                        onClick={() => console.log('History')}
                        ariaLabel="Show chat history"
                    />
                </Tooltip>
                <Tooltip content="New Chat" secondaryContent="⌘N" showArrow singleLine>
                    <IconButton
                        icon={PlusSignIcon}
                        onClick={handleNewThread}
                        className="scale-14"
                        ariaLabel="New thread"
                        disabled={threadMessages.length === 0}
                    />
                </Tooltip>
            </div>
        </div>
    );
};

export default Header;