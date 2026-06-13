import React, { useState } from 'react';
import { LookupWorkViewData } from '../../agents/toolResultTypes';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';

type LookupWorkResultViewProps = LookupWorkViewData;

/**
 * Renders lookup_work results: matched external references plus queries that
 * did not resolve to a work.
 */
export const LookupWorkResultView: React.FC<LookupWorkResultViewProps> = ({
    foundCount,
    references,
    notFoundQueries,
    temporarilyUncheckedQueries,
    message,
}) => {
    const [hoveredItemIndex, setHoveredItemIndex] = useState<number | null>(null);

    if (
        foundCount === 0 &&
        references.length === 0 &&
        notFoundQueries.length === 0 &&
        temporarilyUncheckedQueries.length === 0
    ) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                {message || 'No works found'}
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {references.map((item, index) => (
                <ExternalReferenceListItem
                    key={item.source_id ?? index}
                    item={item}
                    isHovered={hoveredItemIndex === index}
                    onMouseEnter={() => setHoveredItemIndex(index)}
                    onMouseLeave={() => setHoveredItemIndex(null)}
                />
            ))}

            {notFoundQueries.map((query, index) => (
                <div
                    key={`not-found-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — not found</span>
                </div>
            ))}

            {temporarilyUncheckedQueries.map((query, index) => (
                <div
                    key={`unchecked-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — lookup unavailable</span>
                </div>
            ))}
        </div>
    );
};

export default LookupWorkResultView;
