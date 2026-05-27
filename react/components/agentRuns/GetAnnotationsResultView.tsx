import React, { useState, useEffect } from 'react';
import { ZoteroItemReference } from '../../types/zotero';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { logger } from '../../../src/utils/logger';

interface GetAnnotationsResultViewProps {
    annotations: ZoteroItemReference[];
    totalCount: number;
}

interface ResolvedAnnotation {
    ref: ZoteroItemReference;
    item: Zotero.Item;
    type: string | undefined;
    text: string;
    comment: string;
    color: string | undefined;
    pageLabel: string;
    tags: string[];
}

/**
 * Map a Zotero annotation type to the matching Zotero skin icon.
 * Falls back to the generic ANNOTATION icon for unknown types.
 */
function getAnnotationIcon(type: string | undefined): string {
    switch (type) {
        case 'highlight':
            return ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
        case 'underline':
            return ZOTERO_ICONS.ANNOTATE_UNDERLINE;
        case 'note':
            return ZOTERO_ICONS.ANNOTATION;
            // return ZOTERO_ICONS.ANNOTATE_NOTE;
        case 'image':
            return ZOTERO_ICONS.ANNOTATE_AREA;
        case 'text':
            return ZOTERO_ICONS.ANNOTATE_TEXT;
        default:
            return ZOTERO_ICONS.ANNOTATION;
    }
}

interface AnnotationRowProps {
    annotation: ResolvedAnnotation;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onClick: () => void;
}

const AnnotationRow: React.FC<AnnotationRowProps> = ({
    annotation,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    onClick,
}) => {
    const icon = getAnnotationIcon(annotation.type);
    const placeholder = annotation.type
        ? `${annotation.type.charAt(0).toUpperCase()}${annotation.type.slice(1)} annotation`
        : 'Annotation';
    const primary = annotation.text || annotation.comment || placeholder;
    const hasText = Boolean(annotation.text);

    return (
        <div
            className={`display-flex flex-row items-start gap-2 px-25 py-2 cursor-pointer rounded-sm transition user-select-none ${isHovered ? 'bg-quinary' : ''}`}
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <ZoteroIcon
                icon={icon}
                size={14}
                color={annotation.color}
                className="flex-shrink-0 mt-020"
            />
            <div className="display-flex flex-col flex-1 min-w-0 gap-05">
                <div className="display-flex flex-row items-baseline gap-2 min-w-0">
                    <div
                        className={`text-base truncate min-w-0 flex-1 ${
                            hasText || annotation.comment ? 'font-color-secondary' : 'font-color-tertiary italic'
                        }`}
                    >
                        {primary}
                    </div>
                    {annotation.pageLabel && (
                        <div className="font-color-tertiary text-base whitespace-nowrap">
                            Page {annotation.pageLabel}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

/**
 * Renders the result of a get_annotations tool call.
 *
 * The backend dehydrates this tool's result and ships only ZoteroItemReference
 * entries in `metadata.summary.annotations`. We resolve each reference against
 * the local Zotero database to read its type, color, text, comment, page label
 * and tags. Clicking a row opens the annotation in the Zotero reader.
 */
export const GetAnnotationsResultView: React.FC<GetAnnotationsResultViewProps> = ({
    annotations,
    totalCount,
}) => {
    const [resolved, setResolved] = useState<ResolvedAnnotation[]>([]);
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const resolve = async () => {
            const items: ResolvedAnnotation[] = [];
            for (const ref of annotations) {
                try {
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        ref.library_id,
                        ref.zotero_key
                    );
                    if (!item || !item.isAnnotation()) continue;
                    items.push({
                        ref,
                        item,
                        type: item.annotationType,
                        text: item.annotationText ?? '',
                        comment: item.annotationComment ?? '',
                        color: item.annotationColor ?? undefined,
                        pageLabel: item.annotationPageLabel ?? '',
                        tags: (item.getTags?.() ?? []).map(t => t.tag),
                    });
                } catch (error) {
                    logger(`GetAnnotationsResultView: failed to resolve ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
                }
            }
            if (!cancelled) setResolved(items);
        };
        resolve();
        return () => { cancelled = true; };
    }, [annotations]);

    if (annotations.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No annotations found
            </div>
        );
    }

    const handleClick = async (annotation: ResolvedAnnotation) => {
        try {
            await navigateToAnnotation(annotation.item);
        } catch (error) {
            logger(`GetAnnotationsResultView: failed to navigate to ${annotation.ref.library_id}-${annotation.ref.zotero_key}: ${error}`, 1);
        }
    };

    return (
        <div className="display-flex flex-col min-w-0">
            {resolved.map((annotation) => {
                const key = `${annotation.ref.library_id}-${annotation.ref.zotero_key}`;
                return (
                    <AnnotationRow
                        key={key}
                        annotation={annotation}
                        isHovered={hoveredId === key}
                        onMouseEnter={() => setHoveredId(key)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={() => handleClick(annotation)}
                    />
                );
            })}
            {totalCount > annotations.length && (
                <div className="px-25 py-2 text-xs font-color-tertiary border-top-quinary">
                    Showing {annotations.length} of {totalCount} annotations
                </div>
            )}
        </div>
    );
};

export default GetAnnotationsResultView;
