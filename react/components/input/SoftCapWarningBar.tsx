import React from 'react';
import { InformationCircleIcon, CancelIcon, Icon } from '../icons/icons';
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
        <div className="high-token-usage-warning-bar display-flex flex-row items-start px-3 py-2 gap-2">
            <Icon icon={InformationCircleIcon} className="font-color-secondary scale-10 mt-015" />
            <span className="font-color-secondary text-sm">
                Beaver paused and summarized its progress.{' '}
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
                    Disable pausing
                </a>
                {' '}to avoid interruptions. Additional costs may apply.
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
