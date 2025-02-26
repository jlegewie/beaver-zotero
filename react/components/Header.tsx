import React from 'react';
import { Icon, CancelIcon, ClockIcon, PlusSignIcon, Settings02Icon } from './icons';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { messagesAtom } from '../atoms/messages';
import { resetResourcesAtom, updateResourcesFromZoteroSelectionAtom } from '../atoms/resources';

import { useSetAtom } from 'jotai';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    const setMessages = useSetAtom(messagesAtom);
    const resetResources = useSetAtom(resetResourcesAtom);
    const updateResourcesFromZoteroSelection = useSetAtom(updateResourcesFromZoteroSelectionAtom);
    
    const handleNewThread = async () => {
        setMessages([]);
        resetResources();
        await updateResourcesFromZoteroSelection();
    }

    return (
        <div id="beaver-header" className="flex flex-row p-3 pb-2">
            <div className="flex-1">
                <button
                    className="icon-button scale-14"
                    onClick={() => triggerToggleChat(Zotero.getMainWindow())}
                >
                    <Icon icon={CancelIcon} />
                </button>
            </div>
            <div className="flex gap-4">
                {/* <button className="icon-button scale-14">
                    <Icon icon={Settings02Icon} />
                </button> */}
                <button className="icon-button scale-14">
                    <Icon icon={ClockIcon} />
                </button>
                <button
                    onClick={handleNewThread}
                    className="icon-button scale-14"
                >
                    <Icon icon={PlusSignIcon} />
                </button>
            </div>
        </div>
    );
};

export default Header;