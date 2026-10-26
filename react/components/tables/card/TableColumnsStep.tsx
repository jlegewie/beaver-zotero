import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { TableCardColumnType } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { DraftColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import { columnProblem } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import {
    ArrowDownIcon,
    CalendarIcon,
    CheckmarkCircleIcon,
    DeleteIcon,
    HashtagIcon,
    Icon,
    ListBulletIcon,
    TextIcon,
} from '../../icons/icons';
import AutoGrowTextarea from './AutoGrowTextarea';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/** Column types in menu order, with the names the table view uses. */
const TYPES: { value: TableCardColumnType; label: string; icon: IconComponent }[] = [
    { value: 'text', label: 'Text', icon: TextIcon },
    { value: 'number', label: 'Number', icon: HashtagIcon },
    { value: 'date', label: 'Date', icon: CalendarIcon },
    { value: 'boolean', label: 'Yes / no', icon: CheckmarkCircleIcon },
    { value: 'select', label: 'Category', icon: ListBulletIcon },
];

const typeOf = (type: TableCardColumnType) => TYPES.find((entry) => entry.value === type) ?? TYPES[0];

/** Options a collapsed category column shows before "+N". */
const PREVIEW_OPTIONS = 4;

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

/**
 * The options of a category column, one per line: an option may itself contain
 * a comma ("Before, after"). The text is kept as typed, so a line can be
 * emptied while editing; the options are parsed from it.
 */
const OptionsInput = React.forwardRef<HTMLTextAreaElement, {
    options: string[];
    label: string;
    disabled: boolean;
    onChange: (options: string[]) => void;
}>(function OptionsInput({ options, label, disabled, onChange }, ref) {
    const [text, setText] = useState(() => options.join('\n'));
    return (
        <AutoGrowTextarea
            bare
            ref={ref}
            className="table-card-field text-sm min-w-0"
            value={text}
            placeholder="One option per line"
            aria-label={label}
            disabled={disabled}
            onChange={(e) => {
                setText(e.target.value);
                onChange(e.target.value.split('\n').map((option) => option.trim()));
            }}
        />
    );
});

/** The column's type as a small tag: its icon and name, the same width for every column of a type. */
const TypeTag: React.FC<{ column: DraftColumn }> = ({ column }) => {
    const type = typeOf(column.type);
    return (
        <span className="table-card-type-tag">
            <Icon icon={type.icon} />
            <span className="table-card-type-tag-label">{type.label}</span>
        </span>
    );
};

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
    const optionsRef = useRef<HTMLTextAreaElement | null>(null);
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
        const options = column.options.map((option) => option.trim()).filter(Boolean);
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
                        <TypeTag column={column} />
                    </span>
                </div>
                <div
                    className={`table-card-column-question text-sm ${column.description.trim() ? 'font-color-secondary' : 'font-color-secondary table-card-empty'}`}
                >
                    {column.description.trim() || 'No question yet'}
                </div>
                {column.type === 'select' && options.length > 0 && (
                    <div className="table-card-options" aria-label="Options">
                        {options.slice(0, PREVIEW_OPTIONS).map((option, i) => (
                            <span key={`${option}-${i}`} className="table-card-option">
                                {option}
                            </span>
                        ))}
                        {options.length > PREVIEW_OPTIONS && (
                            <span className="text-sm font-color-secondary flex-none">
                                {`+${options.length - PREVIEW_OPTIONS}`}
                            </span>
                        )}
                    </div>
                )}
            </div>
        );
    }

    const typeItems: MenuItem[] = TYPES.map((type) => ({
        label: type.label,
        icon: type.icon,
        onClick: () => onUpdate({ type: type.value }),
    }));
    const type = typeOf(column.type);

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
            {column.type === 'number' && (
                <label className="table-card-label">
                    <span>Unit (optional)</span>
                    <input
                        className="table-card-field text-sm"
                        value={column.unit ?? ''}
                        placeholder="e.g. participants, USD, %"
                        aria-label={`Column ${index + 1} unit`}
                        disabled={disabled}
                        onKeyDown={keepEnter}
                        onChange={(e) => onUpdate({ unit: e.target.value })}
                    />
                </label>
            )}
            {column.type === 'select' && (
                <label className="table-card-label">
                    <span>Options, one per line</span>
                    <OptionsInput
                        ref={optionsRef}
                        options={column.options}
                        label={`Column ${index + 1} options`}
                        disabled={disabled}
                        onChange={(options) => onUpdate({ options })}
                    />
                </label>
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
