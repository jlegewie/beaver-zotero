import React from 'react';
import { SpeedIcon, Icon } from '../icons/icons';
import { RunWarning } from '../../atoms/warnings';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';

interface CreditInfoBarProps {
    warning: RunWarning;
}

/**
 * Subtle info bar shown below the input area when the backend sends a credit_info warning.
 */
const CreditInfoBar: React.FC<CreditInfoBarProps> = ({ warning }) => {
    const remaining = warning.data && 'remaining_credits' in warning.data
        ? (warning.data.remaining_credits as number)
        : undefined;

    return (
        <div
            className="credit-info-bar display-flex flex-row items-center gap-1 cursor-pointer transition-colors"
            onClick={() => openPreferencesWindow('billing')}
        >
            <Icon icon={SpeedIcon} className="credit-info-bar-icon font-color-tertiary scale-90 transition-colors" />
            <span className="credit-info-bar-text font-color-tertiary text-xs flex-1 min-w-0 truncate transition-colors">
                {remaining !== undefined
                    ? `${remaining} credits remaining`
                    : 'Credits running low'}
            </span>
        </div>
    );
};

export default CreditInfoBar;
