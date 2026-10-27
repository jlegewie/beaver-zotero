import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { CancelIcon, EditIcon, Icon, TickIcon } from '../../icons/icons';
import AutoGrowTextarea from './AutoGrowTextarea';

export interface InlineEditableTextProps {
    value: string;
    /** Called with the confirmed text; a discarded edit never calls it. */
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
    /** Told when editing starts and ends, for a layout that makes room for the field. */
    onEditingChange?: (editing: boolean) => void;
}

/** Starts editing from outside, as the card's "Add a title" notice does. */
export interface InlineEditableTextHandle {
    edit: () => void;
}

/**
 * Text that reads as text, with a quiet pencil at its end. Clicking the text or
 * the pencil swaps in a field with the same typography and confirm / discard
 * buttons, as renaming a thread does. The edit is held locally: Enter or the
 * check applies it; Escape, the cross or a click outside discards it. Both keys
 * are left to an IME while it composes, and Enter never reaches a host
 * shortcut, so it cannot decide the card.
 */
export const InlineEditableText = forwardRef<InlineEditableTextHandle, InlineEditableTextProps>(function InlineEditableText({
    value,
    onChange,
    placeholder,
    ariaLabel,
    editLabel,
    multiline = false,
    disabled = false,
    className = '',
    onEditingChange,
}, ref) {
    const [text, setText] = useState<string | null>(null);
    const editing = text !== null && !disabled;
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

    const reportEditing = useRef(onEditingChange);
    reportEditing.current = onEditingChange;
    useLayoutEffect(() => {
        reportEditing.current?.(editing);
    }, [editing]);

    useLayoutEffect(() => {
        if (!editing || !fieldRef.current) return;
        const field = fieldRef.current;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }, [editing]);

    const start = () => {
        if (!disabled) setText(value);
    };
    useImperativeHandle(ref, () => ({ edit: start }));
    const discard = () => setText(null);
    const confirm = () => {
        if (text !== null && text !== value) onChange(text);
        setText(null);
    };

    // A click outside discards the edit. It acts on the completed click, not
    // the press, so nothing moves under the pointer before the click lands
    // (a wrapped title is taller than its one-line field), and only for a
    // press that also started outside, so a selection dragged out of the field
    // keeps it.
    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!editing || !wrapper) return;
        const doc = wrapper.ownerDocument;
        const outside = (event: Event) => {
            const target = event.target as Node | null;
            return !!target && !wrapper.contains(target);
        };
        let pressedOutside = false;
        const onMouseDown = (event: Event) => {
            pressedOutside = outside(event);
        };
        const onClick = (event: Event) => {
            if (pressedOutside && outside(event)) setText(null);
            pressedOutside = false;
        };
        doc.addEventListener('mousedown', onMouseDown, true);
        doc.addEventListener('click', onClick, true);
        return () => {
            doc.removeEventListener('mousedown', onMouseDown, true);
            doc.removeEventListener('click', onClick, true);
        };
    }, [editing]);

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
            confirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            discard();
        }
    };

    if (editing) {
        const fieldClass = `table-card-inline-field ${className}`;
        return (
            <div ref={wrapperRef} className="table-card-inline-editing">
                {multiline ? (
                    <AutoGrowTextarea
                        bare
                        ref={(el) => { fieldRef.current = el; }}
                        className={fieldClass}
                        value={text}
                        placeholder={placeholder}
                        aria-label={ariaLabel}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onKeyDown}
                    />
                ) : (
                    <input
                        ref={(el) => { fieldRef.current = el; }}
                        className={fieldClass}
                        value={text}
                        placeholder={placeholder}
                        aria-label={ariaLabel}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onKeyDown}
                    />
                )}
                <div className="table-card-inline-actions">
                    <IconButton
                        icon={CancelIcon}
                        variant="ghost-secondary"
                        onClick={discard}
                        ariaLabel="Discard changes"
                    />
                    <IconButton
                        icon={TickIcon}
                        variant="ghost-secondary"
                        onClick={confirm}
                        ariaLabel="Save changes"
                        className="scale-12"
                    />
                </div>
            </div>
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
});

export default InlineEditableText;
