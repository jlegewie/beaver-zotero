import React from 'react';
import { Icon, Cancel01Icon, ClockIcon, PlusSignIcon, Settings02Icon } from './icons';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { messagesAtom } from '../atoms/messages';
import { resetAttachmentsAtom, updateAttachmentsFromSelectedItemsAtom } from '../atoms/attachments';
import { useSetAtom } from 'jotai';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    const setMessages = useSetAtom(messagesAtom);
    const resetAttachments = useSetAtom(resetAttachmentsAtom);
    const updateAttachmentsFromSelectedItems = useSetAtom(updateAttachmentsFromSelectedItemsAtom);
    
    const handleNewThread = () => {
        setMessages([]);
        resetAttachments();
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        updateAttachmentsFromSelectedItems(items);
    }

    return (
        <>
            <div className="flex-1">
                <button
                    className="icon-button scale-13"
                    onClick={() => triggerToggleChat(Zotero.getMainWindow())}
                >
                    <Icon icon={Cancel01Icon} />
                </button>
            </div>
            <div className="flex gap-4">
                {/* <button className="icon-button scale-13">
                    <Icon icon={Settings02Icon} />
                </button> */}
                <button className="icon-button scale-13">
                    <Icon icon={ClockIcon} />
                </button>
                <button
                    onClick={handleNewThread}
                    className="icon-button scale-13"
                >
                    
                    <Icon icon={PlusSignIcon} />
                </button>
            </div>
        </>
    );
};

export default Header;