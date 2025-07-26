import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { SettingsIcon, UserIcon, LogoutIcon, BugIcon } from '../../icons/icons';
import { isPreferencePageVisibleAtom, isErrorReportDialogVisibleAtom } from '../../../atoms/ui';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasCompletedOnboardingAtom } from '../../../atoms/profile';
import { logoutAtom } from '../../../atoms/auth';

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
    const setErrorReportDialogVisible = useSetAtom(isErrorReportDialogVisibleAtom);
    const logout = useSetAtom(logoutAtom);

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
            onClick: () => Zotero.launchURL('https://www.beaverapp.ai/login'),
            icon: UserIcon,
            disabled: false,
        },
        {
            label: "Report Error",
            onClick: () => setErrorReportDialogVisible(true),
            icon: BugIcon,
            disabled: false,
        },
        {
            label: "Logout",
            onClick: async () => {
                logout();
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