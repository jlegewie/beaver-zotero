import React, { useMemo } from 'react';
import MenuButton from './MenuButton';
import type { MenuItem } from './ContextMenu';
import Icon from '../icons/Icon';
import TickIcon from '../icons/TickIcon';

/**
 * How risky an option is. `warning` renders the row and — while it is the
 * active option — the trigger in the accent color, so a standing grant is
 * visible without opening the menu.
 */
export type PermissionMenuTone = 'neutral' | 'warning';

export interface PermissionMenuOption<T extends string = string> {
    /** Stable identifier stored by the caller. */
    value: T;
    /** Row title, and the trigger label while this option is active. */
    label: string;
    /** One-line explanation shown under the title. */
    description?: string;
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    tone?: PermissionMenuTone;
    disabled?: boolean;
    /** Shorter label for the trigger, when the row title is too long for it. */
    triggerLabel?: string;
}

export interface PermissionMenuProps<T extends string = string> {
    options: readonly PermissionMenuOption<T>[];
    /** The active option's `value`. An unknown value renders the trigger label only. */
    value: T;
    onChange: (value: T) => void;
    /** Question shown above the options, e.g. "How should library changes be approved?". */
    heading?: string;
    /** Note shown under the options, e.g. where the standing default lives. */
    footnote?: string;
    /** Button variant for the trigger. */
    variant?: string;
    /** Render the trigger as its icon alone. */
    iconOnly?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    tooltipContent?: string;
    maxWidth?: string;
    className?: string;
    style?: React.CSSProperties;
    onAfterClose?: () => void;
}

const TITLE_TONE_CLASS: Record<PermissionMenuTone, string> = {
    neutral: 'font-color-primary',
    warning: 'font-color-orange',
};

const DESCRIPTION_TONE_CLASS: Record<PermissionMenuTone, string> = {
    neutral: 'font-color-secondary',
    warning: 'font-color-orange',
};

const ICON_TONE_CLASS: Record<PermissionMenuTone, string> = {
    neutral: 'font-color-secondary',
    warning: 'font-color-orange',
};

/**
 * A radio-style menu for choosing how much a client may do on the user's
 * behalf: each option is an icon, a title and a one-line explanation, with a
 * check mark on the active one.
 *
 * The component owns the shape, never the policy — the option set, its copy and
 * the persistence are the caller's, so the same menu serves a composer footer,
 * a preferences row or a per-tool override.
 *
 * @example
 * <PermissionMenu
 *     heading="How should library changes be approved?"
 *     options={LIBRARY_PERMISSION_OPTIONS}
 *     value={mode}
 *     onChange={setMode}
 * />
 */
function PermissionMenu<T extends string>({
    options,
    value,
    onChange,
    heading,
    footnote,
    variant = 'ghost-secondary',
    iconOnly = false,
    disabled = false,
    ariaLabel,
    tooltipContent,
    maxWidth = '320px',
    className = '',
    style,
    onAfterClose,
}: PermissionMenuProps<T>) {
    const selected = options.find((option) => option.value === value);

    const menuItems = useMemo((): MenuItem[] => (
        options.map((option) => {
            const tone = option.tone ?? 'neutral';
            const isSelected = option.value === value;
            return {
                label: option.label,
                role: 'menuitemradio',
                ariaChecked: isSelected,
                disabled: option.disabled,
                onClick: () => {
                    if (!isSelected) onChange(option.value);
                },
                customContent: (
                    <div className="display-flex flex-row items-start gap-2 w-full min-w-0">
                        {option.icon && (
                            <Icon
                                icon={option.icon}
                                size={16}
                                className={`mt-015 ${ICON_TONE_CLASS[tone]}`}
                            />
                        )}
                        <div className="display-flex flex-col flex-1 min-w-0">
                            <div className={`text-base ${isSelected ? 'font-medium' : ''} ${TITLE_TONE_CLASS[tone]}`}>
                                {option.label}
                            </div>
                            {option.description && (
                                <div className={`text-sm ${DESCRIPTION_TONE_CLASS[tone]}`}>
                                    {option.description}
                                </div>
                            )}
                        </div>
                        <Icon
                            icon={TickIcon}
                            size={16}
                            className={`mt-015 ${TITLE_TONE_CLASS[tone]}`}
                            // Kept mounted so the title column has the same width
                            // in every row and the rows do not shift on select.
                            style={{ visibility: isSelected ? 'visible' : 'hidden' }}
                        />
                    </div>
                ),
            };
        })
    ), [options, value, onChange]);

    const header = heading
        ? <div className="px-2 pt-1 pb-1 text-base font-color-secondary">{heading}</div>
        : undefined;

    const footer = footnote
        ? <div className="px-2 py-1 text-sm font-color-tertiary">{footnote}</div>
        : undefined;

    // The trigger only takes a color of its own for a `warning` option, so the
    // resting state sits quietly among the other composer controls and a
    // standing grant stands out against them.
    const triggerTone = selected?.tone ?? 'neutral';
    const triggerToneClass = triggerTone === 'warning' ? 'font-color-orange' : '';
    const triggerLabel = selected ? (selected.triggerLabel ?? selected.label) : '';
    const triggerContent = (
        <div className="display-flex items-center gap-1 min-w-0">
            {selected?.icon && (
                <Icon icon={selected.icon} className={`scale-11 ${triggerToneClass}`} />
            )}
            {!iconOnly && triggerLabel && (
                <span className={`truncate ${triggerToneClass}`}>{triggerLabel}</span>
            )}
        </div>
    );

    return (
        <MenuButton
            menuItems={menuItems}
            variant={variant}
            customContent={triggerContent}
            buttonLabel={triggerLabel}
            maxWidth={maxWidth}
            className={className}
            style={style}
            ariaLabel={ariaLabel ?? (heading ? `${heading} ${triggerLabel}` : triggerLabel)}
            tooltipContent={tooltipContent}
            disabled={disabled}
            header={header}
            footer={footer}
            onAfterClose={onAfterClose}
        />
    );
}

export default PermissionMenu;
