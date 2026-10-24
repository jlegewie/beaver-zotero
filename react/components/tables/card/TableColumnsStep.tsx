import React, { useState } from 'react';
import type { TableCardColumnType } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { DraftColumn } from '@beaver/agent-core/run-state/tableCardDraft';
import { columnProblem } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { CancelIcon, PlusSignIcon } from '../../icons/icons';
import AutoGrowTextarea from './AutoGrowTextarea';

const TYPES: { value: TableCardColumnType; label: string }[] = [
    { value: 'text', label: 'Text' },
    { value: 'number', label: 'Number' },
    { value: 'boolean', label: 'Yes / no' },
    { value: 'select', label: 'Choice' },
    { value: 'date', label: 'Date' },
];

export interface TableColumnsStepProps {
    columns: DraftColumn[];
    disabled: boolean;
    onAdd: () => void;
    onUpdate: (key: string, patch: Partial<Omit<DraftColumn, 'key'>>) => void;
    onRemove: (key: string) => void;
}

/** Enter in a single-line field never decides the card; it only stays in the field. */
const keepEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
    }
};

/**
 * The options of a choice column, one per line: an option may itself contain a
 * comma ("Before, after"). The text is kept as typed, so a line can be emptied
 * while editing; the options are parsed from it.
 */
const OptionsInput: React.FC<{
    options: string[];
    label: string;
    disabled: boolean;
    onChange: (options: string[]) => void;
}> = ({ options, label, disabled, onChange }) => {
    const [text, setText] = useState(() => options.join('\n'));
    return (
        <AutoGrowTextarea
            className="min-w-0"
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
};

/**
 * The Columns step: the proposed questions as editable rows (header, type,
 * question, options for a choice column), with add and remove. A column has no
 * basis of its own: the filler reads the paper when there is one.
 */
export const TableColumnsStep: React.FC<TableColumnsStepProps> = ({
    columns,
    disabled,
    onAdd,
    onUpdate,
    onRemove,
}) => (
    <div className="display-flex flex-col min-w-0" style={{ gap: '0.5rem' }}>
        {columns.length === 0 && (
            <div className="text-sm font-color-secondary">
                No questions yet. Add the questions the table asks of every paper.
            </div>
        )}
        {columns.map((column, index) => {
            const problem = columnProblem(column);
            return (
                <div
                    key={column.key}
                    className="display-flex flex-col min-w-0 rounded-md"
                    style={{ border: '1px solid var(--fill-quinary)', padding: '0.45rem 0.55rem', gap: '0.35rem' }}
                    role="group"
                    aria-label={`Column ${index + 1}`}
                >
                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                        <input
                            className="preference-input py-1 px-2 text-sm flex-1 min-w-0 font-medium"
                            value={column.header}
                            placeholder="Header"
                            aria-label={`Column ${index + 1} header`}
                            disabled={disabled}
                            onKeyDown={keepEnter}
                            onChange={(e) => onUpdate(column.key, { header: e.target.value })}
                        />
                        <select
                            className="preference-input py-1 px-2 text-sm flex-none"
                            value={column.type}
                            aria-label={`Column ${index + 1} type`}
                            disabled={disabled}
                            onChange={(e) => onUpdate(column.key, { type: e.target.value as TableCardColumnType })}
                        >
                            {TYPES.map((type) => (
                                <option key={type.value} value={type.value}>
                                    {type.label}
                                </option>
                            ))}
                        </select>
                        <IconButton
                            icon={CancelIcon}
                            variant="ghost-secondary"
                            onClick={() => onRemove(column.key)}
                            ariaLabel={`Remove column ${column.header || index + 1}`}
                            disabled={disabled}
                            className="flex-none"
                        />
                    </div>
                    <AutoGrowTextarea
                        value={column.description}
                        placeholder="The question asked of every paper"
                        aria-label={`Column ${index + 1} question`}
                        disabled={disabled}
                        onChange={(e) => onUpdate(column.key, { description: e.target.value })}
                    />
                    {column.type === 'select' && (
                        <OptionsInput
                            options={column.options}
                            label={`Column ${index + 1} options`}
                            disabled={disabled}
                            onChange={(options) => onUpdate(column.key, { options })}
                        />
                    )}
                    {problem && (column.header || column.description) && (
                        <div className="text-sm font-color-tertiary">{problem}</div>
                    )}
                </div>
            );
        })}
        <Button
            variant="ghost"
            icon={PlusSignIcon}
            onClick={onAdd}
            disabled={disabled || columns.length >= 30}
            style={{ alignSelf: 'flex-start', marginLeft: '-6px' }}
        >
            Column
        </Button>
    </div>
);

export default TableColumnsStep;
