import React, { useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { SpeedIcon, CancelIcon, Icon } from '../icons/icons';
import { RunWarning, dismissWarningAtom } from '../../atoms/warnings';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import IconButton from '../ui/IconButton';

const AUTO_DISMISS_MS = 300_000;

interface CreditInfoBarProps {
    warning: RunWarning;
}

/**
 * Subtle info bar shown below the input area when the backend sends a credit_info warning.
 */
const CreditInfoBar: React.FC<CreditInfoBarProps> = ({ warning }) => {
    const dismissWarning = useSetAtom(dismissWarningAtom);
    const data = warning.data as { remaining_credits?: number; limit?: number; purchased_credits?: number } | undefined;
    const remaining = data?.remaining_credits;
    const limit = data?.limit;
    const purchased = data?.purchased_credits ?? 0;

    const handleDismiss = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        dismissWarning(warning.id);
    }, [dismissWarning, warning.id]);

    const handleClick = useCallback((e: React.MouseEvent) => {
        openPreferencesWindow('billing')
        handleDismiss(e);
    }, [handleDismiss]);

    // Auto-expire after timeout
    useEffect(() => {
        const timer = setTimeout(() => dismissWarning(warning.id), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [dismissWarning, warning.id]);

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
            onClick={handleClick}
        >
            <Icon icon={SpeedIcon} className="credit-info-bar-icon font-color-tertiary scale-90 transition-colors" />
            <span className="credit-info-bar-text font-color-tertiary text-xs flex-1 min-w-0 truncate transition-colors">
                {label}
            </span>
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel="Dismiss credit info"
                onClick={handleDismiss}
                className="scale-85"
            />
        </div>
    );
};

export default CreditInfoBar;
