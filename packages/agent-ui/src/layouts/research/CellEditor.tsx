import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cell, CellValue, Column } from "@beaver/agent-core/layouts/table";
import { Icon, TickIcon } from "../../icons";
import Button from "../../primitives/Button";
import { isImeKeyEvent } from "../../primitives/ime";

/** What the user wrote into a cell: an answer, Not reported, or a cleared cell. */
export type CellEditInput =
    | { op: "answer"; value: CellValue; note?: string }
    | { op: "not_reported"; note?: string }
    | { op: "clear" };

/** The longest note the editor takes; the stored cell caps it in bytes. */
const NOTE_MAX = 300;

/** Whether a column's cells are edited as a list of choices rather than as text. */
export function editsAsList(column: Column): boolean {
    return column.type === "select" || column.type === "boolean";
}

/**
 * The editor that opens on a cell (section 5's user cells). A text or date
 * cell gets the answer, an optional note ("Why you changed it"), the promise
 * that fills won't change it, Cancel and Save; a Choice or Yes / no cell gets
 * its options, "Not reported" and "Clear cell", each saving at once.
 *
 * `onSave` resolves to an error message when the write is refused, and the
 * editor stays open with it.
 */
export function CellEditor({
    column,
    cell,
    onSave,
    onCancel,
}: {
    column: Column;
    cell: Cell | undefined;
    onSave(input: CellEditInput): Promise<string | null>;
    onCancel(): void;
}): React.ReactElement {
    return editsAsList(column) ? (
        <ChoiceEditor column={column} cell={cell} onSave={onSave} onCancel={onCancel} />
    ) : (
        <TextEditor column={column} cell={cell} onSave={onSave} onCancel={onCancel} />
    );
}

/** Calls `onPress` on a press outside the element. */
function useOutsidePress(ref: React.RefObject<HTMLElement>, onPress: () => void): void {
    const callback = useRef(onPress);
    callback.current = onPress;
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        const doc = root.ownerDocument;
        const handler = (event: Event) => {
            const target = event.target as Node | null;
            if (target && !root.contains(target)) callback.current();
        };
        doc.addEventListener("mousedown", handler, true);
        return () => doc.removeEventListener("mousedown", handler, true);
    }, [ref]);
}

function initialText(cell: Cell | undefined): string {
    const value = cell?.outcome === "answered" ? cell.value : undefined;
    if (!value) return "";
    if (value.kind === "text") return value.text;
    if (value.kind === "date") return value.value;
    return "";
}

function TextEditor({
    column,
    cell,
    onSave,
    onCancel,
}: {
    column: Column;
    cell: Cell | undefined;
    onSave(input: CellEditInput): Promise<string | null>;
    onCancel(): void;
}): React.ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const answerRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
    const initial = initialText(cell);
    const initialNote = cell?.provenance === "user" ? (cell.reasoning ?? "") : "";
    const [answer, setAnswer] = useState(initial);
    const [note, setNote] = useState(initialNote);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isDate = column.type === "date";
    const changed = answer !== initial || note !== initialNote;

    useLayoutEffect(() => {
        const field = answerRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }, []);

    // A press elsewhere closes an untouched editor; one with changes stays
    // until Save or Cancel, so nothing typed is lost by a stray click.
    useOutsidePress(rootRef, () => {
        if (!changed && !saving) onCancel();
    });

    const save = async (input: CellEditInput) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        const refused = await onSave(input);
        setSaving(false);
        if (refused) setError(refused);
    };
    const trimmed = answer.trim();
    const noteText = note.trim() || undefined;
    const submit = () => {
        if (!trimmed) return;
        void save({
            op: "answer",
            value: isDate ? { kind: "date", value: trimmed } : { kind: "text", text: trimmed },
            note: noteText,
        });
    };
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (isImeKeyEvent(event.nativeEvent)) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey || (isDate && event.target === answerRef.current))) {
            event.preventDefault();
            submit();
        }
    };

    return (
        <div
            ref={rootRef}
            className="rt-cell-editor"
            role="dialog"
            aria-label={`Edit ${column.header}`}
            onKeyDown={onKeyDown}
            onClick={(event) => event.stopPropagation()}
        >
            <label className="rt-cell-editor-field">
                <span className="rt-cell-editor-label">Answer</span>
                {isDate ? (
                    <input
                        ref={answerRef}
                        type="text"
                        className="rt-cell-editor-input"
                        value={answer}
                        placeholder="YYYY-MM-DD"
                        disabled={saving}
                        onChange={(event) => setAnswer(event.target.value)}
                    />
                ) : (
                    <textarea
                        ref={answerRef}
                        className="rt-cell-editor-input rt-cell-editor-answer"
                        rows={4}
                        value={answer}
                        disabled={saving}
                        onChange={(event) => setAnswer(event.target.value)}
                    />
                )}
            </label>
            <label className="rt-cell-editor-field">
                <span className="rt-cell-editor-label">Note</span>
                <input
                    type="text"
                    className="rt-cell-editor-input"
                    value={note}
                    maxLength={NOTE_MAX}
                    placeholder="Why you changed it (optional)"
                    disabled={saving}
                    onChange={(event) => setNote(event.target.value)}
                />
            </label>
            <p className="rt-cell-editor-hint">Fills won’t change your answer.</p>
            {error ? (
                <p className="rt-cell-editor-error" role="alert">
                    {error}
                </p>
            ) : null}
            <div className="rt-cell-editor-actions">
                <Button
                    variant="ghost-secondary"
                    disabled={saving}
                    title="The paper does not say"
                    onClick={() => void save({ op: "not_reported", note: noteText })}
                >
                    Not reported
                </Button>
                <span className="rt-spacer" />
                <Button variant="outline" disabled={saving} onClick={onCancel}>
                    Cancel
                </Button>
                <Button variant="solid" disabled={saving || !trimmed} loading={saving} onClick={submit}>
                    Save
                </Button>
            </div>
        </div>
    );
}

interface Choice {
    key: string;
    label: React.ReactNode;
    current: boolean;
    input: CellEditInput;
    muted?: boolean;
}

function choices(column: Column, cell: Cell | undefined): Choice[][] {
    const value = cell?.outcome === "answered" ? cell.value : undefined;
    const answers: Choice[] =
        column.type === "boolean"
            ? [true, false].map((flag) => ({
                  key: String(flag),
                  label: flag ? "Yes" : "No",
                  current: value?.kind === "boolean" && value.value === flag,
                  input: { op: "answer", value: { kind: "boolean", value: flag } },
              }))
            : (column.options ?? []).map((option) => ({
                  key: `option:${option.label}`,
                  label: <span className={`bt-pill bt-pill-${option.color ?? "gray"}`}>{option.label}</span>,
                  current: value?.kind === "select" && value.label === option.label,
                  input: { op: "answer", value: { kind: "select", label: option.label } },
              }));
    return [
        answers,
        [
            {
                key: "not_reported",
                label: "Not reported",
                current: cell?.outcome === "not_reported",
                input: { op: "not_reported" },
                muted: true,
            },
            {
                key: "clear",
                label: "Clear cell",
                current: cell?.outcome === "cleared",
                input: { op: "clear" },
                muted: true,
            },
        ],
    ];
}

function ChoiceEditor({
    column,
    cell,
    onSave,
    onCancel,
}: {
    column: Column;
    cell: Cell | undefined;
    onSave(input: CellEditInput): Promise<string | null>;
    onCancel(): void;
}): React.ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const groups = choices(column, cell);
    const flat = groups.flat();
    const [active, setActive] = useState(() => Math.max(0, flat.findIndex((choice) => choice.current)));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useLayoutEffect(() => {
        rootRef.current?.focus();
    }, []);
    useOutsidePress(rootRef, () => {
        if (!saving) onCancel();
    });

    const pick = async (choice: Choice) => {
        if (saving) return;
        // Picking what the user already chose changes nothing; picking
        // Beaver's own answer makes it the user's, so fills keep it.
        if (choice.current && cell?.provenance === "user") {
            onCancel();
            return;
        }
        setSaving(true);
        setError(null);
        const refused = await onSave(choice.input);
        setSaving(false);
        if (refused) setError(refused);
    };
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (isImeKeyEvent(event.nativeEvent)) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (index + step + flat.length) % flat.length);
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const choice = flat[active];
            if (choice) void pick(choice);
        }
    };

    let index = -1;
    return (
        <div
            ref={rootRef}
            className="rt-cell-editor rt-cell-choices"
            role="listbox"
            tabIndex={-1}
            aria-label={`Answer for ${column.header}`}
            aria-activedescendant={flat[active] ? `rt-choice-${active}` : undefined}
            aria-busy={saving}
            onKeyDown={onKeyDown}
            onClick={(event) => event.stopPropagation()}
        >
            {groups.map((group, groupIndex) => (
                <React.Fragment key={groupIndex}>
                    {groupIndex > 0 && group.length ? <div className="rt-cell-choices-divider" role="separator" /> : null}
                    {group.map((choice) => {
                        index += 1;
                        const at = index;
                        return (
                            <div
                                key={choice.key}
                                id={`rt-choice-${at}`}
                                role="option"
                                aria-selected={choice.current}
                                className={`rt-cell-choice${at === active ? " rt-active" : ""}${choice.muted ? " rt-cell-choice-muted" : ""}`}
                                onMouseEnter={() => setActive(at)}
                                onClick={() => void pick(choice)}
                            >
                                <span className="rt-cell-choice-label">{choice.label}</span>
                                {choice.current ? <Icon icon={TickIcon} size={11} className="rt-cell-choice-tick" /> : null}
                            </div>
                        );
                    })}
                </React.Fragment>
            ))}
            {error ? (
                <p className="rt-cell-editor-error" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
