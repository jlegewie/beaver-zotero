import React from 'react';
import { useAtomValue } from 'jotai';
import type { TableCardCost } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { TableFillPricing } from '@beaver/agent-core/protocol/tableFillProtocol';
import { balanceNotice, costBreakdown, costNotice, costReceipt } from '@beaver/agent-core/run-state/tableCardDraft';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { profileWithPlanAtom, remainingBeaverCreditsAtom } from '../../../atoms/profile';
import { Icon, InformationCircleIcon, SecurityWarningIcon } from '../../icons/icons';
import { openPreferencesWindow } from '../../../ui/openPreferencesWindow';
import { useSurfaceWindow } from '../../../runtime/SurfaceWindowContext';

/** How long the card waits before asking for the prices again after a failure. */
const PRICING_RETRY_MS = 5_000;

/**
 * The prices fills are charged at, fetched by the fill service and cached for
 * the session; null until known. A failed fetch is retried while the card is
 * open, so a card that could not price an edit recovers on its own.
 */
export function useFillPricing(): TableFillPricing | null {
    const [prices, setPrices] = React.useState<TableFillPricing | null>(null);
    React.useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fetch = () => {
            const pending = Zotero.Beaver?.tableFills?.pricing();
            if (!pending) return;
            pending
                .then((value) => live && setPrices(value))
                .catch(() => {
                    if (live) timer = setTimeout(fetch, PRICING_RETRY_MS);
                });
        };
        fetch();
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, []);
    return prices;
}

/** The user's credit balance, or null while the profile is not loaded. */
export function useCreditBalance(): number | null {
    const profile = useAtomValue(profileWithPlanAtom);
    const remaining = useAtomValue(remainingBeaverCreditsAtom);
    return profile ? remaining : null;
}

/** Window heights at which a card's fill warnings scroll with its content. */
const SHORT_WINDOW_QUERY = '(max-height: 500px)';

/**
 * Whether the card's window is short. There the footer would leave the
 * card's content almost no room, so the fill warnings scroll at the end of
 * the content; the decision row and the controls stay pinned.
 */
export function useShortWindow(): boolean {
    const win = useSurfaceWindow();
    // Gecko's matchMedia may return null (for example in a hidden frame).
    const [short, setShort] = React.useState(() => win.matchMedia(SHORT_WINDOW_QUERY)?.matches ?? false);
    React.useEffect(() => {
        const query = win.matchMedia(SHORT_WINDOW_QUERY);
        if (!query) return;
        const update = () => setShort(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, [win]);
    return short;
}

export interface TableCardFillWarningsProps {
    cost: TableCardCost;
    prices: TableFillPricing | null;
    /** Rendered at the end of the card's scrolling content rather than in its footer. */
    inBody?: boolean;
}

/**
 * The bands for the two facts about a fill that change what the user does: a
 * balance that does not reach (with Add credits), and items without full
 * text. Renders nothing when neither applies.
 */
export const TableCardFillWarnings: React.FC<TableCardFillWarningsProps> = ({ cost, prices, inBody = false }) => {
    const balance = useCreditBalance();
    const balanceWarning = balanceNotice(cost, balance, prices);
    const readWarning = costNotice(cost);
    if (!balanceWarning && !readWarning) return null;
    const bands = (
        <>
            {balanceWarning && (
                <div className="table-card-footer-band table-card-footer-band-warning" role="alert">
                    <Icon icon={SecurityWarningIcon} className="table-card-warning-icon" />
                    <span className="table-card-notice-text">{balanceWarning}</span>
                    <button type="button" className="table-card-warning-action" onClick={() => openPreferencesWindow('billing')}>
                        Add credits
                    </button>
                </div>
            )}
            {readWarning && (
                <div className="table-card-footer-band table-card-footer-band-warning" role="status">
                    <Icon icon={SecurityWarningIcon} className="table-card-warning-icon" />
                    <span className="table-card-notice-text">{readWarning}</span>
                </div>
            )}
        </>
    );
    return inBody ? <div className="table-card-body-bands">{bands}</div> : bands;
};

export interface TableCardReceiptProps {
    cost: TableCardCost;
    /** The count is not exact: the user edited the sources. */
    upperBound?: boolean;
    prices: TableFillPricing | null;
    disabled?: boolean;
}

/**
 * The create card's receipt, beside its run checkbox: "12 papers · 2.1
 * credits", and an info button whose popover holds what is read once: how
 * many papers are read from full text, from their abstract or skipped, each
 * with its rate.
 */
export const TableCardReceipt: React.FC<TableCardReceiptProps> = ({ cost, upperBound = false, prices, disabled = false }) => {
    const { papers, credits } = costReceipt(cost, upperBound);
    const [open, setOpen] = React.useState(false);
    const [position, setPosition] = React.useState<{ bottom: number; right: number } | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    const popoverRef = React.useRef<HTMLDivElement | null>(null);
    const popoverId = React.useId();

    React.useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);

    // The card clips its overflow, so the popover is placed in the window,
    // above the button and aligned to its end. A click outside, Escape, a
    // scroll or a resize closes it.
    React.useLayoutEffect(() => {
        if (!open) {
            setPosition(null);
            return;
        }
        const button = buttonRef.current;
        const doc = button?.ownerDocument;
        const win = doc?.defaultView;
        if (!button || !doc || !win) return;
        const rect = button.getBoundingClientRect();
        setPosition({ bottom: win.innerHeight - rect.top + 6, right: Math.max(8, win.innerWidth - rect.right - 4) });
        const close = () => setOpen(false);
        const onPointer = (event: Event) => {
            const target = event.target as Node;
            if (!button.contains(target) && !popoverRef.current?.contains(target)) close();
        };
        const onKey = (event: KeyboardEvent) => {
            // A composing IME owns Escape: it dismisses the candidate list.
            if (event.key !== 'Escape' || isImeKeyEvent(event)) return;
            event.stopPropagation();
            close();
            button.focus();
        };
        doc.addEventListener('mousedown', onPointer, true);
        doc.addEventListener('keydown', onKey, true);
        win.addEventListener('resize', close);
        win.addEventListener('scroll', close, true);
        return () => {
            doc.removeEventListener('mousedown', onPointer, true);
            doc.removeEventListener('keydown', onKey, true);
            win.removeEventListener('resize', close);
            win.removeEventListener('scroll', close, true);
        };
    }, [open]);

    return (
        <>
            <span className="table-card-receipt">
                {papers} · <strong>{credits}</strong>
            </span>
            <button
                ref={buttonRef}
                type="button"
                className="table-card-receipt-info"
                aria-label="How this is priced"
                aria-expanded={open}
                aria-controls={open ? popoverId : undefined}
                disabled={disabled}
                onClick={() => setOpen((value) => !value)}
            >
                <Icon icon={InformationCircleIcon} />
            </button>
            {open && (
                <div
                    ref={popoverRef}
                    id={popoverId}
                    className="table-card-pricing-popover"
                    role="dialog"
                    aria-label="How this is priced"
                    style={position ? { bottom: position.bottom, right: position.right } : { visibility: 'hidden' }}
                >
                    <div className="table-card-pricing-rows">
                        {costBreakdown(cost, prices).map((row) => (
                            <React.Fragment key={row.label}>
                                <span className="table-card-pricing-label">{row.label}</span>
                                <span className="table-card-pricing-papers">{row.papers}</span>
                                <span className="table-card-pricing-rate">{row.rate ?? ''}</span>
                            </React.Fragment>
                        ))}
                    </div>
                    <p className="table-card-pricing-note">
                        {upperBound ? 'An estimate. Charged per item as it is filled.' : 'Charged per item as it is filled.'}
                    </p>
                </div>
            )}
        </>
    );
};
