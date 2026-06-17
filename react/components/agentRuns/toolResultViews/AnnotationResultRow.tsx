import React from 'react';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { AnnotationTooltip, getAnnotationTooltipIcon, getAnnotationTypeLabel } from '../AnnotationTooltip';
import { AnnotationRowView } from '../../../types/toolResultViews';
import { getHost } from '../../../host';

/**
 * Shared, client-agnostic annotation row rendered from an {@link AnnotationRowView}.
 *
 * Used by both the standalone annotation list (get_annotations / find_annotations)
 * and the annotation rows an item list can contain (get_metadata). The row opens
 * the annotation through the navigation host.
 *
 * The tooltip shows the type, page, and a body of `text`/`comment`. Those fields
 * carry a bounded preview, not the full annotation body.
 */

/** Variant for source context vs. inline page label. */
export type AnnotationRowVariant = 'compact' | 'with-parent';

/** Annotation glyph by type (Zotero skin icons). */
function annotationGlyph(type: string | null | undefined): string {
    switch (type) {
        case 'highlight':
            return ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
        case 'underline':
            return ZOTERO_ICONS.ANNOTATE_UNDERLINE;
        case 'image':
            return ZOTERO_ICONS.ANNOTATE_AREA;
        case 'text':
            return ZOTERO_ICONS.ANNOTATE_TEXT;
        case 'note':
        default:
            return ZOTERO_ICONS.ANNOTATION;
    }
}

interface AnnotationResultRowProps {
    row: AnnotationRowView;
    variant: AnnotationRowVariant;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    footerLabel?: string;
}

export const AnnotationResultRow: React.FC<AnnotationResultRowProps> = ({
    row,
    variant,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    footerLabel = 'Click to view in PDF',
}) => {
    const placeholder = row.annotation_type
        ? `${row.annotation_type.charAt(0).toUpperCase()}${row.annotation_type.slice(1)} annotation`
        : 'Annotation';
    const primary = row.text || row.comment || placeholder;
    const hasText = Boolean(row.text);
    const pageText = row.page_label ? `Page ${row.page_label}` : '';
    const sourceLine = [row.source_display_name, pageText].filter(Boolean).join(', ');
    const tooltipBody = [row.text, row.comment].filter(Boolean).join('\n\n');

    const handleClick = () => {
        getHost().navigation?.openAnnotation({ library_id: row.library_id, zotero_key: row.zotero_key });
    };

    const node = (
        <div
            className={`display-flex flex-row items-start gap-2 px-25 py-2 cursor-pointer rounded-sm transition user-select-none ${isHovered ? 'bg-quinary' : ''}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <ZoteroIcon
                icon={annotationGlyph(row.annotation_type)}
                size={14}
                color={row.color ?? undefined}
                className="flex-shrink-0 mt-020"
            />
            <div className="display-flex flex-col flex-1 min-w-0 gap-05">
                {variant === 'with-parent' ? (
                    <>
                        <div
                            className={`text-base truncate min-w-0 ${
                                hasText || row.comment ? 'font-color-secondary' : 'font-color-tertiary italic'
                            }`}
                        >
                            {primary}
                        </div>
                        {sourceLine && (
                            <div className="font-color-secondary text-sm truncate min-w-0">
                                {sourceLine}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="display-flex flex-row items-baseline gap-2 min-w-0">
                        <div
                            className={`text-base truncate min-w-0 flex-1 ${
                                hasText || row.comment ? 'font-color-secondary' : 'font-color-tertiary italic'
                            }`}
                        >
                            {primary}
                        </div>
                        {pageText && (
                            <div className="font-color-tertiary text-base whitespace-nowrap">
                                {pageText}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <AnnotationTooltip
            typeLabel={getAnnotationTypeLabel(row.annotation_type ?? undefined)}
            pageDisplay={row.page_label}
            body={tooltipBody || primary}
            footerLabel={footerLabel}
            typeIcon={getAnnotationTooltipIcon(row.annotation_type ?? undefined)}
            stayOpenOnAnchorClick
        >
            {node}
        </AnnotationTooltip>
    );
};

export default AnnotationResultRow;
