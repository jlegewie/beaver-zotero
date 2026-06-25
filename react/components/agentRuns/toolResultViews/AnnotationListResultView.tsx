import React, { useState } from 'react';
import { AnnotationListView } from '../../../types/toolResultViews';
import { AnnotationResultRow } from './AnnotationResultRow';

/**
 * Shared renderer for the {@link AnnotationListView} view model
 * (get_annotations / find_annotations).
 *
 * The list-level `variant` controls whether rows show source context or just an
 * inline page label. Row clicks open annotations through the navigation host.
 */
export const AnnotationListResultView: React.FC<{ view: AnnotationListView }> = ({ view }) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    if (view.annotations.length === 0) {
        return (
            <div className="p-3 text-sm font-color-secondary">
                No annotations found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col min-w-0">
            {view.annotations.map((row, index) => {
                const key = `${row.library_id}-${row.zotero_key}-${index}`;
                return (
                    <AnnotationResultRow
                        key={key}
                        row={row}
                        variant={view.variant}
                        isHovered={hoveredKey === key}
                        onMouseEnter={() => setHoveredKey(key)}
                        onMouseLeave={() => setHoveredKey(null)}
                    />
                );
            })}
        </div>
    );
};

export default AnnotationListResultView;
