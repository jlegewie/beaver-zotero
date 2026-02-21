import React, { useMemo, useState } from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { ArrowDownIcon, Icon, TickIcon } from '../../icons/icons';
import { getPref, setPref } from '../../../../src/utils/prefs';

interface ExternalSearchApprovalButtonProps {
    /** Callback when user switches to "Always approve" — caller should also approve the current pending action */
    onAlwaysApprove?: () => void;
}

const LABELS: Record<string, string> = {
    ask: 'Always ask',
    approve: 'Always approve',
};

/**
 * Dropdown button for the confirm_external_search cost confirmation preference.
 * Binary choice: "Always ask" (default) or "Always approve".
 * When switching to "Always approve", fires onAlwaysApprove so the caller
 * can also approve the currently pending action.
 */
const ExternalSearchApprovalButton: React.FC<ExternalSearchApprovalButtonProps> = ({
    onAlwaysApprove,
}) => {
    const [current, setCurrent] = useState<'ask' | 'approve'>(() => {
        const val = getPref('confirmExternalSearchCosts') as boolean;
        return val ? 'ask' : 'approve';
    });

    const handleSelect = (value: 'ask' | 'approve') => {
        setCurrent(value);
        setPref('confirmExternalSearchCosts', value === 'ask');
        if (value === 'approve') {
            onAlwaysApprove?.();
        }
    };

    const menuItems = useMemo((): MenuItem[] => {
        return (['ask', 'approve'] as const).map((value) => ({
            label: LABELS[value],
            onClick: () => handleSelect(value),
            customContent: (
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <div className={`display-flex text-sm ${current === value ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                        {LABELS[value]}
                    </div>
                    {current === value && (
                        <Icon icon={TickIcon} className="font-color-primary scale-11" />
                    )}
                </div>
            ),
        }));
    }, [current]);

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            buttonLabel={LABELS[current]}
            rightIcon={ArrowDownIcon}
            style={{
                padding: '2px 2px',
                fontSize: '0.90rem',
            }}
            rightIconClassName="scale-11 -ml-05"
            ariaLabel="External search approval preference"
            tooltipContent="How to handle external search cost confirmations"
            showArrow={false}
        />
    );
};

export default ExternalSearchApprovalButton;
