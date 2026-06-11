import React from 'react';
import { ZoteroItemReference } from '../../types/zotero';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { logger } from '../../../src/utils/logger';
import { AnnotationTooltip, getAnnotationTooltipIcon, getAnnotationTypeLabel } from './AnnotationTooltip';

export interface ResolvedAnnotation {
    ref: ZoteroItemReference;
    item: Zotero.Item;
    type: string | undefined;
    text: string;
    comment: string;
    color: string | undefined;
    pageLabel: string;
    sourceDisplayName: string;
    tags: string[];
}

export type AnnotationRowVariant = 'compact' | 'with-parent';

/**
 * Map a Zotero annotation type to the matching Zotero skin icon.
 */
function getAnnotationIcon(type: string | undefined): string {
    switch (type) {
        case 'highlight':
            return ZOTERO_ICONS.ANNOTATE_HIGHLIGHT;
        case 'underline':
            return ZOTERO_ICONS.ANNOTATE_UNDERLINE;
        case 'note':
            return ZOTERO_ICONS.ANNOTATION;
        case 'image':
            return ZOTERO_ICONS.ANNOTATE_AREA;
        case 'text':
            return ZOTERO_ICONS.ANNOTATE_TEXT;
        default:
            return ZOTERO_ICONS.ANNOTATION;
    }
}

/**
 * Resolve the source display name for an annotation, using the bibliographic
 * parent when available and the attachment itself for standalone attachments.
 */
export async function getAnnotationSourceDisplayName(annotation: Zotero.Item): Promise<string> {
    const attachment = annotation.parentID
        ? await Zotero.Items.getAsync(annotation.parentID)
        : null;
    if (!attachment) return '';

    const sourceItem = attachment.parentID
        ? await Zotero.Items.getAsync(attachment.parentID) ?? attachment
        : attachment;

    try {
        await sourceItem.loadDataType('itemData');
        if (sourceItem.isRegularItem()) {
            await sourceItem.loadDataType('creators');
        }
    } catch {
        logger(`annotationListShared: failed to load source display data for ${sourceItem.libraryID}-${sourceItem.key}`, 1);
    }

    try {
        return getDisplayNameFromItem(sourceItem) || sourceItem.getDisplayTitle?.() || sourceItem.key || '';
    } catch {
        return sourceItem.getDisplayTitle?.() || sourceItem.key || '';
    }
}

/**
 * Resolve one annotation reference against the local Zotero database.
 */
export async function resolveAnnotationRef(
    ref: ZoteroItemReference,
    item?: Zotero.Item | null
): Promise<ResolvedAnnotation | null> {
    try {
        const resolvedItem = item ?? await Zotero.Items.getByLibraryAndKeyAsync(
            ref.library_id,
            ref.zotero_key
        );
        if (!resolvedItem || !resolvedItem.isAnnotation()) return null;

        await resolvedItem.loadDataType('itemData');
        await resolvedItem.loadDataType('tags');

        return {
            ref,
            item: resolvedItem,
            type: resolvedItem.annotationType,
            text: resolvedItem.annotationText ?? '',
            comment: resolvedItem.annotationComment ?? '',
            color: resolvedItem.annotationColor ?? undefined,
            pageLabel: resolvedItem.annotationPageLabel ?? '',
            sourceDisplayName: await getAnnotationSourceDisplayName(resolvedItem),
            tags: (resolvedItem.getTags?.() ?? []).map(t => t.tag),
        };
    } catch (error) {
        logger(`annotationListShared: failed to resolve ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
        return null;
    }
}

/**
 * Resolve annotation references in order, skipping entries that are not annotations.
 */
export async function resolveAnnotationRefs(
    refs: ZoteroItemReference[]
): Promise<ResolvedAnnotation[]> {
    const items: ResolvedAnnotation[] = [];
    for (const ref of refs) {
        const resolved = await resolveAnnotationRef(ref);
        if (resolved) items.push(resolved);
    }
    return items;
}

interface AnnotationRowProps {
    annotation: ResolvedAnnotation;
    variant: AnnotationRowVariant;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onClick: () => void;
}

export const AnnotationRow: React.FC<AnnotationRowProps> = ({
    annotation,
    variant,
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
    const pageText = annotation.pageLabel ? `Page ${annotation.pageLabel}` : '';
    const sourceLine = [annotation.sourceDisplayName, pageText].filter(Boolean).join(', ');
    const tooltipBody = [annotation.text, annotation.comment].filter(Boolean).join('\n\n');

    const row = (
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
                {variant === 'with-parent' ? (
                    <>
                        <div
                            className={`text-base truncate min-w-0 ${
                                hasText || annotation.comment ? 'font-color-secondary' : 'font-color-tertiary italic'
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
                                hasText || annotation.comment ? 'font-color-secondary' : 'font-color-tertiary italic'
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
            typeLabel={getAnnotationTypeLabel(annotation.type)}
            pageDisplay={annotation.pageLabel}
            body={tooltipBody || primary}
            footerLabel="Click to view in PDF"
            typeIcon={getAnnotationTooltipIcon(annotation.type)}
            stayOpenOnAnchorClick
        >
            {row}
        </AnnotationTooltip>
    );
};
