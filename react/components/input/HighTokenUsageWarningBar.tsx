import React from 'react';
import { AlertIcon, CancelIcon, Icon } from '../icons/icons';
import IconButton from '../ui/IconButton';

interface HighTokenUsageWarningBarProps {
    onNewThread: (e: React.MouseEvent) => void;
    onDismiss: (e: React.MouseEvent) => void;
}

/**
 * Subtle warning shown above the input when the latest request used a high
 * number of input tokens.
 */
const HighTokenUsageWarningBar: React.FC<HighTokenUsageWarningBarProps> = ({
    onNewThread,
    onDismiss,
}) => {
    const [isNewThreadLinkHovered, setIsNewThreadLinkHovered] = React.useState(false);

    return (
        <div className="high-token-usage-warning-bar display-flex flex-row items-start px-3 py-15 gap-2">
            <Icon icon={AlertIcon} className="font-color-orange scale-10 mt-010" />
            <span className="font-color-secondary text-sm">
                Your conversation is long.
                {' '}
                <a
                    href="#"
                    className={`${isNewThreadLinkHovered ? 'font-color-primary' : 'font-color-secondary'} transition text-sm text-underline`}
                    onMouseEnter={() => setIsNewThreadLinkHovered(true)}
                    onMouseLeave={() => setIsNewThreadLinkHovered(false)}
                    onFocus={() => setIsNewThreadLinkHovered(true)}
                    onBlur={() => setIsNewThreadLinkHovered(false)}
                    onClick={(e) => {
                        e.preventDefault();
                        onNewThread(e);
                    }}
                >
                    Start a new thread
                </a>
                {' '}
                to reduce cost and improve response quality.
            </span>
            <div className="flex-1" />
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel="Dismiss token usage warning"
                onClick={onDismiss}
                className="scale-85 mt-010"
            />
        </div>
    );
};

export default HighTokenUsageWarningBar;
