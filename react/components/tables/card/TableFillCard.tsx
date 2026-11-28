import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import type { WSTableCardResponse, WSTableFillCardRequest } from '@beaver/agent-core/protocol/tableCardProtocol';
import { creditsActionLabel, fillPartLabel, refillNotice, trialWithinBalance } from '@beaver/agent-core/run-state/tableFillCopy';
import {
    FILL_TABLE_LABEL,
    fillCardTrialRows,
    fillScopeLine,
    initialTableCardDraft,
    setCancelling,
    setInstructions,
    tableCardDecline,
    tableFillCardResponse,
    type FillPart,
    type TableCardDraft,
} from '@beaver/agent-core/run-state/tableCardDraft';
import { getHost } from '@beaver/agent-ui/host';
import { ArrowLeftIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { ArrowUpRightIcon, Icon, Spinner, StopStrokeIcon, TableIcon } from '../../icons/icons';
import AutoGrowTextarea from './AutoGrowTextarea';
import { ColumnSummary } from './TableColumnsStep';
import {
    TableCardFillWarnings,
    TableCardReceipt,
    useAccountCreditBalance,
    useCardBalanceShortfall,
    useFillPricing,
    useShortWindow,
} from './TableCardCost';
import { openPreferencesWindow } from '../../../ui/openPreferencesWindow';
import { useSessionSetAtom } from '../../../hooks/useSessionSetAtom';

const BLOCK_GAP = '0.85rem';

export interface TableFillCardProps {
    request: WSTableFillCardRequest;
    onSubmit: (response: WSTableCardResponse) => void;
    /** Hold the answer back for now (the run's connection is being recovered). */
    disabled?: boolean;
    heldCaption?: string;
    onStop?: () => void;
}

/**
 * The fill card (`fill_table`): the create card's last step, with nothing to
 * edit. The title row with "Open table", the description, and the columns
 * being filled as the create card summarizes them. The footer stacks the same
 * parts as the create card's: a band for what the user must know first (a
 * held answer, a balance that does not reach, items without full text), the
 * decision row with the receipt and its pricing popover, and the controls:
 * Cancel, which asks what Beaver should do instead, "Try 5 first" when the
 * backend offers a trial, and Fill table. Approving approves exactly the plan
 * it shows, and the trial its first rows: edits made meanwhile can only drop
 * work from it. A fill that reads answered papers again for a new or changed
 * question says so in a band, and the trial stands out beside it.
 *
 * A balance short of the fill is the red band, with a way to credits, and
 * Fill table becomes the part it surely pays for ("Fill 8 of 23"), when the
 * backend takes a limit. A balance short of one item replaces the trial and
 * Fill table with the way to credits, as the table tab does.
 */
export const TableFillCard: React.FC<TableFillCardProps> = ({ request, onSubmit, disabled = false, heldCaption, onStop }) => {
    // Cancel view and typed instructions live in the renderer's store, keyed
    // by card, so switching sidebars keeps them.
    const cardId = request.card_id;
    const drafts = useAtomValue(tableCardDraftsAtom);
    const setDrafts = useSessionSetAtom(tableCardDraftsAtom);
    const initialDraft = useMemo(() => initialTableCardDraft(request), [request]);
    const draft = drafts.get(cardId) ?? initialDraft;
    const setDraft = useCallback(
        (update: (prev: TableCardDraft) => TableCardDraft) =>
            setDrafts((prev) => {
                const next = new Map(prev);
                next.set(cardId, update(prev.get(cardId) ?? initialDraft));
                return next;
            }),
        [cardId, initialDraft, setDrafts],
    );
    const prices = useFillPricing();
    const shortWindow = useShortWindow();
    const [isDecided, setIsDecided] = useState(false);
    const [openMessage, setOpenMessage] = useState('');
    const [bodyScrolled, setBodyScrolled] = useState(false);
    const decidedRef = useRef(false);
    const locked = isDecided || disabled;
    const hasInstructions = draft.instructions.trim().length > 0;
    // A short balance: Fill table fills the part it pays for ("Fill 8 of
    // 23") where the backend takes a limit; none at all, and the way to
    // credits takes Fill table's place.
    const shortfall = useCardBalanceShortfall(request.cost, prices, !!request.accepts_limit);
    const accountBalance = useAccountCreditBalance();
    const blocked = !!shortfall?.blocked;
    const part = shortfall?.part ?? null;
    const trialRows = trialWithinBalance(fillCardTrialRows(request), shortfall);
    // One band: the shortfall, when there is one, replaces the refill alert.
    const refill = (request.rereads ?? 0) > 0 && !shortfall ? refillNotice(trialRows) : null;

    const decide = useCallback(
        (approve: boolean, part: FillPart = {}) => {
            if (decidedRef.current || disabled) return;
            decidedRef.current = true;
            setIsDecided(true);
            onSubmit(approve ? tableFillCardResponse(request, part) : tableCardDecline(draft, request));
        },
        [disabled, draft, onSubmit, request],
    );
    const warnings = (inBody: boolean) => (
        <TableCardFillWarnings
            cost={request.cost}
            shortfall={shortfall}
            refill={refill}
            inBody={inBody}
            creditsAction={!blocked}
        />
    );
    const resumeReview = useCallback(() => setDraft((prev) => setCancelling(prev, false)), [setDraft]);

    // The table opens beside the surface that was clicked.
    const openTable = useCallback(async (event: React.SyntheticEvent) => {
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        const open = getHost().navigation?.openTable;
        if (!open) {
            setOpenMessage('Table provider unavailable.');
            return;
        }
        const outcome = await open(request.table.key, origin, { onDownload: () => setOpenMessage('Downloading table…') })
            .catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? '' : (outcome.warning ?? ''));
    }, [request.table.key]);

    const stopButton = disabled && onStop && (
        <Tooltip content="Stop the agent run" showArrow singleLine>
            <Button
                variant="outline"
                rightIcon={StopStrokeIcon}
                ariaLabel="Stop generating"
                style={{ padding: '2px 5px' }}
                onClick={onStop}
                className="flex-none"
            >
                Stop
            </Button>
        </Tooltip>
    );

    const title = request.title || request.table.title || 'Untitled table';
    const header = (
        <div className="table-card-header">
            <div className="display-flex flex-row items-start min-w-0" style={{ gap: '0.45rem' }}>
                <Icon icon={TableIcon} className="font-color-secondary flex-none table-card-title-icon" />
                <span className="table-card-title flex-1 min-w-0 truncate" title={title} dir="auto">
                    {title}
                </span>
                <button
                    type="button"
                    className="table-card-head-action flex-none"
                    onClick={openTable}
                    title="Open the table in a Beaver tab"
                >
                    <span>Open table</span>
                    <Icon icon={ArrowUpRightIcon} />
                </button>
            </div>
        </div>
    );

    if (draft.cancelling) {
        const heldNotice = disabled && heldCaption ? (
            <div className="table-card-notice table-card-notice-pending" role="status">
                <Spinner size={12} />
                <span className="table-card-notice-text">{heldCaption}</span>
            </div>
        ) : null;
        return (
            <div
                className="user-message-display table-card"
                role="group"
                aria-label="Cancel the fill"
                aria-live="assertive"
                onKeyDown={(e) => {
                    // An IME composing text owns Escape: it dismisses the candidate.
                    if (e.key !== 'Escape' || locked || isImeKeyEvent(e.nativeEvent)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    resumeReview();
                }}
            >
                <div className="table-card-top">{header}</div>
                <div className="table-card-body" style={{ gap: BLOCK_GAP }}>
                    <div className="table-card-header-body">
                        <AutoGrowTextarea
                            value={draft.instructions}
                            placeholder="Optional: What should Beaver do instead?"
                            aria-label="What Beaver should do instead (optional)"
                            autoFocus
                            disabled={locked}
                            style={{ minHeight: '3.6em' }}
                            onChange={(e) => setDraft((prev) => setInstructions(prev, e.target.value))}
                        />
                    </div>
                </div>
                <div className="table-card-footer">
                    {heldNotice}
                    <Button
                        variant="ghost"
                        icon={ArrowLeftIcon}
                        onClick={resumeReview}
                        disabled={locked}
                        className="flex-none whitespace-nowrap"
                    >
                        Back to fill
                    </Button>
                    {stopButton}
                    <div className="flex-1" />
                    <Button
                        variant={hasInstructions ? 'solid' : 'outline'}
                        ariaLabel={hasInstructions ? 'Decline the fill and send instructions' : 'Cancel the fill'}
                        onClick={() => decide(false)}
                        disabled={locked}
                        className="flex-none whitespace-nowrap"
                        style={{ padding: hasInstructions ? '3px 8px' : '2px 6px' }}
                    >
                        {hasInstructions ? 'Send' : 'Cancel fill'}
                    </Button>
                </div>
            </div>
        );
    }

    // The band above the decision: the held answer, or else the fill's
    // warnings, as on the create card. In a short window the warnings scroll
    // at the end of the content instead.
    const held = disabled && !!heldCaption;
    const bands = held ? (
        <div className="table-card-footer-band table-card-footer-band-pending" role="status">
            <Spinner size={12} />
            <span className="table-card-notice-text">{heldCaption}</span>
        </div>
    ) : shortWindow ? null : (
        warnings(false)
    );

    return (
        <div className="user-message-display table-card" role="group" aria-label="Proposed fill" aria-live="assertive">
            {/* The title row and the footer stay in place; everything between
                them scrolls in one area. */}
            <div className={`table-card-top ${bodyScrolled ? 'table-card-top-scrolled' : ''}`}>{header}</div>
            <div
                className="table-card-body"
                style={{ gap: BLOCK_GAP }}
                onScroll={(e) => setBodyScrolled(e.currentTarget.scrollTop > 0)}
            >
                {(request.description || openMessage) && (
                    <div className="table-card-header-body">
                        {request.description && <div className="table-card-description">{request.description}</div>}
                        {openMessage && <div className="text-sm font-color-secondary">{openMessage}</div>}
                    </div>
                )}
                <div className="table-card-step">
                    <div className="table-card-step-head">
                        <span className="font-semibold font-color-primary">Columns</span>
                        <span className="table-card-count">{request.columns.length.toLocaleString('en-US')}</span>
                    </div>
                    <div className="display-flex flex-col min-w-0" style={{ gap: '0.45rem' }}>
                        {request.columns.map((column, index) => (
                            <div key={`${index}:${column.header}`} className="table-card-column table-card-column-disabled">
                                <ColumnSummary column={column} full />
                            </div>
                        ))}
                    </div>
                </div>
                {!held && shortWindow && warnings(true)}
            </div>

            <div className="table-card-footer table-card-footer-stack">
                {bands}
                {/* What Fill table starts and what it costs, as the create
                    card's run checkbox and receipt. */}
                <div className={`table-card-decision ${disabled ? 'table-card-decision-held' : ''}`}>
                    <span className="table-card-decision-label">{fillScopeLine(request)}</span>
                    <TableCardReceipt cost={request.cost} prices={prices} disabled={locked} part={part} />
                </div>
                <div className="table-card-controls">
                    <Button
                        variant="ghost"
                        onClick={() => setDraft((prev) => setCancelling(prev, true))}
                        disabled={locked}
                        className="flex-none whitespace-nowrap"
                    >
                        Cancel
                    </Button>
                    <div className="flex-1" />
                    {/* While the answer is held, Stop takes the way forward's place. */}
                    {stopButton || (blocked ? (
                        // Nothing to fill with: the way to credits replaces Fill.
                        <Button
                            variant="solid"
                            onClick={() => openPreferencesWindow('billing')}
                            className="flex-none whitespace-nowrap"
                            style={{ padding: '3px 8px' }}
                        >
                            {creditsActionLabel(accountBalance)}
                        </Button>
                    ) : (
                        <>
                            {trialRows && (
                                <Button
                                    variant={refill ? 'outline' : 'ghost-secondary'}
                                    onClick={() => decide(true, { trial: true })}
                                    disabled={locked}
                                    className="flex-none whitespace-nowrap"
                                    title={`Fill the first ${trialRows} rows now to check the answers`}
                                >
                                    Try {trialRows} first
                                </Button>
                            )}
                            <Button
                                variant="solid"
                                onClick={() => decide(true, part ? { limit: part.rows } : {})}
                                disabled={locked}
                                className="flex-none whitespace-nowrap"
                                style={{ padding: '3px 8px' }}
                                title={part ? 'Fill the items your credits cover; the rest stay pending' : undefined}
                            >
                                {part ? fillPartLabel(part) : FILL_TABLE_LABEL}
                            </Button>
                        </>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default TableFillCard;
