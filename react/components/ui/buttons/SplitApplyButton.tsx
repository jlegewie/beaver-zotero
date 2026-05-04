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
    /** Label for the dropdown menu item. Defaults to "Apply all for this note". */
    applyAllLabel?: string;
}

/**
 * Split button: left half is a normal "Apply" button, right half is a small
 * chevron that opens a single-item dropdown ("Apply all for this note").
 */
const SplitApplyButton: React.FC<SplitApplyButtonProps> = ({
    onApply,
    onApplyAll,
    loading = false,
    disabled = false,
    primaryLabel = 'Apply',
    applyAllLabel = 'Apply all for this note',
}) => {
    const menuItems: MenuItem[] = [
        {
            label: applyAllLabel,
            onClick: onApplyAll,
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
