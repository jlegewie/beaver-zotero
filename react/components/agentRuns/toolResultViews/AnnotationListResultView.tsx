import React, { useState } from 'react';
import {
    AnnotationListView,
    AnnotationRowView,
} from '../../../types/toolResultViews';
import { AnnotationResultRow } from './AnnotationResultRow';

/**
 * The annotation rows shared by tool results and annotation action previews.
 */
export const AnnotationResultList: React.FC<{
    annotations: AnnotationRowView[];
    variant: AnnotationListView['variant'];
    emptyMessage?: string | null;
}> = ({ annotations, variant, emptyMessage = 'No annotations found' }) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    if (annotations.length === 0) {
        return emptyMessage ? (
            <div className="p-3 text-sm font-color-secondary">
                {emptyMessage}
            </div>
        ) : null;
    }

    return (
        <div className="display-flex flex-col min-w-0">
            {annotations.map((row, index) => {
                const key = `${row.library_id}-${row.zotero_key}-${index}`;
                return (
                    <AnnotationResultRow
                        key={key}
                        row={row}
                        variant={variant}
                        isHovered={hoveredKey === key}
                        onMouseEnter={() => setHoveredKey(key)}
                        onMouseLeave={() => setHoveredKey(null)}
                    />
                );
            })}
        </div>
    );
};

/**
 * Shared renderer for the {@link AnnotationListView} view model
 * (get_annotations / find_annotations).
 *
 * The list-level `variant` controls whether rows show source context or just an
 * inline page label. Row clicks open annotations through the navigation host.
 */
export const AnnotationListResultView: React.FC<{
    view: AnnotationListView;
}> = ({ view }) => (
    <AnnotationResultList
        annotations={view.annotations}
        variant={view.variant}
    />
);

export default AnnotationListResultView;
