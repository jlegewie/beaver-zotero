import React from 'react';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { SettingsIcon, UserIcon, LogoutIcon } from './icons';
import { supabase } from '../../src/services/supabaseClient';

interface UserAccountMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * Button component that shows user account menu in a dropdown menu
 */
const UserAccountMenuButton: React.FC<UserAccountMenuButtonProps> = ({ 
    className = '',
    ariaLabel = 'User Account Menu'
}) => {

    // Create menu items from threads
    const menuItems: MenuItem[] = [
        {
            label: "Settings",
            onClick: () => console.log('manage account'),
            icon: SettingsIcon,
        },
        {
            label: "Manage account",
            onClick: () => console.log('manage account'),
            icon: UserIcon,
        },
        {
            label: "Logout",
            onClick: () => {
                supabase.auth.signOut();
            },
            icon: LogoutIcon,
        }
    ];

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            icon={UserIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="User account and settings"
            showArrow={true}
        />
    );
};

export default UserAccountMenuButton; 