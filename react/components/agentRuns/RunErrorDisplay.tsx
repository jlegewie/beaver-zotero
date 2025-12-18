import React from 'react';
import { useSetAtom } from 'jotai';
import { Icon, AlertIcon, RepeatIcon, SettingsIcon } from '../icons/icons';
import Button from '../ui/Button';
import { parseTextWithLinksAndNewlines } from '../../utils/parseTextWithLinksAndNewlines';
import { regenerateFromRunAtom } from '../../atoms/generateMessagesWS';
import { isPreferencePageVisibleAtom } from '../../atoms/ui';

interface RunError {
    type: string;
    message: string;
    details?: string;
    is_retryable?: boolean;
    retry_after?: number;
}

interface RunErrorDisplayProps {
    runId: string;
    error: RunError;
}

/**
 * Displays an error message for a failed agent run.
 * Shows the error message (which may contain HTML links) and a retry button.
 */
export const RunErrorDisplay: React.FC<RunErrorDisplayProps> = ({ runId, error }) => {
    const regenerateFromRun = useSetAtom(regenerateFromRunAtom);
    const togglePreferencePage = useSetAtom(isPreferencePageVisibleAtom);

    const handleRetry = async () => {
        await regenerateFromRun(runId);
    };

    return (
        <div className="px-4">
            <div
                className="display-flex flex-col p-3 gap-3 rounded-lg"
                style={{ background: 'var(--tag-red-quinary)' }}
            >
                <div className="font-color-red display-flex flex-row gap-3 items-start">
                    <Icon icon={AlertIcon} className="scale-11 mt-020" />
                    <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                        <div className="text-base">
                            {parseTextWithLinksAndNewlines(error.message)}
                        </div>
                    </div>
                </div>
                <div className="display-flex flex-row gap-3 items-center">
                    <div className="flex-1" />
                    {error.type !== "usage_limit_exceeded" ? (
                        <Button
                            variant="outline"
                            className="border-error font-color-red"
                            rightIcon={RepeatIcon}
                            onClick={handleRetry}
                        >
                            Retry
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            className="border-error font-color-red"
                            rightIcon={SettingsIcon}
                            onClick={() => togglePreferencePage(true)}
                        >
                            Settings
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RunErrorDisplay;

