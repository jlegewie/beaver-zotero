import React from 'react';
import Button from './Button';
import { PlusSignIcon } from '../icons';

/** Vertical gap between the field's own label and the field. */
const LABEL_GAP = '0.3rem';

export interface InstructionsDisclosureProps {
    /** Whether the field is showing. Owned by the caller, so a prefilled
     *  field can open straight away. */
    open: boolean;
    onOpen: () => void;
    value: string;
    onChange: (value: string) => void;
    /** Label on the button that reveals the field. */
    revealLabel: string;
    /** Accessible name for that button. Defaults to its label; set it where
     *  the label alone would not say which card the button belongs to. */
    revealAriaLabel?: string;
    /** Heading above the field once it is open. */
    heading: string;
    placeholder: string;
    /** Accessible name for the field, and the basis for the button's. */
    ariaLabel: string;
    disabled?: boolean;
    /** Focus the field as it appears. Off for a field that is open from the
     *  start, where nothing the user just did asked for the caret. */
    autoFocus?: boolean;
    /** Style for the field, applied to the textarea. */
    textareaStyle?: React.CSSProperties;
}

/**
 * "Add instructions" — a button that gives way to a text field.
 *
 * Shared by every card that lets the user say something alongside a decision,
 * so the affordance reads the same wherever it appears: collapsed by default
 * because an empty field looks unfinished, and leaning toward neither of the
 * decisions it sits between.
 *
 * Owns no state. The caller holds both the text and whether the field is
 * open, because both outlive this component: a card may open with the field
 * already showing, and the text is part of the answer being composed.
 */
export const InstructionsDisclosure: React.FC<InstructionsDisclosureProps> = ({
    open,
    onOpen,
    value,
    onChange,
    revealLabel,
    revealAriaLabel,
    heading,
    placeholder,
    ariaLabel,
    disabled = false,
    autoFocus = true,
    textareaStyle,
}) => {
    if (!open) {
        return (
            <Button
                variant="ghost"
                icon={PlusSignIcon}
                ariaLabel={revealAriaLabel ?? revealLabel}
                // Pulled back by its own padding so the label lines up with
                // the text above it rather than the button box.
                style={{ alignSelf: 'flex-start', marginLeft: '-6px', ...textareaStyle }}
                disabled={disabled}
                onClick={onOpen}
            >
                {revealLabel}
            </Button>
        );
    }

    return (
        <div className="display-flex flex-col min-w-0" style={{ gap: LABEL_GAP }}>
            <div
                className="text-xs font-semibold uppercase font-color-secondary"
                style={{ letterSpacing: '0.06em' }}
            >
                {heading}
            </div>
            <textarea
                className="chat-input"
                rows={2}
                autoFocus={autoFocus}
                placeholder={placeholder}
                aria-label={ariaLabel}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    // Enter inserts a newline and never decides: the field
                    // takes focus, so acting stays an explicit click. Stopping
                    // propagation keeps a keystroke meant for this field from
                    // reaching a host shortcut that could answer for the user.
                    if (e.key === 'Enter') e.stopPropagation();
                }}
            />
        </div>
    );
};

export default InstructionsDisclosure;
