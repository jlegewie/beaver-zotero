import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

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
    LayersIcon,
    LibraryIcon,
} from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import RunPermissionButton from '../ui/buttons/RunPermissionButton';
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
    return !target?.closest('button, a, [role="menu"], [role="menuitem"], [role="menuitemradio"]');
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

const RunningView: React.FC<{ card: RunningCard }> = ({ card }) => (
    <Header
        card={card}
        leading={<RunPulse />}
        detail={<StatusLine text={card.statusLine} />}
    />
);

const ApprovalView: React.FC<{ card: ApprovalCard }> = ({ card }) => (
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

const BatchView: React.FC<{ card: BatchCard }> = ({ card }) => (
    <>
        <Header
            card={card}
            leading={<Mark icon={LayersIcon} className="font-color-secondary" />}
            detail={<span title={card.title}>{card.title}</span>}
            detailClassName="font-color-primary"
        />
        {card.scope && <div className="beaver-run-status-popup__body font-color-secondary">{card.scope}</div>}
        <div className="beaver-run-status-popup__footer">
            <span className="font-color-tertiary text-sm">Approve in Beaver</span>
            <div className="flex-1" />
            <Button variant="solid" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowUpRightIcon} onClick={card.onOpen}>
                Review
            </Button>
        </div>
    </>
);

const QuestionView: React.FC<{ card: QuestionCard }> = ({ card }) => (
    <>
        <Header
            card={card}
            leading={<Mark icon={HelpCircleIcon} className="font-color-secondary" />}
            detail={<span title={card.title}>{card.title}</span>}
            detailClassName="font-color-primary"
        />
        <div className="beaver-run-status-popup__footer">
            <div className="flex-1" />
            <Button variant="solid" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowUpRightIcon} onClick={card.onOpen}>
                Answer
            </Button>
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

const CardView: React.FC<{ card: RunStatusPopupCard }> = ({ card }) => {
    switch (card.kind) {
        case 'running': return <RunningView card={card} />;
        case 'approval': return <ApprovalView card={card} />;
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
    const innerRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<number | null>(null);
    const [settled, setSettled] = useState(false);

    const measure = useCallback(() => {
        const inner = innerRef.current;
        if (inner) setHeight(inner.getBoundingClientRect().height);
    }, []);

    // Measured in the same frame the new state is laid out, so the transition
    // starts at once; the observer below covers the content changing on its
    // own afterwards (a tool label's item name arriving).
    useLayoutEffect(measure, [card, measure]);

    useLayoutEffect(() => {
        const inner = innerRef.current;
        const win = inner?.ownerDocument.defaultView;
        if (!inner || !win) return;
        // Second frame: the first measurement is drawn without a transition,
        // and every change after it is animated.
        const frame = win.requestAnimationFrame(() => setSettled(true));
        const observer = new win.ResizeObserver(measure);
        observer.observe(inner);
        return () => {
            win.cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [measure]);

    const handleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (isCardBackgroundClick(event)) card.onOpen();
    }, [card]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            card.onOpen();
        }
    }, [card]);

    return (
        <div
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

    if (!card || (isSidebarVisible && !forceVisible)) return null;

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
                <CardView card={card} />
            </AnimatedCard>
        </div>
    );
};

export default RunStatusPopup;
