import React from 'react';
import type { TableCardColumnType } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    CalendarIcon,
    CheckmarkCircleIcon,
    Icon,
    ListBulletIcon,
    TextIcon,
} from '../icons/icons';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/** Question column types in menu order, with the names the table view uses. */
export const COLUMN_TYPES: { value: TableCardColumnType; label: string; icon: IconComponent }[] = [
    { value: 'text', label: 'Text', icon: TextIcon },
    { value: 'date', label: 'Date', icon: CalendarIcon },
    { value: 'boolean', label: 'Yes / no', icon: CheckmarkCircleIcon },
    { value: 'select', label: 'Category', icon: ListBulletIcon },
];

/** The type entry for a column type; an unknown type reads as text. */
export const columnTypeOf = (type: string) =>
    COLUMN_TYPES.find((entry) => entry.value === type) ?? COLUMN_TYPES[0];

/** The column's type as a small tag: its icon and name, the same width for every column of a type. */
export const ColumnTypeTag: React.FC<{ type: string }> = ({ type }) => {
    const entry = columnTypeOf(type);
    return (
        <span className="table-card-type-tag">
            <Icon icon={entry.icon} />
            <span className="table-card-type-tag-label">{entry.label}</span>
        </span>
    );
};

/** Options a category column shows before "+N". */
export const PREVIEW_OPTIONS = 4;

/** A category column's options as chips, the first few then "+N". */
export const ColumnOptionChips: React.FC<{
    /** Labels, or options with a definition the chip shows as its tooltip. */
    options: ReadonlyArray<string | { label: string; description?: string | null }>;
}> = ({ options }) => (
    <div className="table-card-options" aria-label="Options">
        {options.slice(0, PREVIEW_OPTIONS).map((option, i) => {
            const label = typeof option === 'string' ? option : option.label;
            const definition = typeof option === 'string' ? null : option.description || null;
            return (
                <span
                    key={`${label}-${i}`}
                    className="table-card-option"
                    title={definition ? `${label}: ${definition}` : undefined}
                >
                    {label}
                </span>
            );
        })}
        {options.length > PREVIEW_OPTIONS && (
            <span className="text-sm font-color-secondary flex-none">
                {`+${options.length - PREVIEW_OPTIONS}`}
            </span>
        )}
    </div>
);
