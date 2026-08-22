import React from 'react';
import { BatchOperationView } from '@beaver/agent-core/run-state/toolResultViews';
import { Icon, LayersIcon, SecurityWarningIcon } from '@beaver/agent-ui/icons';
import {
    BatchFailureReasonBlock,
    BatchProgressTrack,
    BatchRemovalBlock,
    BatchTallyBlock,
} from '@beaver/agent-ui/chat/BatchOutcomeBlocks';

/**
 * Labels for the slots this card lays out, as opposed to what goes in them.
 * Deliberately the same words the approval card uses: this is that card read
 * back, and the two must not describe the same batch differently.
 */
const ACTION_HEADING = 'Requested action';
const INSTRUCTIONS_HEADING = 'Your instructions';
const REMOVED_HEADING = 'Also removed';
const FAILURE_HEADING = 'Could not be read';
const INCOMPLETE_HEADING = 'Not completed';

/**
 * Shared renderer for the {@link BatchOperationView} view model (batch_start).
 *
 * The read-only counterpart of the batch approval card: what the batch covers,
 * what it set out to do, what it removes or overwrites, and anything the user
 * attached when they approved it. Nothing here decides anything — the decision
 * was made on the approval card, and its buttons, coverage menu and credit
 * chip have no meaning after the fact.
 *
 * Every string comes from the view model verbatim — including the title, which
 * the tool-call row this expands from does NOT carry (that row shows a static
 * per-tool label). The only copy this component owns is its slot headings.
 *
 * Host-agnostic — pure view data, no client lookups.
 */
export const BatchOperationResultView: React.FC<{ view: BatchOperationView }> = ({ view }) => {
    const scopeSecondary = view.scope_secondary?.trim();
    const destructive = view.destructive_warning?.trim();
    const instructions = view.user_instructions?.trim();
    // A batch that has ended says how; one still running says how far it got.
    const badge = view.status_label?.trim() || view.progress_label?.trim();
    // Only a batch nobody finished is called out; completion is not a warning.
    const isStopped = view.status === 'cancelled';
    // The bar's own entry, when the backend sent one. Its absence is what makes
    // a card written before this existed render exactly as it always did.
    const progress = view.progress ?? null;
    // `is_finished` is also satisfied by items that failed often enough to stop
    // being retried. The badge already refuses to call those completed; this
    // says how many, so the honest ending is legible and not just a label.
    const failedOut = progress?.status === 'failed_out' ? (progress.failed ?? 0) : 0;

    return (
        <div className="display-flex flex-col min-w-0 p-3 gap-4">
            {/* Header: the backend's title and, opposite it, how the batch
                ended or how far it has got — the slot the credit chip occupies
                on the approval card, which has nothing to say after the fact. */}
            <div className="display-flex flex-col min-w-0 gap-1">
                {/* What the batch covers, weighted the way the approval card
                    weights it: the count is the fact, the location is context. */}
                <div className="font-color-secondary min-w-0">
                    <span className="font-color-primary font-medium">
                        {view.scope_primary}
                    </span>
                    {scopeSecondary && ` ${scopeSecondary}`}
                </div>
            </div>

            {/* What the batch actually did, in the shapes the live bar used —
                a user who watched it run must not have to reconcile two
                different pictures of one batch. */}
            {progress && (
                <div className="display-flex flex-col min-w-0 gap-3">
                    <BatchProgressTrack batch={progress} />
                    <BatchTallyBlock batch={progress} />
                    <BatchRemovalBlock batch={progress} heading={REMOVED_HEADING} />
                    <BatchFailureReasonBlock batch={progress} heading={FAILURE_HEADING} />
                </div>
            )}

            <div className="display-flex flex-col min-w-0 gap-05">
                <div
                    className="text-xs font-semibold uppercase font-color-secondary"
                    style={{ letterSpacing: '0.06em' }}
                >
                    {ACTION_HEADING}
                </div>
                <div className="font-color-primary">{view.goal}</div>
            </div>

            {/* Model-authored, and kept in its own block so it reads as a
                separate claim about what was removed or overwritten rather
                than as more of the goal. */}
            {destructive && (
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
                        {destructive.charAt(0).toUpperCase() + destructive.slice(1)}
                    </div>
                </div>
            )}

            {failedOut > 0 && (
                <div className="display-flex flex-col min-w-0 gap-05">
                    <div
                        className="text-xs font-semibold uppercase font-color-secondary"
                        style={{ letterSpacing: '0.06em' }}
                    >
                        {INCOMPLETE_HEADING}
                    </div>
                    <div className="font-color-secondary text-sm">
                        {`${failedOut.toLocaleString()} item${failedOut === 1 ? '' : 's'} could not be completed after repeated attempts.`}
                    </div>
                </div>
            )}

            {/* Only when the user actually typed something on the card. */}
            {instructions && (
                <div className="display-flex flex-col min-w-0 gap-05">
                    <div
                        className="text-xs font-semibold uppercase font-color-secondary"
                        style={{ letterSpacing: '0.06em' }}
                    >
                        {INSTRUCTIONS_HEADING}
                    </div>
                    <div className="font-color-primary">{instructions}</div>
                </div>
            )}
        </div>
    );
};

export default BatchOperationResultView;
