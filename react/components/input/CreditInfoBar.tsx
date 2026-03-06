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
    let usedPercentage = 80; // default fallback if we can't parse
    
    if (warning.data && 'remaining_percentage' in warning.data && typeof warning.data.remaining_percentage === 'number') {
        usedPercentage = Math.round(100 - warning.data.remaining_percentage);
    } else {
        const match = warning.message.match(/(\d+)%/);
        if (match && match[1]) {
            const parsed = parseInt(match[1], 10);
            if (!warning.message.toLowerCase().includes('used')) {
                usedPercentage = 100 - parsed;
            } else {
                usedPercentage = parsed;
            }
        }
    }

    return (
        <div 
            className="credit-info-bar display-flex flex-row items-center gap-1 cursor-pointer transition-colors"
            onClick={() => openPreferencesWindow('billing')}
        >
            <Icon icon={SpeedIcon} className="credit-info-bar-icon font-color-tertiary scale-90 transition-colors" />
            <span className="credit-info-bar-text font-color-tertiary text-xs flex-1 min-w-0 truncate transition-colors">
                You've used {usedPercentage}% of your included API usage
            </span>
        </div>
    );
};

export default CreditInfoBar;
