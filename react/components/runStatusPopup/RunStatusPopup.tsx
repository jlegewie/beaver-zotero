import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The shimmering status line, cut with a visible ellipsis.
 *
 * Drawn by hand because the shimmer paints its text through a transparent
 * fill, and Gecko paints `text-overflow`'s marker the same way — the line
 * looked cut off. The text itself is clipped, and a plain "…" in the line's
 * own color follows it whenever the text does not fit.
 */
const StatusLine: React.FC<{ text: string }> = ({ text }) => {
    const textRef = useRef<HTMLSpanElement>(null);
    const [clipped, setClipped] = useState(false);

    useLayoutEffect(() => {
        const el = textRef.current;
        const win = el?.ownerDocument.defaultView;
        if (!el || !win) return;
        const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
        measure();
        const observer = new win.ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [text]);

    return (
        <span className="beaver-run-status-popup__status" title={text}>
            <span ref={textRef} className="shimmer-text beaver-run-status-popup__status-text">{text}</span>
            {clipped && <span aria-hidden="true">…</span>}
        </span>
    );
};
import { useAtomValue } from 'jotai';
import { isSidebarVisibleAtom } from '../../atoms/ui';
import { runStatusPopupForceVisibleAtom } from '../../atoms/runStatusPopup';
import {
    AlertIcon,
    ArrowUpRightIcon,
    CancelIcon,
    CheckmarkCircleIcon,
    DollarCircleIcon,
    HelpCircleIcon,
    Icon,
    LibraryIcon,
} from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import RunPermissionButton from '../ui/buttons/RunPermissionButton';
import AskUserQuestionCard from '@beaver/agent-ui/chat/AskUserQuestionCard';
import BatchApprovalCard from '@beaver/agent-ui/chat/BatchApprovalCard';
import BatchProgressPanel from '../input/BatchProgressPanel';
import { getAgentActionToolIcon } from '../../host/zotero/components/agentActionViewHelpers';
import RunPulse from './RunPulse';
import { useRunStatusPopupCard } from './useRunStatusPopupCard';
import type {
    ApprovalCard,
    BatchCard,
    CompletedCard,
    CreditCard,
    QuestionCard,
    RunningCard,
    RunStatusPopupCard,
} from './runStatusPopupModel';

/** The compact control sizing the card's footer buttons share. */
const FOOTER_BUTTON_STYLE: React.CSSProperties = { padding: '2px 10px', fontSize: '0.875rem', whiteSpace: 'nowrap' };

/** Every state's mark shares one footprint, the pulse included. */
const MARK_SIZE = 16;

const Mark: React.FC<{ icon: React.FC<React.SVGProps<SVGSVGElement>>; className?: string }> = ({ icon, className = '' }) => (
    <Icon icon={icon} size={MARK_SIZE} className={className} />
);

/**
 * Whether a click on the card should open Beaver. Buttons, menus and the
 * artifact rows carry their own actions, so a click that lands on one of
 * them — or inside a menu they opened — is theirs.
 */
function isCardBackgroundClick(event: React.MouseEvent<HTMLElement>): boolean {
    const target = event.target as Element | null;
    return !target?.closest(
        'button, a, input, textarea, label, [role="menu"], [role="menuitem"], [role="menuitemradio"], [data-run-status-popup-interactive]',
    );
}

const Header: React.FC<{
    card: RunStatusPopupCard;
    leading: React.ReactNode;
    /** The second line; null for a card whose title is the whole story. */
    detail: React.ReactNode;
    detailClassName?: string;
}> = ({ card, leading, detail, detailClassName = 'font-color-secondary' }) => (
    <div className="beaver-run-status-popup__header">
        <div className="beaver-run-status-popup__leading">{leading}</div>
        <div className="beaver-run-status-popup__text">
            <div className="beaver-run-status-popup__title font-color-primary" title={card.threadName}>
                {card.threadName}
            </div>
            {detail !== null && (
                <div className={`beaver-run-status-popup__detail ${detailClassName}`}>{detail}</div>
            )}
        </div>
        {/* Shown on hover so the card stays quiet; closing is remembered for
            this card only (see the hook), so the run's next request still
            gets through. */}
        <div className="beaver-run-status-popup__trailing beaver-run-status-popup__dismiss">
            <IconButton
                icon={CancelIcon}
                variant="ghost-secondary"
                onClick={card.onDismiss}
                ariaLabel="Close"
            />
        </div>
    </div>
);

/** Live batch progress, drawn under the header of the cards that keep the run's work visible. */
interface WithBatchProgress {
    batchProgress: React.ReactNode;
}

const RunningView: React.FC<{ card: RunningCard } & WithBatchProgress> = ({ card, batchProgress }) => (
    <>
        <Header
            card={card}
            leading={<RunPulse />}
            detail={<StatusLine text={card.statusLine} />}
        />
        {batchProgress}
    </>
);

const ApprovalView: React.FC<{ card: ApprovalCard } & WithBatchProgress> = ({ card, batchProgress }) => (
    <>
        <Header
            card={card}
            leading={(
                <Mark
                    icon={card.actionType ? getAgentActionToolIcon(card.actionType) : LibraryIcon}
                    className="font-color-secondary"
                />
            )}
            detail={<span title={card.label}>{card.label}</span>}
            detailClassName="font-color-primary"
        />
        {batchProgress}
        <div className="beaver-run-status-popup__footer">
            {card.permission && (
                <div className="beaver-run-status-popup__permission">
                    <RunPermissionButton
                        mode={card.permission.mode}
                        onChange={card.permission.onChange}
                        pendingCoveredCount={card.permission.pendingCoveredCount}
                        disabled={card.decideDisabled}
                    />
                </div>
            )}
            <div className="flex-1" />
            <Button
                variant="outline"
                style={FOOTER_BUTTON_STYLE}
                onClick={() => card.onDecide(false)}
                disabled={card.decideDisabled}
            >
                {card.rejectLabel}
            </Button>
            <Button
                data-run-status-approve
                variant="solid"
                style={FOOTER_BUTTON_STYLE}
                onClick={() => card.onDecide(true)}
                disabled={card.decideDisabled}
            >
                {card.approveLabel}
            </Button>
        </div>
    </>
);

const CreditView: React.FC<{ card: CreditCard }> = ({ card }) => (
    <>
        <Header
            card={card}
            leading={<Mark icon={DollarCircleIcon} className="font-color-secondary" />}
            detail={<span title={card.title}>{card.title}</span>}
            detailClassName="font-color-primary"
        />
        <div className="beaver-run-status-popup__body font-color-secondary">{card.message}</div>
        <div className="beaver-run-status-popup__footer">
            <div className="flex-1" />
            <Button
                variant="outline"
                style={FOOTER_BUTTON_STYLE}
                onClick={() => card.onDecide(false)}
                disabled={card.decideDisabled}
            >
                {card.declineLabel}
            </Button>
            <Button
                data-run-status-approve
                variant="solid"
                style={FOOTER_BUTTON_STYLE}
                onClick={() => card.onDecide(true)}
                disabled={card.decideDisabled}
            >
                {card.approveLabel}
            </Button>
        </div>
    </>
);

/**
 * The batch is approved right here, with the same card the composer shows
 * for it: the backend's title, scope, goal and warnings, the coverage choice,
 * and a field for instructions. The card names the batch itself, so it
 * stands without the popup's header — and without a close button: the run
 * is blocked on this decision, and Cancel is the way out of it. Keyed on the
 * request so a new one starts from a fresh draft.
 *
 * Its controls are all buttons, links and fields, which the card's click
 * handler leaves alone on its own, so the copy around them still opens
 * Beaver like any other card's background.
 */
const BatchView: React.FC<{ card: BatchCard }> = ({ card }) => (
    <div className="beaver-run-status-popup__embedded">
        <BatchApprovalCard
            key={card.approval.approvalId}
            approval={card.approval}
            onSubmit={card.onSubmit}
        />
    </div>
);

/**
 * The question is answered right here, with the same card the composer shows
 * for it. Without Stop: a corner popup is not the place to abandon a run.
 */
const QuestionView: React.FC<{ card: QuestionCard }> = ({ card }) => (
    <>
        <Header
            card={card}
            leading={<Mark icon={HelpCircleIcon} className="font-color-secondary" />}
            detail={null}
        />
        <div className="beaver-run-status-popup__embedded beaver-run-status-popup__embedded--own-clicks" data-run-status-popup-interactive>
            <AskUserQuestionCard
                key={card.question.questionId}
                pendingQuestion={card.question}
                onSubmit={card.onSubmit}
            />
        </div>
    </>
);

/** The error outcome wears the run error display's icon; a clean finish, a check. */
const COMPLETED_MARK: Record<CompletedCard['outcome'], { icon: React.FC<React.SVGProps<SVGSVGElement>>; className: string }> = {
    completed: { icon: CheckmarkCircleIcon, className: 'font-color-green' },
    error: { icon: AlertIcon, className: 'font-color-red' },
    canceled: { icon: AlertIcon, className: 'font-color-secondary' },
};

const CompletedView: React.FC<{ card: CompletedCard }> = ({ card }) => {
    const mark = COMPLETED_MARK[card.outcome];
    const hasRows = card.artifacts.length > 0 || card.changes !== null;
    return (
        <>
            <Header
                card={card}
                leading={<Mark icon={mark.icon} className={mark.className} />}
                detail={card.detail}
            />
            {hasRows && (
                <div className="beaver-run-status-popup__rows">
                    {card.artifacts.map((artifact) => (
                        <button
                            key={artifact.key}
                            type="button"
                            className="beaver-run-status-popup__row"
                            onClick={artifact.open ?? card.onOpen}
                            title={artifact.title ?? artifact.label}
                        >
                            <Icon icon={getAgentActionToolIcon(artifact.actionType)} className="font-color-secondary" />
                            <span className="beaver-run-status-popup__row-text">
                                <span className="font-color-primary font-medium">{artifact.label}</span>
                                {artifact.title && <span className="font-color-secondary"> {artifact.title}</span>}
                            </span>
                            <Icon icon={ArrowUpRightIcon} className="font-color-tertiary beaver-run-status-popup__row-arrow" />
                        </button>
                    ))}
                    {card.hiddenArtifactCount > 0 && (
                        <button type="button" className="beaver-run-status-popup__row" onClick={card.onOpen}>
                            <span className="beaver-run-status-popup__row-text font-color-secondary">
                                {`+${card.hiddenArtifactCount} more`}
                            </span>
                        </button>
                    )}
                    {card.changes !== null && (
                        <button type="button" className="beaver-run-status-popup__row" onClick={card.onReviewChanges}>
                            <Icon icon={LibraryIcon} className="font-color-secondary" />
                            <span className="beaver-run-status-popup__row-text beaver-run-status-popup__row-text--fixed font-color-primary">Review library changes</span>
                            {card.changes && (
                                <span className="beaver-run-status-popup__row-trail font-color-tertiary" title={card.changes}>
                                    {card.changes}
                                </span>
                            )}
                        </button>
                    )}
                </div>
            )}
            <div className="beaver-run-status-popup__footer">
                <div className="flex-1" />
                <Button variant="outline" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowUpRightIcon} onClick={card.onOpen}>
                    Open Beaver
                </Button>
            </div>
        </>
    );
};

/** The cards that draw the run's batch progress: the run is working, or waiting on one of its changes. */
function showsBatchProgress(card: RunStatusPopupCard): boolean {
    return card.kind === 'running' || card.kind === 'approval';
}

const CardView: React.FC<{ card: RunStatusPopupCard } & WithBatchProgress> = ({ card, batchProgress }) => {
    switch (card.kind) {
        case 'running': return <RunningView card={card} batchProgress={batchProgress} />;
        case 'approval': return <ApprovalView card={card} batchProgress={batchProgress} />;
        case 'credit': return <CreditView card={card} />;
        case 'batch': return <BatchView card={card} />;
        case 'question': return <QuestionView card={card} />;
        case 'completed': return <CompletedView card={card} />;
    }
};

/**
 * The card's frame, sized to its content through a measured height so a
 * change of state grows or shrinks it smoothly rather than snapping. The
 * first paint is not animated: a card appearing should not unfold from zero.
 */
const AnimatedCard: React.FC<{ card: RunStatusPopupCard; children: React.ReactNode }> = ({ card, children }) => {
    const cardRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const element = cardRef.current;
        if (element?.ownerDocument.hasFocus() && element.ownerDocument.activeElement === element) {
            element.querySelector<HTMLElement>('[data-run-status-approve]:not(:disabled)')?.focus();
        }
    }, [card.kind]);
    const [height, setHeight] = useState<number | null>(null);
    // The height as last measured, so a measurement that finds it unchanged
    // does not reach the setter: a setter called with the current value still
    // schedules a re-render while the component has a store update pending.
    const heightRef = useRef<number | null>(null);
    const [settled, setSettled] = useState(false);
    const observed = useRef<{ element: HTMLElement; disconnect: () => void } | null>(null);

    // Measurement is subscribed to the content element: its size changes with
    // every state the card moves through and with content arriving on its own
    // (a tool label's item name), and the observer reports both from the
    // browser's layout pass rather than after each render. The first
    // measurement is taken as the element attaches, so the card is drawn at
    // its height from the start.
    const innerRef = useCallback((inner: HTMLDivElement | null) => {
        if (observed.current?.element === inner) return;
        observed.current?.disconnect();
        observed.current = null;
        if (!inner) return;
        const win = inner.ownerDocument.defaultView;
        if (!win) return;
        const measure = () => {
            const next = inner.getBoundingClientRect().height;
            if (next === heightRef.current) return;
            heightRef.current = next;
            setHeight(next);
        };
        measure();
        // Second frame: the first measurement is drawn without a transition,
        // and every change after it is animated.
        const frame = win.requestAnimationFrame(() => setSettled(true));
        const observer = new win.ResizeObserver(measure);
        observer.observe(inner);
        observed.current = {
            element: inner,
            disconnect: () => {
                win.cancelAnimationFrame(frame);
                observer.disconnect();
            },
        };
    }, []);

    const handleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (isCardBackgroundClick(event)) card.onOpen();
    }, [card]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget || event.defaultPrevented || isImeKeyEvent(event.nativeEvent) || event.repeat) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            card.onOpen();
        }
    }, [card]);

    return (
        <div
            ref={cardRef}
            className={`beaver-run-status-popup__card beaver-run-status-popup__card--${card.kind} ${settled ? 'beaver-run-status-popup__card--settled' : ''}`}
            style={{ height: height ?? undefined }}
            role="button"
            tabIndex={0}
            aria-label={`Open Beaver: ${card.threadName}`}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
        >
            <div ref={innerRef} className="beaver-run-status-popup__content">
                {children}
            </div>
        </div>
    );
};

/**
 * The status of the open thread's run, drawn in the corner of the main window
 * while the sidebar is closed: what the run is doing, the decision it is
 * waiting on with the controls to make it, or what it finished with.
 *
 * Always mounted, so the completion tracking in the hook sees a run finish
 * whether or not a card is up; it draws nothing while the sidebar is open.
 */
const RunStatusPopup: React.FC = () => {
    const card = useRunStatusPopupCard();
    const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);
    const forceVisible = useAtomValue(runStatusPopupForceVisibleAtom);

    // Expansion of the batch progress lives here rather than in the panel:
    // the card that holds the panel is swapped as the run moves between
    // working and waiting on a change, and the panel with it. It is kept
    // for the run it was opened on, so the next run starts collapsed.
    const [batchExpansion, setBatchExpansion] = useState<{ runId: string; expanded: boolean } | null>(null);

    if (!card || (isSidebarVisible && !forceVisible)) return null;

    // The panel draws nothing without a batch in flight, and the wrapper is
    // hidden with it (see the stylesheet), so a run without a batch does not
    // pay for the slot.
    const batchExpanded = batchExpansion?.runId === card.runId && batchExpansion.expanded;
    const batchProgress = showsBatchProgress(card) ? (
        <div className="beaver-run-status-popup__batch-progress" data-run-status-popup-interactive>
            <BatchProgressPanel
                expanded={batchExpanded}
                onExpandedChange={(expanded) => setBatchExpansion({ runId: card.runId, expanded })}
            />
        </div>
    ) : null;

    // Layers behind the front card stand for the other threads still
    // running. The count is capped by the model; each layer is a sliver.
    const layers = Array.from({ length: card.stackDepth }, (_, index) => index + 1);

    return (
        <div className="beaver-run-status-popup" data-stack-depth={card.stackDepth}>
            {layers.map((depth) => (
                <div
                    key={depth}
                    className="beaver-run-status-popup__layer"
                    style={{ '--beaver-stack-depth': depth } as React.CSSProperties}
                    aria-hidden="true"
                />
            ))}
            <AnimatedCard card={card}>
                <CardView card={card} batchProgress={batchProgress} />
            </AnimatedCard>
        </div>
    );
};

export default RunStatusPopup;
