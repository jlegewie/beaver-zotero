import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import type { WSTableCardResponse, WSTableFillCardRequest } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    fillActionLabel,
    initialTableCardDraft,
    setCancelling,
    setInstructions,
    tableCardDecline,
    tableFillCardResponse,
    type TableCardDraft,
} from '@beaver/agent-core/run-state/tableCardDraft';
import { getHost } from '@beaver/agent-ui/host';
import { ArrowLeftIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { ArrowUpRightIcon, Icon, Spinner, StopStrokeIcon, TableIcon } from '../../icons/icons';
import { ColumnTypeTag } from '../columnTypes';
import AutoGrowTextarea from './AutoGrowTextarea';
import TableCardCostBlock, { useFillPricing } from './TableCardCost';

export interface TableFillCardProps {
    request: WSTableFillCardRequest;
    onSubmit: (response: WSTableCardResponse) => void;
    /** Hold the answer back for now (the run's connection is being recovered). */
    disabled?: boolean;
    heldCaption?: string;
    onStop?: () => void;
}

/**
 * The fill card (`fill_table`): the same chrome as the create card with one
 * step and nothing to edit. Title and description, "Open table", the columns
 * being filled, the plan's row line and exact cost with the balance and the
 * pricing sentence, and two buttons: Cancel, which asks what Beaver should do
 * instead, and one named for the run ("Fill 46"). Approving approves exactly
 * the plan it shows: edits made meanwhile can only drop work from it.
 */
export const TableFillCard: React.FC<TableFillCardProps> = ({ request, onSubmit, disabled = false, heldCaption, onStop }) => {
    // Cancel view and typed instructions live in the renderer's store, keyed
    // by card, so switching sidebars keeps them.
    const cardId = request.card_id;
    const drafts = useAtomValue(tableCardDraftsAtom);
    const setDrafts = useSetAtom(tableCardDraftsAtom);
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
    const [isDecided, setIsDecided] = useState(false);
    const [openMessage, setOpenMessage] = useState('');
    const decidedRef = useRef(false);
    const locked = isDecided || disabled;
    const hasInstructions = draft.instructions.trim().length > 0;

    const decide = useCallback(
        (approve: boolean) => {
            if (decidedRef.current || disabled) return;
            decidedRef.current = true;
            setIsDecided(true);
            onSubmit(approve ? tableFillCardResponse(request) : tableCardDecline(draft, request));
        },
        [disabled, draft, onSubmit, request],
    );

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
        setOpenMessage('error' in outcome ? outcome.error : (outcome.warning ?? ''));
    }, [request.table.key]);

    const heldNotice = disabled && heldCaption ? (
        <div className="table-card-notice table-card-notice-pending" role="status">
            <Spinner size={12} />
            <span className="table-card-notice-text">{heldCaption}</span>
        </div>
    ) : null;

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
                <span className="table-card-title flex-1 min-w-0 truncate" title={title}>
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
                    setDraft((prev) => setCancelling(prev, false));
                }}
            >
                <div className="table-card-top">{header}</div>
                <div className="table-card-body" style={{ gap: '0.85rem' }}>
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
                        onClick={() => setDraft((prev) => setCancelling(prev, false))}
                        disabled={locked}
                        className="flex-none whitespace-nowrap"
                    >
                        Back
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

    const runLabel = fillActionLabel(request);
    return (
        <div className="user-message-display table-card" role="group" aria-label="Proposed fill" aria-live="assertive">
            <div className="table-card-top">{header}</div>
            <div className="table-card-body" style={{ gap: '0.85rem' }}>
                {request.description && (
                    <div className="table-card-header-body">
                        <div className="table-card-description font-color-secondary">{request.description}</div>
                    </div>
                )}
                <div className="table-card-step">
                    <div className="table-card-step-head">
                        <span className="font-semibold font-color-primary">Columns</span>
                        <span className="table-card-count">{request.columns.length.toLocaleString('en-US')}</span>
                    </div>
                    <div className="display-flex flex-col min-w-0" style={{ gap: '0.3rem' }}>
                        {request.columns.map((column, index) => (
                            <div key={`${index}:${column.header}`} className="display-flex flex-row items-center gap-2 min-w-0 text-sm">
                                <span className="flex-1 min-w-0 truncate font-medium font-color-primary" title={column.description ?? undefined}>
                                    {column.header}
                                </span>
                                <span className="flex-none">
                                    <ColumnTypeTag type={column.type} />
                                </span>
                            </div>
                        ))}
                    </div>
                    <TableCardCostBlock cost={request.cost} prices={prices} />
                    {openMessage && <div className="text-sm font-color-secondary">{openMessage}</div>}
                </div>
            </div>
            <div className="table-card-footer">
                {heldNotice}
                <Button
                    variant="ghost"
                    onClick={() => setDraft((prev) => setCancelling(prev, true))}
                    disabled={locked}
                    className="flex-none whitespace-nowrap"
                >
                    Cancel
                </Button>
                {stopButton}
                <div className="flex-1" />
                <Button
                    variant="solid"
                    ariaLabel={`${runLabel} papers`}
                    onClick={() => decide(true)}
                    disabled={locked}
                    title={disabled ? heldCaption : undefined}
                    className="flex-none whitespace-nowrap"
                    style={{ padding: '3px 8px' }}
                >
                    {runLabel}
                </Button>
            </div>
        </div>
    );
};

export default TableFillCard;
