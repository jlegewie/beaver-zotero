import React from 'react';
import { AlertIcon, CancelIcon, Icon } from '../icons/icons';
import IconButton from '../ui/IconButton';

interface HighTokenUsageWarningBarProps {
    inputTokens: number;
    threshold: number;
    onDismiss: (e: React.MouseEvent) => void;
}

const formatTokens = (count: number): string => count.toLocaleString();

/**
 * Subtle warning shown above the input when the latest request used a high
 * number of input tokens.
 */
const HighTokenUsageWarningBar: React.FC<HighTokenUsageWarningBarProps> = ({
    inputTokens,
    threshold,
    onDismiss,
}) => {
    return (
        <div className="high-token-usage-warning-bar display-flex flex-row items-center px-3 py-15 gap-2">
            <Icon icon={AlertIcon} className="font-color-orange scale-11 mt-010" />
            <span className="font-color-secondary text-sm">
                Last request used {formatTokens(inputTokens)} input tokens (&gt;{formatTokens(threshold)}).
            </span>
            <div className="flex-1" />
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel="Dismiss token usage warning"
                onClick={onDismiss}
                className="scale-85"
            />
        </div>
    );
};

export default HighTokenUsageWarningBar;
