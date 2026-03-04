import React from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertIcon, CancelIcon, SettingsIcon } from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { RunWarning, dismissWarningAtom } from '../../atoms/warnings';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { setPref } from '../../../src/utils/prefs';

interface RunWarningDisplayProps {
    warning: RunWarning;
}

/**
 * Placeholder for navigating to credit purchase flow.
 * TODO: Implement as separate window, modal, or external link depending on final UX decision.
 */
function openAddCredits(): void {
    // TODO: Implement credit purchase navigation
    // This will be used across different parts of the frontend
    // (separate window, modal, or external link — TBD)
    openPreferencesWindow('models');
}

/**
 * Displays a dismissable warning message for an agent run.
 * Warnings are non-fatal issues that don't block the response.
 */
export const RunWarningDisplay: React.FC<RunWarningDisplayProps> = ({ warning }) => {
    const dismissWarning = useSetAtom(dismissWarningAtom);

    const handleDismiss = () => {
        dismissWarning(warning.id);
    };

    const handleDisableProTools = () => {
        setPref('requestProTools', false);
        dismissWarning(warning.id);
    };

    // Determine button layout based on warning type
    const showSettingsButton = warning.type === 'low_credits';
    const showProToolsDegradedButtons = warning.type === 'pro_tools_degraded';

    return (
        <div className="display-flex flex-col p-3 gap-3 rounded-lg bg-quinary">
            <div className="font-color-secondary display-flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-11 mt-020" />
                <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                    <div className="display-flex flex-row gap-2 items-start">
                        <div className="text-base">
                            {parseTextWithLinksAndNewlines(warning.message)}
                        </div>
                        <div className="flex-1" />
                        <IconButton
                            variant="ghost-secondary"
                            icon={CancelIcon}
                            className="mr-1 scale-90 mt-015"
                            onClick={handleDismiss}
                        />
                    </div>
                </div>
            </div>
            {showSettingsButton && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        rightIcon={SettingsIcon}
                        onClick={() => openPreferencesWindow('models')}
                    >
                        Settings
                    </Button>
                </div>
            )}
            {showProToolsDegradedButtons && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={openAddCredits}
                    >
                        Add Credits
                    </Button>
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={handleDisableProTools}
                    >
                        Disable Pro Tools
                    </Button>
                </div>
            )}
        </div>
    );
};

export default RunWarningDisplay;
