import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { SettingsIcon, UserIcon, LogoutIcon, BugIcon } from '../../icons/icons';
import { isErrorReportDialogVisibleAtom } from '../../../atoms/ui';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasCompletedOnboardingAtom, updateRequiredAtom } from '../../../atoms/profile';
import { logoutAtom } from '../../../atoms/auth';
import { openPreferencesWindow } from '../../../../src/ui/openPreferencesWindow';

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
    const updateRequired = useAtomValue(updateRequiredAtom);
    const setErrorReportDialogVisible = useSetAtom(isErrorReportDialogVisibleAtom);
    const logout = useSetAtom(logoutAtom);

    // Create menu items (filter out settings when update is required)
    const menuItems: MenuItem[] = [
        // Hide settings when update is required
        ...(!updateRequired ? [{
            label: "Settings",
            onClick: () => openPreferencesWindow(),
            icon: SettingsIcon,
            disabled: !hasCompletedOnboarding,
        }] : []),
        {
            label: "Manage Account",
            onClick: () => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/login'),
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