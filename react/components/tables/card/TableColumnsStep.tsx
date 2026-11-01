import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { DraftColumn, DraftOption } from '@beaver/agent-core/run-state/tableCardDraft';
import {
    columnProblem,
    insertOptions,
    newOptionKey,
    pasteIntoOption,
} from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { ArrowDownIcon, CancelIcon, DeleteIcon, Icon, PlusSignIcon } from '../../icons/icons';
import { COLUMN_TYPES, ColumnOptionChips, ColumnTypeTag, columnTypeOf } from '../columnTypes';
import AutoGrowTextarea from './AutoGrowTextarea';

export interface TableColumnsStepProps {
    columns: DraftColumn[];
    disabled: boolean;
    onAdd: () => void;
    onUpdate: (key: string, patch: Partial<Omit<DraftColumn, 'key'>>) => void;
    onRemove: (key: string) => void;
}

/**
 * Enter in a single-line field never decides the card; it only stays in the
 * field. An Enter that confirms an IME candidate is left to the IME.
 */
const keepEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.stopPropagation();
    if (!isImeKeyEvent(e.nativeEvent)) e.preventDefault();
};

/** Where a focus asked for by an edit lands once the rows have re-rendered. */
interface OptionFocus {
    key: string;
    field: 'label' | 'definition';
}

/**
 * A category column's options as one list, a row each: the label and, under it
 * in quieter text, what counts as the category. A row's "Define" and remove
 * controls show on hover or focus and take no room, so nothing moves. Entry stays fast: Enter in a label adds a row
 * below it, Backspace in an empty label removes the row, and pasting several
 * lines into a label adds a row per line. A column without options still shows
 * one empty row; typing into it makes it the first option under the same key,
 * so the focus stays. The forwarded ref is the last row's label.
 */
const OptionsEditor = React.forwardRef<HTMLInputElement, {
    options: DraftOption[];
    columnIndex: number;
    disabled: boolean;
    onChange: (options: DraftOption[]) => void;
}>(function OptionsEditor({ options, columnIndex, disabled, onChange }, ref) {
    // The empty row's key, replaced once typing has made it an option.
    const placeholder = useRef<string | null>(null);
    if (!placeholder.current || options.some((option) => option.key === placeholder.current))
        placeholder.current = newOptionKey();
    const rows = options.length ? options : [{ key: placeholder.current, label: '', description: '' }];
    const labels = useRef(new Map<string, HTMLInputElement>());
    const definitions = useRef(new Map<string, HTMLTextAreaElement>());
    // Definition fields opened (or cleared) in this editor session; a defined
    // option always shows its field.
    const [defining, setDefining] = useState<ReadonlySet<string>>(() => new Set());
    const pendingFocus = useRef<OptionFocus | null>(null);

    useLayoutEffect(() => {
        const next = pendingFocus.current;
        if (!next) return;
        pendingFocus.current = null;
        focusAtEnd((next.field === 'label' ? labels.current : definitions.current).get(next.key) ?? null);
    });

    const change = (next: DraftOption[], focus?: OptionFocus) => {
        if (focus) pendingFocus.current = focus;
        onChange(next);
    };
    const update = (key: string, patch: Partial<Omit<DraftOption, 'key'>>) =>
        change(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    const setDefiningKey = (key: string, open: boolean) =>
        setDefining((current) => {
            if (current.has(key) === open) return current;
            const next = new Set(current);
            if (open) next.add(key);
            else next.delete(key);
            return next;
        });
    const remove = (key: string, focusNeighbour: boolean) => {
        const index = rows.findIndex((row) => row.key === key);
        const remaining = rows.filter((row) => row.key !== key);
        const neighbour = remaining[Math.max(0, index - 1)];
        change(remaining, focusNeighbour && neighbour ? { key: neighbour.key, field: 'label' } : undefined);
    };
    const addAfter = (index: number) => {
        const inserted = insertOptions(rows, index + 1, ['']);
        change(inserted.options, { key: inserted.keys[0], field: 'label' });
    };
    const optionName = (row: DraftOption, index: number) => row.label.trim() || `option ${index + 1}`;

    return (
        <div className="display-flex flex-col items-start gap-1 min-w-0">
            <div className="table-card-option-list" role="list">
            {rows.map((row, index) => {
                const showDefinition = !!row.description || defining.has(row.key);
                return (
                    <div key={row.key} className="table-card-option-row" role="listitem">
                        <div className="table-card-option-line">
                            <input
                                ref={(el) => {
                                    if (el) labels.current.set(row.key, el);
                                    else labels.current.delete(row.key);
                                    if (index === rows.length - 1) {
                                        if (typeof ref === 'function') ref(el);
                                        else if (ref) ref.current = el;
                                    }
                                }}
                                className="table-card-option-label"
                                value={row.label}
                                placeholder={index === 0 ? 'e.g. RCT' : 'Option'}
                                aria-label={`Column ${columnIndex + 1} option ${index + 1}`}
                                disabled={disabled}
                                onChange={(e) => update(row.key, { label: e.target.value })}
                                onPaste={(e) => {
                                    const input = e.currentTarget;
                                    const end = input.value.length;
                                    const pasted = pasteIntoOption(
                                        rows,
                                        row.key,
                                        e.clipboardData?.getData('text/plain') ?? '',
                                        input.selectionStart ?? end,
                                        input.selectionEnd ?? end,
                                    );
                                    if (!pasted) return;
                                    e.preventDefault();
                                    change(pasted.options, { key: pasted.focusKey, field: 'label' });
                                }}
                                onKeyDown={(e) => {
                                    // Enter never reaches the card, even while an IME owns it.
                                    if (e.key === 'Enter') e.stopPropagation();
                                    if (isImeKeyEvent(e.nativeEvent)) return;
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addAfter(index);
                                    } else if (
                                        e.key === 'Backspace' &&
                                        row.label === '' &&
                                        !row.description.trim() &&
                                        rows.length > 1
                                    ) {
                                        e.preventDefault();
                                        remove(row.key, true);
                                    }
                                }}
                            />
                            {!showDefinition && (
                                <Button
                                    variant="ghost-secondary"
                                    className="table-card-option-action text-sm"
                                    style={{ padding: '0 5px' }}
                                    disabled={disabled}
                                    ariaLabel={`Add a definition for ${optionName(row, index)}`}
                                    title="Say what counts as this category"
                                    onClick={() => {
                                        pendingFocus.current = { key: row.key, field: 'definition' };
                                        setDefiningKey(row.key, true);
                                    }}
                                >
                                    Define
                                </Button>
                            )}
                            <IconButton
                                icon={CancelIcon}
                                variant="ghost-secondary"
                                className="table-card-option-action"
                                disabled={disabled}
                                ariaLabel={`Remove ${optionName(row, index)}`}
                                onClick={() => remove(row.key, false)}
                            />
                        </div>
                        {showDefinition && (
                            <AutoGrowTextarea
                                bare
                                ref={(el) => {
                                    if (el) definitions.current.set(row.key, el);
                                    else definitions.current.delete(row.key);
                                }}
                                className="table-card-option-definition"
                                value={row.description}
                                placeholder="What counts as this category?"
                                aria-label={`Definition of ${optionName(row, index)}`}
                                disabled={disabled}
                                onChange={(e) => update(row.key, { description: e.target.value })}
                                // Clearing a definition to retype it must keep the field mounted.
                                // An empty field is not collapsed on blur either: the blur comes
                                // at mousedown, and a collapse then would move the control being
                                // clicked. It closes with Backspace, or when the editor closes.
                                onFocus={() => setDefiningKey(row.key, true)}
                                onKeyDown={(e) => {
                                    if (isImeKeyEvent(e.nativeEvent)) return;
                                    // Backspace in an empty definition closes it, back to the label.
                                    if (e.key === 'Backspace' && row.description === '') {
                                        e.preventDefault();
                                        pendingFocus.current = { key: row.key, field: 'label' };
                                        setDefiningKey(row.key, false);
                                    }
                                }}
                            />
                        )}
                    </div>
                );
            })}
            </div>
            <Button
                variant="ghost-secondary"
                icon={PlusSignIcon}
                className="text-sm"
                style={{ marginLeft: '-6px', padding: '1px 6px' }}
                disabled={disabled}
                onClick={() => addAfter(rows.length - 1)}
            >
                Add option
            </Button>
        </div>
    );
});

interface ColumnCardProps {
    column: DraftColumn;
    index: number;
    disabled: boolean;
    editing: boolean;
    /** The field the editor focuses when it opens. */
    focusField: ColumnField;
    /**
     * Counts requests to open this editor. A request for an editor that is
     * already open (the footer's "Show") still moves the focus to its field.
     */
    focusRequest: number;
    onEdit: (field: ColumnField) => void;
    onClose: () => void;
    onUpdate: (patch: Partial<Omit<DraftColumn, 'key'>>) => void;
    onRemove: () => void;
}

/** The editor's text fields, in order. */
type ColumnField = 'header' | 'question' | 'options';

/** The field a click on the collapsed card points at: the part of the summary it hit. */
function fieldAt(target: EventTarget | null, column: DraftColumn): ColumnField {
    const el = target instanceof Element ? target : null;
    if (el?.closest('.table-card-column-question')) return 'question';
    if (el?.closest('.table-card-options') && column.type === 'select') return 'options';
    return 'header';
}

/** Focus a field with the caret after its text, where an edit usually continues. */
function focusAtEnd(field: HTMLInputElement | HTMLTextAreaElement | null): void {
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
}

/**
 * One question column. At rest it reads as a summary (header, type, the
 * question clamped to two lines, a category's options); clicking it opens the
 * editor in place, focused on the part that was clicked. A click outside the
 * card, Escape, or Done closes it again. Removing a column is an action of
 * the editor, so the summary keeps its type tag at the right edge.
 */
const ColumnCard: React.FC<ColumnCardProps> = ({
    column,
    index,
    disabled,
    editing,
    focusField,
    focusRequest,
    onEdit,
    onClose,
    onUpdate,
    onRemove,
}) => {
    const cardRef = useRef<HTMLDivElement | null>(null);
    const headerRef = useRef<HTMLInputElement | null>(null);
    const questionRef = useRef<HTMLTextAreaElement | null>(null);
    const optionsRef = useRef<HTMLInputElement | null>(null);
    const problem = columnProblem(column);
    const name = column.header.trim() || `Column ${index + 1}`;

    useLayoutEffect(() => {
        if (!editing) return;
        const fields = { header: headerRef.current, question: questionRef.current, options: optionsRef.current };
        focusAtEnd(fields[focusField] ?? headerRef.current);
        // The editor is taller than the summary, and a column added from the
        // step heading opens at the end of the list: bring all of it into view.
        cardRef.current?.scrollIntoView?.({ block: 'nearest' });
        // Only on opening, or on a new request to open: otherwise the focus
        // is the user's.
    }, [editing, focusRequest]);

    // A click outside the card closes the editor. It closes on the completed
    // click, not on the press: collapsing shifts everything below the card,
    // and a collapse at mousedown would move the pressed control (Create, Add
    // column, the next column) out from under the pointer before its click.
    // The press must also start outside, so a text selection dragged out of a
    // field keeps the editor open. The type menu renders inside the card, so
    // choosing a type keeps it open too.
    useEffect(() => {
        if (!editing || !cardRef.current) return;
        const card = cardRef.current;
        const doc = card.ownerDocument;
        const outside = (event: Event) => {
            const target = event.target as Node | null;
            return !!target && !card.contains(target);
        };
        let pressedOutside = false;
        const onMouseDown = (event: Event) => {
            pressedOutside = outside(event);
        };
        const onClick = (event: Event) => {
            if (pressedOutside && outside(event)) onClose();
            pressedOutside = false;
        };
        doc.addEventListener('mousedown', onMouseDown, true);
        doc.addEventListener('click', onClick, true);
        return () => {
            doc.removeEventListener('mousedown', onMouseDown, true);
            doc.removeEventListener('click', onClick, true);
        };
    }, [editing, onClose]);

    if (!editing) {
        const options = column.options
            .map((option) => ({ label: option.label.trim(), description: option.description.trim() }))
            .filter((option) => option.label);
        return (
            <div
                ref={cardRef}
                className={`table-card-column ${disabled ? 'table-card-column-disabled' : ''}`}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-label={`Edit column ${name}`}
                aria-disabled={disabled || undefined}
                onClick={(e) => !disabled && onEdit(fieldAt(e.target, column))}
                onKeyDown={(e) => {
                    if (disabled || e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onEdit('header');
                    }
                }}
            >
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <span
                        className={`flex-1 min-w-0 truncate font-medium ${column.header.trim() ? 'font-color-primary' : 'font-color-secondary'}`}
                    >
                        {column.header.trim() || 'Untitled column'}
                    </span>
                    {problem && <span className="table-card-badge-warning flex-none">Incomplete</span>}
                    <span className="flex-none">
                        <ColumnTypeTag type={column.type} />
                    </span>
                </div>
                <div
                    className={`table-card-column-question text-sm ${column.description.trim() ? 'font-color-secondary' : 'font-color-secondary table-card-empty'}`}
                >
                    {column.description.trim() || 'No question yet'}
                </div>
                {column.type === 'select' && options.length > 0 && <ColumnOptionChips options={options} />}
            </div>
        );
    }

    const typeItems: MenuItem[] = COLUMN_TYPES.map((type) => ({
        label: type.label,
        icon: type.icon,
        onClick: () => onUpdate({ type: type.value }),
    }));
    const type = columnTypeOf(column.type);

    return (
        <div
            ref={cardRef}
            className="table-card-column table-card-column-editing"
            role="group"
            aria-label={`Column ${index + 1}`}
            onKeyDown={(e) => {
                // Escape inside a field may be cancelling an IME candidate.
                if (e.key === 'Escape' && !isImeKeyEvent(e.nativeEvent)) {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="display-flex flex-row items-start gap-3 min-w-0">
                <label className="table-card-label flex-1 min-w-0">
                    <span>Name</span>
                    <input
                        ref={headerRef}
                        className="table-card-field font-medium"
                        value={column.header}
                        placeholder="e.g. Sample size"
                        aria-label={`Column ${index + 1} name`}
                        disabled={disabled}
                        onKeyDown={keepEnter}
                        onChange={(e) => onUpdate({ header: e.target.value })}
                    />
                </label>
                {/* Not a <label>: the menu renders inside this wrapper, and a label
                    forwards clicks on its items to the button, reopening the menu. */}
                <div className="table-card-label flex-none">
                    <span>Type</span>
                    <MenuButton
                        menuItems={typeItems}
                        customContent={
                            <span className="display-flex flex-row items-center gap-15">
                                <Icon icon={type.icon} />
                                <span>{type.label}</span>
                                <Icon icon={ArrowDownIcon} className="font-color-secondary" />
                            </span>
                        }
                        variant="outline"
                        className="text-sm"
                        style={{ padding: '3px 6px', lineHeight: 1.35 }}
                        ariaLabel={`Column ${index + 1} type`}
                        disabled={disabled}
                    />
                </div>
            </div>
            <label className="table-card-label">
                <span>Question</span>
                <AutoGrowTextarea
                    bare
                    ref={questionRef}
                    className="table-card-field text-sm"
                    value={column.description}
                    placeholder="The question asked of every item"
                    aria-label={`Column ${index + 1} question`}
                    disabled={disabled}
                    onChange={(e) => onUpdate({ description: e.target.value })}
                />
            </label>
            {column.type === 'select' && (
                // Not a <label>: it holds several fields and buttons.
                <div className="table-card-label" role="group" aria-label={`Column ${index + 1} options`}>
                    <span>Options</span>
                    <OptionsEditor
                        ref={optionsRef}
                        options={column.options}
                        columnIndex={index}
                        disabled={disabled}
                        onChange={(options) => onUpdate({ options })}
                    />
                </div>
            )}
            {problem && (column.header || column.description) && (
                <div className="text-sm table-card-problem">{problem}</div>
            )}
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <Button
                    variant="ghost-secondary"
                    icon={DeleteIcon}
                    onClick={onRemove}
                    disabled={disabled}
                    ariaLabel={`Remove column ${name}`}
                    style={{ marginLeft: '-6px' }}
                >
                    Remove
                </Button>
                <div className="flex-1" />
                <Button variant="outline" onClick={onClose} style={{ padding: '2px 8px' }}>
                    Done
                </Button>
            </div>
        </div>
    );
};

/** What the card reaches the list through: the heading's "Add column", the blocker's "Show". */
export interface TableColumnsStepHandle {
    /** Add an empty column and open it for editing. */
    add: () => void;
    /** Open the first column that is not complete, on the field it needs. */
    openFirstIncomplete: () => void;
}

/**
 * The Columns step: the proposed questions as summary cards, one open for
 * editing at a time, with remove; "Add column" lives in the step heading and
 * reaches the list through {@link TableColumnsStepHandle}. A column has no
 * basis of its own: the filler reads the paper when there is one.
 */
export const TableColumnsStep = React.forwardRef<TableColumnsStepHandle, TableColumnsStepProps>(function TableColumnsStep({
    columns,
    disabled,
    onAdd,
    onUpdate,
    onRemove,
}, ref) {
    // `request` counts every request to open a column, so asking for the
    // column that is already open still focuses the field asked for.
    const [editing, setEditingState] = useState<{ key: string; field: ColumnField; request: number } | null>(null);
    const requests = useRef(0);
    const setEditing = React.useCallback((next: { key: string; field: ColumnField } | null) => {
        setEditingState(next ? { ...next, request: ++requests.current } : null);
    }, []);
    const knownKeys = useRef(new Set(columns.map((column) => column.key)));
    const addRequested = useRef(false);

    // A column added from "Add column" opens with its name focused.
    useEffect(() => {
        const added = columns.find((column) => !knownKeys.current.has(column.key));
        for (const column of columns) knownKeys.current.add(column.key);
        if (added && addRequested.current) {
            addRequested.current = false;
            setEditing({ key: added.key, field: 'header' });
        }
    }, [columns]);

    useEffect(() => {
        if (disabled) setEditing(null);
    }, [disabled]);

    const close = React.useCallback(() => setEditing(null), []);

    useImperativeHandle(ref, () => ({
        add: () => {
            addRequested.current = true;
            onAdd();
        },
        openFirstIncomplete: () => {
            const column = columns.find((c) => columnProblem(c));
            if (!column) return;
            // Open it on the field that needs the fix.
            const field: ColumnField = !column.header.trim() ? 'header' : !column.description.trim() ? 'question' : 'options';
            setEditing({ key: column.key, field });
        },
    }), [columns, onAdd]);

    return (
        <div className="display-flex flex-col min-w-0" style={{ gap: '0.45rem' }}>
            {columns.length === 0 && (
                <div className="text-sm font-color-secondary">
                    No columns yet. Use Add column to ask a question of every item.
                </div>
            )}
            {columns.map((column, index) => (
                <ColumnCard
                    key={column.key}
                    column={column}
                    index={index}
                    disabled={disabled}
                    editing={editing?.key === column.key}
                    focusField={editing?.key === column.key ? editing.field : 'header'}
                    focusRequest={editing?.key === column.key ? editing.request : 0}
                    onEdit={(field) => setEditing({ key: column.key, field })}
                    onClose={close}
                    onUpdate={(patch) => onUpdate(column.key, patch)}
                    onRemove={() => {
                        if (editing?.key === column.key) close();
                        onRemove(column.key);
                    }}
                />
            ))}
        </div>
    );
});

export default TableColumnsStep;
