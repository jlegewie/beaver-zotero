import React, { forwardRef } from 'react';

/**
 * Shared presentational shell for a context chip (attachments, filters, sources,
 * external files). Purely visual — fixed height and outline styling — so both the
 * read-only request chips and the editable composition chips render identically.
 *
 * All stateful behavior (hover remove "x", context menus, validation styling) is
 * composed by the caller via children and spread props; the shell stays
 * client-agnostic and free of Zotero access. Only a primary (left) click
 * activates: non-primary clicks are swallowed so a right-click that opens a
 * context menu isn't treated as activation.
 */
function stopLeftClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (e.button !== 0) {
        e.preventDefault();
    }
}

export interface ChipButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: React.ReactNode;
}

export const ChipButton = forwardRef<HTMLButtonElement, ChipButtonProps>(
    function ChipButton({ children, className = '', onClick, disabled, ...rest }, ref) {
        return (
            <button
                ref={ref}
                type="button"
                style={{ height: '22px' }}
                className={`variant-outline source-button ${className}`}
                disabled={disabled}
                onClick={(e) => {
                    stopLeftClick(e);
                    if (e.button === 0) onClick?.(e);
                }}
                {...rest}
            >
                {children}
            </button>
        );
    }
);

export default ChipButton;
