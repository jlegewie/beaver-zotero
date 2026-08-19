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
import { HandIcon, Icon, LayersIcon, SecurityWarningIcon, StopStrokeIcon } from '../icons';

/**
 * The coverage choices, and the only prose on this card the client owns.
 * Everything else the user reads comes from the backend.
 */
const MODE_OPTIONS: readonly PermissionMenuOption<BatchApprovalMode>[] = [
    {
        value: 'full_access',
        label: 'Full access',
        description: "Apply this batch's library changes without asking again",
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
    {
        value: 'ask_each_time',
        label: 'Ask permission',
        description: 'Review every change in this batch before it is applied',
        icon: HandIcon,
    },
];

const MODE_HEADING = "How should this batch's changes be approved?";

export interface BatchApprovalCardProps {
    /** The request the run is blocked on, as the backend asked it. */
    approval: PendingBatchApproval;
    /** The user's decision, ready for the wire. */
    onSubmit: (response: BatchApprovalDecision) => void;
    /** Abandon the run rather than decide. */
    onStop: () => void;
}

/**
 * The approval card for a pending batch operation.
 *
 * Takes the place of the client's composer while the run blocks on the
 * decision, so the request sits where the user is already looking and cannot
 * be scrolled away. The user's draft message is untouched — the card neither
 * reads nor writes it, and carries its own instructions field instead.
 *
 * Every word the user reads — title, goal, destructive warning, credit note,
 * button labels — is composed by the backend and rendered verbatim. This
 * component must not derive prose from those fields; the only copy it owns is
 * the mode menu and the instructions placeholder.
 *
 * The destructive warning is model-authored and gets its own block so it reads
 * as a separate claim about what will be removed or overwritten, not as more
 * of the goal. It is hidden when the batch declared nothing destructive.
 *
 * The card owns the draft and the one-shot guard; a host binds send and stop
 * and nothing else. Deliberately hook-light so it can be exercised as a plain
 * function.
 */
export const BatchApprovalCard: React.FC<BatchApprovalCardProps> = ({
    approval,
    onSubmit,
    onStop,
}) => {
    // Mode + instructions, seeded from the mode the request preselects.
    const [draft, setDraft] = useState<BatchApprovalDraft>(() => initialDraft(approval.defaultMode));
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
            style={{ minHeight: 'fit-content' }}
            role="group"
            aria-label="Batch operation approval"
            // The instructions field can take focus but nothing here announces
            // itself, so this is what tells a screen reader the run has stopped
            // and is waiting on a decision.
            aria-live="assertive"
        >
            <div className="display-flex flex-col gap-4">
                {/* Header: static icon + the backend's title */}
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <Icon icon={LayersIcon} className="font-color-secondary scale-12 flex-none" />
                    <div
                        className="font-color-primary text-sm font-semibold uppercase truncate"
                        style={{ letterSpacing: '0.05em' }}
                    >
                        {approval.title}
                    </div>
                </div>

                <div className="display-flex flex-col gap-4 min-w-0">
                    {/* The batch goal. DocsLink resolves the backend-provided
                        path for this client. */}
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

                    {approval.destructiveWarning && (
                        <div
                            className="display-flex flex-row items-start gap-2 p-2 rounded-md bg-quinary min-w-0"
                            role="note"
                            aria-label="What this batch removes or overwrites"
                        >
                            <Icon
                                icon={SecurityWarningIcon}
                                className="font-color-primary scale-12 flex-none mt-1"
                            />
                            <div className="font-color-primary min-w-0">
                                {approval.destructiveWarning}
                            </div>
                        </div>
                    )}

                    {approval.creditNote && (
                        <div className="font-color-secondary min-w-0">
                            {approval.creditNote}
                        </div>
                    )}

                    {/* Instructions live on the card: the composer is taken
                        over while the run blocks, so there is nothing else to
                        type into. */}
                    <textarea
                        className="chat-input"
                        rows={2}
                        placeholder="Instructions, or what you want done instead (optional)"
                        aria-label="Instructions for this batch (optional)"
                        value={draft.userInstructions}
                        disabled={isDecided}
                        onChange={(e) => {
                            const text = e.target.value;
                            setDraft((prev) => setUserInstructions(text, prev));
                        }}
                        onKeyDown={(e) => {
                            // Enter inserts a newline and never decides: the
                            // field takes focus, so approving stays an explicit
                            // click. Stopping propagation keeps a keystroke
                            // meant for this field from reaching a host
                            // shortcut that could answer for the user.
                            if (e.key === 'Enter') e.stopPropagation();
                        }}
                    />
                </div>

                {/* Footer: Stop, mode ... Decline Approve. Stop keeps the
                    leading position it has on the run-blocking cards next to
                    this one, so escaping a blocked run is always in the same
                    place. */}
                <div className="display-flex flex-row items-center pt-2 gap-2 min-w-0">
                    <Tooltip content="Stop the agent run" showArrow singleLine>
                        <Button
                            variant="outline"
                            rightIcon={StopStrokeIcon}
                            ariaLabel="Stop generating"
                            style={{ padding: '2px 5px' }}
                            onClick={onStop}
                        >
                            Stop
                        </Button>
                    </Tooltip>
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
                        ariaLabel="Reject batch operation"
                        onClick={handleDecline}
                        disabled={isDecided}
                    >
                        {approval.declineLabel}
                    </Button>
                    <Button
                        variant="solid"
                        ariaLabel="Approve batch operation"
                        style={{ padding: '2px 5px' }}
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
