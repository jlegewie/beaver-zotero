import React from 'react';
import { Icon, Cancel01Icon, Clock02Icon, PlusSignIcon } from './icons';
import { toggleChat } from '../../src/ui/chat';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    return (
        <div className="flex flex-row items-center mb-2">
            <div className="flex-1">
                <button
                    className="icon-button scale-12"
                    onClick={() => toggleChat(window, false)}
                >
                    <Icon icon={Cancel01Icon} />
                </button>
            </div>
            <div className="flex gap-4">
                <button className="icon-button scale-12">
                    <Icon icon={Clock02Icon} />
                </button>
                <button className="icon-button scale-12">
                    <Icon icon={PlusSignIcon} />
                </button>
            </div>
        </div>
    );
};

export default Header;