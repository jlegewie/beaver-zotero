import React from 'react';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { SettingsIcon, UserIcon, LogoutIcon, BugIcon, InformationCircleIcon, IdeaIcon } from '../../icons/icons';
import { isErrorReportDialogVisibleAtom } from '../../../atoms/ui';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasCompletedOnboardingAtom, updateRequiredAtom, profileWithPlanAtom } from '../../../atoms/profile';
import { logoutAtom, userAtom } from '../../../atoms/auth';
import { firstRunReturnRequestedAtom, firstRunSuggestionsModeAtom } from '../../../atoms/firstRun';
import { openPreferencesWindow } from '../../../ui/openPreferencesWindow';

interface UserAccountMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * The account menu's entries. Shared by the header button and the separate
 * window's account footer, so the two surfaces offer the same actions.
 */
export function useAccountMenuItems(): MenuItem[] {
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const profile = useAtomValue(profileWithPlanAtom);
    const setErrorReportDialogVisible = useSetAtom(isErrorReportDialogVisibleAtom);
    const logout = useSetAtom(logoutAtom);
    const user = useAtomValue(userAtom);
    const setFirstRunReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const setFirstRunSuggestionsMode = useSetAtom(firstRunSuggestionsModeAtom);
    const hasCompletedFirstRun = !!profile?.first_run_completed_at;

    const handleShowIdeas = () => {
        setFirstRunSuggestionsMode(true);
        setFirstRunReturnRequested(true);
    };

    // Settings is hidden when an update is required.
    return [
        ...(!updateRequired ? [{
            label: "Settings",
            onClick: () => openPreferencesWindow(),
            icon: SettingsIcon,
            disabled: !hasCompletedOnboarding,
        }] : []),
        {
            label: "Manage Account",
            onClick: () => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/login${user?.email ? `?email=${encodeURIComponent(user.email)}` : ''}`),
            icon: UserIcon,
            disabled: false,
        },
        ...(!updateRequired && hasCompletedOnboarding && hasCompletedFirstRun ? [{
            label: "Get ideas",
            onClick: handleShowIdeas,
            icon: IdeaIcon,
            disabled: false,
        }] : []),
        {
            label: "Get Help",
            onClick: () => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/docs/getting-started`),
            icon: InformationCircleIcon,
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
}

/**
 * Button component that shows user account menu in a dropdown menu
 */
const UserAccountMenuButton: React.FC<UserAccountMenuButtonProps> = ({
    className = '',
    ariaLabel = 'User Account Menu',
}) => {
    const menuItems = useAccountMenuItems();

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
