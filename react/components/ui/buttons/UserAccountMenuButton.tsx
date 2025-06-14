import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { SettingsIcon, UserIcon, LogoutIcon } from '../../icons/icons';
import { isPreferencePageVisibleAtom } from '../../../atoms/ui';
import { useAtomValue, useSetAtom } from 'jotai';
import { useAuth } from '../../../hooks/useAuth';
import { hasCompletedOnboardingAtom } from '../../../atoms/profile';

interface UserAccountMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * Button component that shows user account menu in a dropdown menu
 */
const UserAccountMenuButton: React.FC<UserAccountMenuButtonProps> = ({ 
    className = '',
    ariaLabel = 'User Account Menu',
}) => {
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const togglePreferencePage = useSetAtom(isPreferencePageVisibleAtom);
    const { signOut } = useAuth();

    // Create menu items from threads
    const menuItems: MenuItem[] = [
        {
            label: "Settings",
            onClick: () => togglePreferencePage((prev) => !prev),
            icon: SettingsIcon,
            disabled: !hasCompletedOnboarding,
        },
        {
            label: "Manage account",
            onClick: () => console.log('manage account'),
            icon: UserIcon,
        },
        {
            label: "Logout",
            onClick: async () => {
                await signOut();
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