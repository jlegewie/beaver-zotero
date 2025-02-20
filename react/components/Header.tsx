import React from 'react';
import { Icon, Cancel01Icon, Clock02Icon, PlusSignIcon, Settings02Icon } from './icons';
import { toggleChat } from '../../src/ui/chat';
import { messagesAtom } from '../atoms/messages';
import { resetAttachmentsAtom } from '../atoms/attachments';
import { useSetAtom } from 'jotai';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    const setMessages = useSetAtom(messagesAtom);
    const resetAttachments = useSetAtom(resetAttachmentsAtom);

    const handleNewThread = () => {
        setMessages([]);
        resetAttachments();
    }

    return (
        <>
            <div className="flex-1">
                <button
                    className="icon-button scale-12"
                    onClick={() => toggleChat(Zotero.getMainWindow(), false)}
                >
                    <Icon icon={Cancel01Icon} />
                </button>
            </div>
            <div className="flex gap-4">
                {/* <button className="icon-button scale-12">
                    <Icon icon={Settings02Icon} />
                </button> */}
                <button className="icon-button scale-12">
                    <Icon icon={Clock02Icon} />
                </button>
                <button
                    onClick={handleNewThread}
                    className="icon-button scale-12"
                >
                    
                    <Icon icon={PlusSignIcon} />
                </button>
            </div>
        </>
    );
};

export default Header;