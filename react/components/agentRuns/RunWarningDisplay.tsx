import React from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertIcon, CancelIcon } from '../icons/icons';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { RunWarning, dismissWarningAtom } from '../../atoms/warnings';
import { setPref } from '../../../src/utils/prefs';
import { requestProToolsAtom } from '../../atoms/ui';
import { useBilling } from '../../hooks/useBilling';

interface RunWarningDisplayProps {
    warning: RunWarning;
}

/**
 * Displays a dismissable warning message for an agent run.
 * Warnings are non-fatal issues that don't block the response.
 */
export const RunWarningDisplay: React.FC<RunWarningDisplayProps> = ({ warning }) => {
    const dismissWarning = useSetAtom(dismissWarningAtom);
    const setRequestProTools = useSetAtom(requestProToolsAtom);
    const { subscribe, buyCredits, isLoading } = useBilling();

    const handleDismiss = () => {
        dismissWarning(warning.id);
    };

    const handleDisableProTools = () => {
        setPref('requestProTools', false);
        setRequestProTools(false);
        dismissWarning(warning.id);
    };

    const showLowCreditsButtons = warning.type === 'low_credits';
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
            {showLowCreditsButtons && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={() => subscribe()}
                        disabled={isLoading}
                    >
                        Subscribe
                    </Button>
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={buyCredits}
                        disabled={isLoading}
                    >
                        Buy Credits
                    </Button>
                </div>
            )}
            {showProToolsDegradedButtons && (
                <div className="display-flex flex-row gap-3 items-start mr-1">
                    <div className="flex-1" />
                    <Button
                        variant="outline"
                        className="scale-90 mt-020"
                        onClick={buyCredits}
                        disabled={isLoading}
                    >
                        Buy Credits
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
