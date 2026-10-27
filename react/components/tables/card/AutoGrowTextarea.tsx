import React, { forwardRef, useLayoutEffect, useRef } from 'react';

/** Lines a field grows to before it scrolls. */
const MAX_LINES = 8;

type AutoGrowTextareaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> & {
    value: string;
    /** Drop the default field styling; the caller's class styles the field. */
    bare?: boolean;
};

/**
 * A multi-line field on the table card that grows with its text. Enter adds a
 * line and never reaches a host shortcut, so typing cannot decide the card.
 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(function AutoGrowTextarea(
    { value, className, style, bare = false, onKeyDown, ...rest },
    forwardedRef,
) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
    }, [value]);
    return (
        <textarea
            ref={(el) => {
                ref.current = el;
                if (typeof forwardedRef === 'function') forwardedRef(el);
                else if (forwardedRef) forwardedRef.current = el;
            }}
            rows={1}
            value={value}
            className={bare ? className : `preference-input py-1 px-2 text-sm ${className ?? ''}`}
            style={{ resize: 'none', boxSizing: 'border-box', lineHeight: 1.35, maxHeight: `${MAX_LINES * 1.35}em`, overflowY: 'auto', ...style }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') e.stopPropagation();
                onKeyDown?.(e);
            }}
            {...rest}
        />
    );
});

export default AutoGrowTextarea;
