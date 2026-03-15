import React from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertIcon, CancelIcon } from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { RunWarning, dismissWarningAtom } from '../../atoms/warnings';
import { setPref } from '../../../src/utils/prefs';
import { requestPlusToolsAtom } from '../../atoms/ui';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';

interface RunWarningDisplayProps {
    warning: RunWarning;
}

/**
 * Displays a dismissable warning message for an agent run.
 * Warnings are non-fatal issues that don't block the response.
 */
export const RunWarningDisplay: React.FC<RunWarningDisplayProps> = ({ warning }) => {
    const dismissWarning = useSetAtom(dismissWarningAtom);
    const setRequestPlusTools = useSetAtom(requestPlusToolsAtom);

    const handleDismiss = () => {
        dismissWarning(warning.id);
    };

    const handleDisablePlusTools = () => {
        setPref('requestPlusTools', false);
        setRequestPlusTools(false);
        dismissWarning(warning.id);
    };

    const showLowCreditsButtons = warning.type === 'low_credits';
    const showPlusToolsDegradedButtons = warning.type === 'plus_tools_degraded';

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
            {showLowCreditsButtons && !showPlusToolsDegradedButtons && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="mt-020"
                        onClick={() => openPreferencesWindow('billing')}
                    >
                        Get Beaver Credits
                    </Button>
                </div>
            )}
            {showPlusToolsDegradedButtons && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={() => openPreferencesWindow('billing')}
                    >
                        Get Beaver Credits
                    </Button>
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={handleDisablePlusTools}
                    >
                        Disable Plus Tools
                    </Button>
                </div>
            )}
        </div>
    );
};

export default RunWarningDisplay;
