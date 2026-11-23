import React, { useLayoutEffect, useRef, useState } from 'react';
import type { DraftColumn, DraftOption } from '@beaver/agent-core/run-state/tableCardDraft';
import { insertOptions, newOptionKey, pasteIntoOption } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { ArrowDownIcon, CancelIcon, Icon, PlusSignIcon } from '../icons/icons';
import { COLUMN_TYPES, columnTypeOf } from './columnTypes';
import AutoGrowTextarea from './card/AutoGrowTextarea';

/**
 * The column editor's fields, shared by the create card's Columns step and
 * the table tab's column editor: the name, the type, the question, and a
 * category column's options with their definitions.
 */

/**
 * Enter in a single-line field never decides the card; it only stays in the
 * field. An Enter that confirms an IME candidate is left to the IME.
 */
export const keepEnter = (e: React.KeyboardEvent) => {
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
export const OptionsEditor = React.forwardRef<HTMLInputElement, {
    options: DraftOption[];
    /** Prefixes each field's accessible name ("Column 2 option 1"). */
    label: string;
    disabled: boolean;
    onChange: (options: DraftOption[]) => void;
}>(function OptionsEditor({ options, label, disabled, onChange }, ref) {
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
                                aria-label={`${label} option ${index + 1}`}
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


/** Focus a field with the caret after its text, where an edit usually continues. */
export function focusAtEnd(field: HTMLInputElement | HTMLTextAreaElement | null): void {
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
}

/** The fields' elements, for focusing the one an editor opens on. */
export interface ColumnFieldRefs {
    header: React.Ref<HTMLInputElement>;
    question: React.Ref<HTMLTextAreaElement>;
    options: React.Ref<HTMLInputElement>;
}

/**
 * Name and type on one line, the question under them, and a category
 * column's options. `label` prefixes each field's accessible name
 * ("Column 2 name"). The type is a menu in the card and a segmented control
 * in the tab's editor, where there is room for it.
 */
export function ColumnFields({
    column,
    label,
    disabled,
    typeControl = 'menu',
    refs,
    onUpdate,
}: {
    column: DraftColumn;
    label: string;
    disabled: boolean;
    typeControl?: 'menu' | 'segmented';
    refs?: Partial<ColumnFieldRefs>;
    onUpdate: (patch: Partial<Omit<DraftColumn, 'key'>>) => void;
}): React.ReactElement {
    const type = columnTypeOf(column.type);
    const typeItems: MenuItem[] = COLUMN_TYPES.map((entry) => ({
        label: entry.label,
        icon: entry.icon,
        onClick: () => onUpdate({ type: entry.value }),
    }));
    const nameField = (
        <label className="table-card-label flex-1 min-w-0">
            <span>Name</span>
            <input
                ref={refs?.header}
                className="table-card-field font-medium"
                value={column.header}
                placeholder="e.g. Sample size"
                aria-label={`${label} name`}
                disabled={disabled}
                onKeyDown={keepEnter}
                onChange={(e) => onUpdate({ header: e.target.value })}
            />
        </label>
    );
    return (
        <>
            {typeControl === 'menu' ? (
                <div className="display-flex flex-row items-start gap-3 min-w-0">
                    {nameField}
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
                            ariaLabel={`${label} type`}
                            disabled={disabled}
                        />
                    </div>
                </div>
            ) : (
                <>
                    {nameField}
                    <div className="table-card-label" role="group" aria-label={`${label} type`}>
                        <span>Type</span>
                        <div className="column-type-segments">
                            {COLUMN_TYPES.map((entry) => (
                                <button
                                    key={entry.value}
                                    type="button"
                                    aria-pressed={column.type === entry.value}
                                    className={column.type === entry.value ? 'column-type-segment-on' : undefined}
                                    disabled={disabled}
                                    onClick={() => onUpdate({ type: entry.value })}
                                >
                                    <Icon icon={entry.icon} />
                                    <span>{entry.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}
            <label className="table-card-label">
                <span>Question</span>
                <AutoGrowTextarea
                    bare
                    ref={refs?.question}
                    className="table-card-field text-sm"
                    value={column.description}
                    placeholder="The question asked of every item"
                    aria-label={`${label} question`}
                    disabled={disabled}
                    onChange={(e) => onUpdate({ description: e.target.value })}
                />
            </label>
            {column.type === 'select' && (
                // Not a <label>: it holds several fields and buttons.
                <div className="table-card-label" role="group" aria-label={`${label} options`}>
                    <span>Options</span>
                    <OptionsEditor
                        ref={refs?.options}
                        options={column.options}
                        label={label}
                        disabled={disabled}
                        onChange={(options) => onUpdate({ options })}
                    />
                </div>
            )}
        </>
    );
}
