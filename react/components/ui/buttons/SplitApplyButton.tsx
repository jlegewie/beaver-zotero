import React from 'react';
import Button from '../Button';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { ArrowDownIcon } from '../../icons/icons';

interface SplitApplyButtonProps {
    onApply: () => void;
    onApplyAll: () => void;
    loading?: boolean;
    disabled?: boolean;
    /** Label for the primary (left) button. Defaults to "Apply". */
    primaryLabel?: string;
    /** Full accessible label for the dropdown menu item. */
    applyAllLabel?: string;
    /** Short description of the action group shown below the menu title. */
    applyAllScope?: string;
}

function sentenceCase(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Split button: left half is a normal "Apply" button, right half is a small
 * chevron that opens one broader approval option.
 */
const SplitApplyButton: React.FC<SplitApplyButtonProps> = ({
    onApply,
    onApplyAll,
    loading = false,
    disabled = false,
    primaryLabel = 'Apply',
    applyAllLabel = 'Allow this action group for this run',
    applyAllScope = 'Similar actions',
}) => {
    const menuItems: MenuItem[] = [
        {
            label: applyAllLabel,
            onClick: onApplyAll,
            customContent: (
                <div className="display-flex flex-col min-w-0" style={{ lineHeight: 1.25 }}>
                    <div className="text-base font-medium font-color-primary">
                        Allow for this run
                    </div>
                    <div
                        className="text-base font-color-secondary"
                        style={{ whiteSpace: 'normal', overflowWrap: 'break-word' }}
                    >
                        {sentenceCase(applyAllScope)}
                    </div>
                </div>
            ),
        },
    ];

    return (
        <div className="display-flex flex-row items-stretch" style={{ gap: 0 }}>
            {/* Primary half */}
            <Button
                variant="solid"
                onClick={onApply}
                loading={loading}
                disabled={disabled}
                style={{
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                    borderRight: 'none',
                }}
            >
                {primaryLabel}
            </Button>

            {/* Chevron dropdown half */}
            <MenuButton
                menuItems={menuItems}
                variant="solid"
                icon={ArrowDownIcon}
                iconClassName="scale-11"
                disabled={disabled || loading}
                ariaLabel="More apply options"
                showArrow={false}
                maxWidth="180px"
                // maxWidth="calc(100vw - 24px)"
                style={{
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    paddingLeft: '3px',
                    paddingRight: '3px',
                    minWidth: 0,
                    borderLeft: '1px solid rgba(255,255,255,0.25)',
                    alignSelf: 'stretch',
                }}
            />
        </div>
    );
};

export default SplitApplyButton;
