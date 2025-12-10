import React, { useState } from 'react';
import { SearchExternalReferencesResult } from '../../agents/toolResultTypes';
import ExternalReferenceListItem from '../externalReferences/ExternalReferenceListItem';

interface ExternalReferencesSearchResultViewProps {
    result: SearchExternalReferencesResult;
}

/**
 * Renders the result of an external references search tool (search_external_references).
 * Uses ExternalReferenceListItem to display the references.
 */
export const ExternalReferencesSearchResultView: React.FC<ExternalReferencesSearchResultViewProps> = ({ result }) => {
    const [hoveredItemIndex, setHoveredItemIndex] = useState<number | null>(null);

    if (result.references.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No external references found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {result.references.map((item, index) => (
                <ExternalReferenceListItem
                    key={index}
                    item={item}
                    isHovered={hoveredItemIndex === index}
                    onMouseEnter={() => setHoveredItemIndex(index)}
                    onMouseLeave={() => setHoveredItemIndex(null)}
                />
            ))}
        </div>
    );
};

export default ExternalReferencesSearchResultView;

