import React, { useCallback, useRef, useState } from 'react';
import type { PendingBatchApproval } from '@beaver/agent-core/run-state/pendingBatchApprovals';
import type {
    BatchApprovalDecision,
    BatchApprovalDraft,
    BatchApprovalMode,
} from '@beaver/agent-core/run-state/batchApprovalAnswers';
import {
    buildResponse,
    initialDraft,
    setMode,
    setUserInstructions,
} from '@beaver/agent-core/run-state/batchApprovalAnswers';
import Button from '../primitives/Button';
import DocsLink from '../primitives/DocsLink';
import Tooltip from '../primitives/Tooltip';
import PermissionMenu from '../primitives/PermissionMenu';
import type { PermissionMenuOption } from '../primitives/PermissionMenu';
import { DollarCircleIcon, HandIcon, Icon, LayersIcon, PlusSignIcon, SecurityWarningIcon } from '../icons';

/**
 * The coverage choices, and the only prose on this card the client owns.
 * Everything else the user reads comes from the backend.
 */
const MODE_OPTIONS: readonly PermissionMenuOption<BatchApprovalMode>[] = [
    {
        value: 'full_access',
        label: 'Full access',
        description: "Apply library changes without asking again",
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
    {
        value: 'ask_each_time',
        label: 'Ask permission',
        description: 'Review every change before it is applied',
        icon: HandIcon,
    },
];

// const MODE_HEADING = "How should this batch's changes be approved?";
const MODE_HEADING = "";

/**
 * Labels for the slots the card lays out, as opposed to what goes in them.
 * Naming a slot is chrome — the same class of copy as the mode menu — while
 * everything the slots hold is composed by the backend.
 */
const ACTION_HEADING = 'Requested action';
const INSTRUCTIONS_HEADING = 'Your instructions';
const ADD_INSTRUCTIONS_LABEL = 'Add instructions';

/** Vertical rhythm. The card interrupts the user, so it is laid out loosely. */
const BLOCK_GAP = '1rem';
const LABEL_GAP = '0.3rem';

export interface BatchApprovalCardProps {
    /** The request the run is blocked on, as the backend asked it. */
    approval: PendingBatchApproval;
    /** The user's decision, ready for the wire. */
    onSubmit: (response: BatchApprovalDecision) => void;
}

/**
 * The approval card for a pending batch operation.
 *
 * Takes the place of the client's composer while the run blocks on the
 * decision, so the request sits where the user is already looking and cannot
 * be scrolled away. The user's draft message is untouched — the card neither
 * reads nor writes it, and carries its own instructions field instead.
 *
 * Every word the user reads about the batch — title, scope line, goal,
 * destructive warning, credit chip, button labels — is composed by the backend
 * and rendered verbatim. This component must not derive prose from those
 * fields; the only copy it owns is the mode menu and the slot headings.
 *
 * The scope line arrives in two halves so the card can weight them: the count
 * is the fact the decision turns on, the location is context for it. The
 * location is empty whenever the backend could not state it truthfully, and
 * the count then stands alone.
 *
 * The destructive warning is model-authored and gets its own block so it reads
 * as a separate claim about what will be removed or overwritten, not as more
 * of the goal. It is hidden when the batch declared nothing destructive.
 *
 * Both answers leave the run alive: approving starts the batch, cancelling
 * cancels the batch and lets the run keep talking. Instructions travel with
 * either, which is why the field that holds them is labelled for neither.
 *
 * The card owns the draft and the one-shot guard; a host binds send and
 * nothing else. Deliberately hook-light so it can be exercised as a plain
 * function.
 */
export const BatchApprovalCard: React.FC<BatchApprovalCardProps> = ({
    approval,
    onSubmit,
}) => {
    // Mode + instructions, seeded from the mode the request preselects.
    const [draft, setDraft] = useState<BatchApprovalDraft>(() => initialDraft(approval.defaultMode));
    // Whether the instructions field has been asked for. Collapsed by default:
    // most decisions carry none, and the composer this card replaces is gone,
    // so an empty field sitting above the buttons reads as something left
    // undone.
    const [wantsInstructions, setWantsInstructions] = useState(false);
    // Drives the disabled styling in the instant before the card unmounts.
    const [isDecided, setIsDecided] = useState(false);
    // The guard that actually holds. Exactly one decision may leave the
    // client: the run correlates on the approval id, and a second one would
    // arrive after the backend stopped listening. The card is still mounted
    // right after the decision goes out — the pending entry clears and React
    // re-renders asynchronously — so a second click can still reach an enabled
    // handler. `isDecided` only settles on the next render, so it cannot block
    // it; this ref is set synchronously and does.
    const hasDecidedRef = useRef(false);

    const decide = useCallback((approved: boolean) => {
        if (hasDecidedRef.current) return;
        hasDecidedRef.current = true;
        setIsDecided(true);
        onSubmit(buildResponse(draft, approved));
    }, [draft, onSubmit]);

    const handleApprove = useCallback(() => decide(true), [decide]);
    const handleDecline = useCallback(() => decide(false), [decide]);

    return (
        <div
            className="user-message-display"
            style={{ minHeight: 'fit-content', padding: '0.8rem' }}
            role="group"
            aria-label="Batch operation approval"
            // The instructions field can take focus but nothing here announces
            // itself, so this is what tells a screen reader the run has stopped
            // and is waiting on a decision.
            aria-live="assertive"
        >
            <div className="display-flex flex-col min-w-0" style={{ gap: BLOCK_GAP }}>

                {/* Header: static icon, the backend's title, the credit chip,
                    and under them what the batch covers. */}
                <div className="display-flex flex-col min-w-0" style={{ gap: '0.4rem' }}>
                    <div
                        className="display-flex flex-row items-center gap-2 min-w-0"
                        // The chip drops to its own line rather than squeezing
                        // the title: this card renders in a sidebar the user
                        // can drag as narrow as they like.
                        style={{ flexWrap: 'wrap', rowGap: '0.25rem' }}
                    >
                        <Icon icon={LayersIcon} className="font-color-secondary scale-12 flex-none" />
                        <div
                            className="font-color-primary text-sm font-semibold uppercase truncate"
                            style={{ letterSpacing: '0.05em' }}
                        >
                            {approval.title}
                        </div>
                        {approval.creditChip && (
                            <>
                                <div className="flex-1" />
                                {/* flex-none wrapper so the popup is not a
                                    sibling of this wrapping min-w-0 row — an
                                    in-flow tooltip is measured as a flex item,
                                    and its x and wrap then change on every
                                    hover. No portal: the host document may
                                    have no HTML body to portal into. */}
                                <div className="flex-none">
                                    <Tooltip
                                        content={approval.creditTooltip}
                                        showArrow
                                        width="220px"
                                        horizontalAlign="end"
                                    >
                                        <div
                                            className="text-sm font-color-secondary items-center display-flex"
                                            style={{
                                                border: '1px solid var(--fill-quarternary)',
                                                borderRadius: '6px',
                                                padding: '2px 7px',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            <Icon icon={DollarCircleIcon} className="font-color-secondary scale-11 flex-none mr-1" />
                                            {approval.creditChip}
                                        </div>
                                    </Tooltip>
                                </div>
                            </>
                        )}
                    </div>
                    <div className="font-color-secondary min-w-0">
                        <span className="font-color-primary font-medium">
                            {approval.scopePrimary}
                        </span>
                        {approval.scopeSecondary && ` ${approval.scopeSecondary}`}
                    </div>
                </div>

                {/* The batch goal. DocsLink resolves the backend-provided
                    path for this client. */}
                <div className="display-flex flex-col min-w-0" style={{ gap: LABEL_GAP }}>
                    <div
                        className="text-xs font-semibold uppercase font-color-secondary"
                        style={{ letterSpacing: '0.06em' }}
                    >
                        {ACTION_HEADING}
                    </div>
                    <div className="font-color-primary">
                        {approval.message}
                        {approval.learnMorePath && approval.learnMoreLabel && (
                            <>
                                {' '}
                                <DocsLink path={approval.learnMorePath}>
                                    {approval.learnMoreLabel}
                                </DocsLink>
                            </>
                        )}
                    </div>
                </div>

                {approval.destructiveWarning && (
                    <div
                        className="display-flex flex-row items-start gap-2 p-2 rounded-md min-w-0"
                        style={{
                            backgroundColor: 'var(--tag-orange-quinary)',
                            border: '1px solid var(--tag-orange-tertiary)',
                        }}
                        role="note"
                        aria-label="What this batch removes or overwrites"
                    >
                        <Icon
                            icon={SecurityWarningIcon}
                            className="font-color-orange scale-12 flex-none mt-1"
                        />
                        <div className="font-color-orange min-w-0">
                            {approval.destructiveWarning &&
                                (approval.destructiveWarning.charAt(0).toUpperCase() +
                                approval.destructiveWarning.slice(1))}
                        </div>
                    </div>
                )}

                {/* Instructions live on the card: the composer is taken over
                    while the run blocks, so there is nothing else to type
                    into. They constrain an approval and say what to do instead
                    of a cancellation, so the affordance leans toward neither. */}
                {wantsInstructions ? (
                    <div className="display-flex flex-col min-w-0" style={{ gap: LABEL_GAP }}>
                        <div
                            className="text-xs font-semibold uppercase font-color-secondary"
                            style={{ letterSpacing: '0.06em' }}
                        >
                            {INSTRUCTIONS_HEADING}
                        </div>
                        <textarea
                            className="chat-input"
                            rows={2}
                            // The field only exists because the user just asked
                            // for it, so the caret belongs in it.
                            autoFocus
                            placeholder="What to change, or what you want done instead"
                            aria-label="Instructions for this batch (optional)"
                            value={draft.userInstructions}
                            disabled={isDecided}
                            onChange={(e) => {
                                const text = e.target.value;
                                setDraft((prev) => setUserInstructions(text, prev));
                            }}
                            onKeyDown={(e) => {
                                // Enter inserts a newline and never decides:
                                // the field takes focus, so approving stays an
                                // explicit click. Stopping propagation keeps a
                                // keystroke meant for this field from reaching
                                // a host shortcut that could answer for the
                                // user.
                                if (e.key === 'Enter') e.stopPropagation();
                            }}
                        />
                    </div>
                ) : (
                    <Button
                        variant="ghost"
                        icon={PlusSignIcon}
                        ariaLabel="Add instructions for this batch"
                        // Pulled back by its own padding so the label lines up
                        // with the text above it rather than the button box.
                        style={{ alignSelf: 'flex-start', marginLeft: '-6px' }}
                        disabled={isDecided}
                        onClick={() => setWantsInstructions(true)}
                    >
                        {ADD_INSTRUCTIONS_LABEL}
                    </Button>
                )}

                {/* Footer: coverage ... cancel, approve. Both answers leave the
                    run alive, so neither is an escape hatch and the destructive
                    one is not given a leading position. */}
                <div
                    className="display-flex flex-row items-center gap-2 min-w-0"
                    style={{ borderTop: '1px solid var(--fill-quinary)', paddingTop: '0.7rem' }}
                >
                    <PermissionMenu
                        options={MODE_OPTIONS}
                        value={draft.mode}
                        onChange={(mode) => setDraft((prev) => setMode(mode, prev))}
                        heading={MODE_HEADING}
                        disabled={isDecided}
                        tooltipContent="How this batch's changes are approved"
                        style={{ padding: '2px 6px', fontSize: '0.95rem' }}
                    />
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        ariaLabel="Cancel batch operation"
                        onClick={handleDecline}
                        disabled={isDecided}
                        className="mr-1"
                    >
                        {approval.declineLabel}
                    </Button>
                    <Button
                        variant="solid"
                        ariaLabel="Approve batch operation"
                        style={{ padding: '3px 5px' }}
                        onClick={handleApprove}
                        disabled={isDecided}
                    >
                        {approval.approveLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default BatchApprovalCard;
