import React, { useState } from 'react';
import { ExternalReference } from '../../types/externalReferences';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';

interface ExternalSearchResultViewProps {
    references: ExternalReference[];
}

/**
 * Renders the result of an external search tool (external_search, search_external_references).
 * Uses ExternalReferenceListItem to display the references.
 */
export const ExternalSearchResultView: React.FC<ExternalSearchResultViewProps> = ({ references }) => {
    const [hoveredItemIndex, setHoveredItemIndex] = useState<number | null>(null);

    if (references.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No external references found
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
        </div>
    );
};

export default ExternalSearchResultView;

