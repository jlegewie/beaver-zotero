import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditIcon, Icon } from "../../icons";
import { isImeKeyEvent } from "../../primitives/ime";

/**
 * Text edited in place: the table's title and description. At rest it reads
 * as the text itself; the pencil (or a click on the text) opens a field over
 * it. Enter or leaving the field saves, Escape cancels. A composing IME owns
 * Enter and Escape. A description field takes several lines, and Enter still
 * saves it (Shift+Enter breaks the line).
 */
export function InlineText({
    value,
    placeholder,
    label,
    className,
    as: Tag = "p",
    multiline = false,
    disabledReason,
    onSave,
}: {
    value: string;
    /** Shown when the value is empty and editing is possible. */
    placeholder: string;
    /** "Rename table", "Edit description": the pencil's label. */
    label: string;
    className: string;
    as?: "h1" | "p";
    multiline?: boolean;
    /** Why the text cannot be edited; shown on the disabled pencil. */
    disabledReason?: string;
    onSave(value: string): void;
}): React.ReactElement | null {
    const [draft, setDraft] = useState<string | null>(null);
    const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
    // Set once a field has saved or cancelled, so the blur its removal can
    // fire does not save again.
    const finished = useRef(false);
    const disabled = !!disabledReason;
    const open = () => {
        finished.current = false;
        setDraft(value);
    };

    useLayoutEffect(() => {
        const field = fieldRef.current;
        if (draft === null || !field || field.ownerDocument.activeElement === field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }, [draft]);

    if (draft !== null) {
        const finish = (save: boolean) => {
            if (finished.current) return;
            finished.current = true;
            const next = draft.trim();
            setDraft(null);
            if (save && next !== value.trim() && (next || multiline)) onSave(next);
        };
        const common = {
            ref: fieldRef,
            className: `${className} rt-inline-field`,
            value: draft,
            "aria-label": label,
            placeholder,
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
            onBlur: () => finish(true),
            onKeyDown: (event: React.KeyboardEvent) => {
                if (isImeKeyEvent(event.nativeEvent)) return;
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                } else if (event.key === "Enter" && !(multiline && event.shiftKey)) {
                    event.preventDefault();
                    finish(true);
                }
            },
        };
        return multiline ? <textarea rows={2} {...common} /> : <input type="text" {...common} />;
    }

    if (!value && disabled) return null;
    return (
        <div className={`rt-inline${disabled ? "" : " rt-inline-editable"}`}>
            <Tag
                className={`${className}${value ? "" : " rt-inline-placeholder"}`}
                onClick={disabled ? undefined : open}
            >
                {value || placeholder}
            </Tag>
            <button
                type="button"
                className="rt-icon-button rt-inline-pencil"
                aria-label={label}
                title={disabledReason ?? label}
                disabled={disabled}
                onClick={open}
            >
                <Icon icon={EditIcon} size={13} />
            </button>
        </div>
    );
}

/**
 * A popover under its anchor (the sources chip). It closes on a press
 * outside the anchor and the popover, and on Escape. It renders in place, not
 * through a portal: a portal into a chrome document's body breaks there.
 */
export function AnchoredPopover({
    anchor,
    open,
    label,
    className,
    onClose,
    children,
}: {
    anchor: React.ReactNode;
    open: boolean;
    label: string;
    className?: string;
    onClose(): void;
    children: React.ReactNode;
}): React.ReactElement {
    const rootRef = useRef<HTMLSpanElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const root = rootRef.current;
        if (!open || !root) return;
        const doc = root.ownerDocument;
        const onPress = (event: Event) => {
            const target = event.target as Node | null;
            // A press inside a menu the popover opened (portalled elsewhere)
            // is the popover's own.
            const inMenu = target instanceof Element && !!target.closest('[role="menu"], [role="listbox"]');
            if (target && !root.contains(target) && !inMenu) close.current();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !isImeKeyEvent(event)) {
                event.preventDefault();
                close.current();
            }
        };
        doc.addEventListener("mousedown", onPress, true);
        doc.addEventListener("keydown", onKey, true);
        return () => {
            doc.removeEventListener("mousedown", onPress, true);
            doc.removeEventListener("keydown", onKey, true);
        };
    }, [open]);
    return (
        <span ref={rootRef} className="rt-popover-anchor">
            {anchor}
            {open ? (
                <div role="dialog" aria-label={label} className={`rt-popover${className ? ` ${className}` : ""}`}>
                    {children}
                </div>
            ) : null}
        </span>
    );
}
