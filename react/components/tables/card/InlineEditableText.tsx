import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { EditIcon, Icon } from '../../icons/icons';
import AutoGrowTextarea from './AutoGrowTextarea';

export interface InlineEditableTextProps {
    value: string;
    onChange: (value: string) => void;
    /** Shown in place of an empty value. */
    placeholder: string;
    /** The field's accessible name while editing. */
    ariaLabel: string;
    /** The pencil button's accessible name. */
    editLabel: string;
    /** Wrap onto several lines while editing (the text always wraps). */
    multiline?: boolean;
    disabled?: boolean;
    /** Typography for both the text and the field, so editing does not shift the layout. */
    className?: string;
}

/**
 * Text that reads as text, with a quiet pencil at its end. Clicking the text or
 * the pencil swaps in a field with the same typography. Edits apply as typed;
 * Enter or leaving the field finishes (by mouse, once the press completes, so
 * the layout holds under the pointer), Escape restores the value from before
 * the edit; both keys are left to an IME while it composes. Enter never reaches a
 * host shortcut, so it cannot decide the card.
 */
export const InlineEditableText: React.FC<InlineEditableTextProps> = ({
    value,
    onChange,
    placeholder,
    ariaLabel,
    editLabel,
    multiline = false,
    disabled = false,
    className = '',
}) => {
    const [editing, setEditing] = useState(false);
    const original = useRef(value);
    const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
    /** A mouse button is down somewhere in the document. */
    const pressing = useRef(false);
    /** Focus left during a press; the edit finishes once the press completes. */
    const closeAfterPress = useRef(false);

    useLayoutEffect(() => {
        if (!editing || !fieldRef.current) return;
        const field = fieldRef.current;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }, [editing]);

    // Leaving the field by mouse blurs it on mousedown. Swapping the field for
    // text then can change the header's height (a single-line title wraps), which
    // moves the pressed control (Next, Create) out from under the pointer before
    // its click. So a blur during a press waits for the press to complete: its
    // click, or a mouseup that produces none.
    useEffect(() => {
        const doc = fieldRef.current?.ownerDocument;
        if (!editing || !doc) return;
        const win = doc.defaultView;
        let timer: number | undefined;
        const release = () => {
            pressing.current = false;
            if (closeAfterPress.current) {
                closeAfterPress.current = false;
                setEditing(false);
            }
        };
        const onMouseDown = () => {
            pressing.current = true;
        };
        // The click follows its mouseup in the same task; the timer only
        // settles a press that ends without one (a drag).
        const onMouseUp = () => {
            if (win) timer = win.setTimeout(release, 0);
            else release();
        };
        doc.addEventListener('mousedown', onMouseDown, true);
        doc.addEventListener('mouseup', onMouseUp, true);
        doc.addEventListener('click', release, true);
        return () => {
            doc.removeEventListener('mousedown', onMouseDown, true);
            doc.removeEventListener('mouseup', onMouseUp, true);
            doc.removeEventListener('click', release, true);
            if (timer !== undefined) win?.clearTimeout(timer);
            pressing.current = false;
            closeAfterPress.current = false;
        };
    }, [editing]);

    const onBlur = () => {
        if (pressing.current) closeAfterPress.current = true;
        else setEditing(false);
    };

    const start = () => {
        if (disabled) return;
        original.current = value;
        setEditing(true);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        // Enter and Escape belong to an active IME composition (confirming or
        // cancelling a candidate); acting on them would end the edit mid-word.
        if (isImeKeyEvent(e.nativeEvent)) {
            if (e.key === 'Enter') e.stopPropagation();
            return;
        }
        if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onChange(original.current);
            setEditing(false);
        }
    };

    if (editing && !disabled) {
        const fieldClass = `table-card-inline-field ${className}`;
        return multiline ? (
            <AutoGrowTextarea
                bare
                ref={(el) => { fieldRef.current = el; }}
                className={fieldClass}
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={onBlur}
            />
        ) : (
            <input
                ref={(el) => { fieldRef.current = el; }}
                className={fieldClass}
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={onBlur}
            />
        );
    }

    return (
        <div className={`table-card-inline ${disabled ? 'table-card-inline-disabled' : ''} ${className}`}>
            <span
                className={value.trim() ? 'table-card-inline-text' : 'table-card-inline-text font-color-secondary'}
                onClick={start}
            >
                {value.trim() || placeholder}
            </span>
            {!disabled && (
                <button
                    type="button"
                    className="table-card-inline-edit"
                    aria-label={editLabel}
                    title={editLabel}
                    onClick={start}
                >
                    <Icon icon={EditIcon} />
                </button>
            )}
        </div>
    );
};

export default InlineEditableText;
