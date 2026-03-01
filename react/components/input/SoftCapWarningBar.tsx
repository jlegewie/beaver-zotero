import React from 'react';
import { AlertIcon, CancelIcon, Icon } from '../icons/icons';
import IconButton from '../ui/IconButton';

interface SoftCapWarningBarProps {
    onEnableLongRunning: (e: React.MouseEvent) => void;
    onDismiss: (e: React.MouseEvent) => void;
}

/**
 * Warning shown above the input when the agent run was cut short by the soft cap.
 * Offers a link to enable long-running tasks (disables the soft cap preference).
 */
const SoftCapWarningBar: React.FC<SoftCapWarningBarProps> = ({
    onEnableLongRunning,
    onDismiss,
}) => {
    const [isLinkHovered, setIsLinkHovered] = React.useState(false);

    return (
        <div className="high-token-usage-warning-bar display-flex flex-row items-start px-3 py-15 gap-2">
            <Icon icon={AlertIcon} className="font-color-orange scale-10 mt-010" />
            <span className="font-color-secondary text-sm">
                This task was cut short to save credits.
                {' '}
                <a
                    href="#"
                    className={`${isLinkHovered ? 'font-color-primary' : 'font-color-secondary'} transition text-sm text-underline`}
                    onMouseEnter={() => setIsLinkHovered(true)}
                    onMouseLeave={() => setIsLinkHovered(false)}
                    onFocus={() => setIsLinkHovered(true)}
                    onBlur={() => setIsLinkHovered(false)}
                    onClick={(e) => {
                        e.preventDefault();
                        onEnableLongRunning(e);
                    }}
                >
                    Enable long-running tasks
                </a>
                {' '}
                to let the agent work longer.
            </span>
            <div className="flex-1" />
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel="Dismiss soft cap warning"
                onClick={onDismiss}
                className="scale-85 mt-010"
            />
        </div>
    );
};

export default SoftCapWarningBar;
