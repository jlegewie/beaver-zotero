import React from 'react';
import { useAtomValue } from 'jotai';
import type { TableCardCost } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { TableFillPricing } from '@beaver/agent-core/protocol/tableFillProtocol';
import { costCredits, costLine } from '@beaver/agent-core/run-state/tableCardDraft';
import { balanceLine, pricingSentence } from '@beaver/agent-core/run-state/tableFillCopy';
import { profileWithPlanAtom, remainingBeaverCreditsAtom } from '../../../atoms/profile';

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

export interface TableCardCostBlockProps {
    cost: TableCardCost;
    /** The count is not exact: the user edited the sources. */
    upperBound?: boolean;
    prices: TableFillPricing | null;
}

/**
 * A card's cost, as the tab's Fill popover shows a plan: the row line, the
 * credits, how far the balance reaches when the fill costs more, and the
 * pricing sentence. The fill's credits are its own, charged per paper.
 */
const TableCardCostBlock: React.FC<TableCardCostBlockProps> = ({ cost, upperBound = false, prices }) => {
    const profile = useAtomValue(profileWithPlanAtom);
    const remaining = useAtomValue(remainingBeaverCreditsAtom);
    const balance = profile ? remaining : null;
    const reach = upperBound
        ? null
        : balanceLine({
              credits: cost.credits,
              balance,
              documents: cost.documents,
              title_abstract: cost.title_abstract,
              prices: prices ?? { document: cost.credits, title_abstract: cost.credits },
          });
    return (
        <div className="table-card-cost display-flex flex-col text-sm font-color-secondary" style={{ gap: '0.15rem' }}>
            <span>{costLine(cost, upperBound)}</span>
            <span className="font-color-primary">{costCredits(cost, upperBound)}</span>
            {reach && <span>{reach}</span>}
            {prices && <span className="opacity-80">{pricingSentence(prices, cost.title_abstract)}</span>}
        </div>
    );
};

export default TableCardCostBlock;
