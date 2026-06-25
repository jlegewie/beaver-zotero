import React from 'react';
import { CSSIcon } from '../../icons/icons';

export interface ChipRemovableIconProps {
    /** Leading icon shown by default; hidden on chip hover. */
    normalIcon: React.ReactNode;
    /** Click handler props for the remove "x" (from `useRemoveContextMenu`). */
    removeHandlers: React.HTMLAttributes<HTMLSpanElement>;
    /** Keep the remove "x" visible while the context menu is open. */
    removeMenuOpen?: boolean;
}

/**
 * Fixed-size leading icon slot for editable context chips. The remove "x" is
 * toggled with CSS `:hover` on the parent `.source-button` so chips that slide
 * under a stationary cursor after a removal still show hover state correctly.
 */
export function ChipRemovableIcon({
    normalIcon,
    removeHandlers,
    removeMenuOpen = false,
}: ChipRemovableIconProps) {
    return (
        <span className={`chip-icon-slot${removeMenuOpen ? ' chip-icon-slot-remove-open' : ''}`}>
            {normalIcon && (
                <span className="chip-icon-slot-normal">{normalIcon}</span>
            )}
            <span
                role="button"
                className="source-remove chip-icon-slot-remove"
                {...removeHandlers}
            >
                <CSSIcon name="x-8" className="icon-16 scale-80" />
            </span>
        </span>
    );
}

export default ChipRemovableIcon;
