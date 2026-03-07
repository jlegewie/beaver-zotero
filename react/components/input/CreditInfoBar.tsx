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
    const data = warning.data as { remaining_credits?: number; limit?: number; purchased_credits?: number } | undefined;
    const remaining = data?.remaining_credits;
    const limit = data?.limit;
    const purchased = data?.purchased_credits ?? 0;

    let label: string;
    if (remaining === undefined) {
        label = 'Credits running low';
    } else if (remaining < 30) {
        // Low credits — show count regardless of subscriber status
        label = `${remaining} Beaver credits remaining`;
    } else if (limit && limit > 0) {
        // Subscriber with enough credits: show subscription usage percentage
        const subscriptionRemaining = Math.max(0, remaining - purchased);
        const usedPct = Math.round(((limit - subscriptionRemaining) / limit) * 100);
        label = `You've used ${usedPct}% of your monthly credits`;
    } else {
        // Non-subscriber: show remaining count
        label = `${remaining} Beaver credits remaining`;
    }

    return (
        <div
            className="credit-info-bar display-flex flex-row items-center gap-1 cursor-pointer transition-colors"
            onClick={() => openPreferencesWindow('billing')}
        >
            <Icon icon={SpeedIcon} className="credit-info-bar-icon font-color-tertiary scale-90 transition-colors" />
            <span className="credit-info-bar-text font-color-tertiary text-xs flex-1 min-w-0 truncate transition-colors">
                {label}
            </span>
        </div>
    );
};

export default CreditInfoBar;
