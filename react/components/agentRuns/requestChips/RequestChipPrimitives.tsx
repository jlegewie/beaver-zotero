import React from 'react';
import { CSSIcon, CSSItemTypeIcon, LibraryIcon, NoteIcon, HighlighterIcon, ExternalLinkIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { getHost } from '../../../host';
import type { ZoteroItemReference } from '../../../types/zotero';
import type { ContentKind } from '../../../types/zotero';
import { truncateText } from '../../../utils/stringUtils';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import type { ValidAnnotationType, ExternalFileContentKind } from '../../../types/attachments/apiTypes';
import { ChipWithPopup, type ChipPopupContent, type ChipPopupSubtitle } from './ChipPopup';
import { ChipButton } from './ChipButton';

const MAX_CHIP_TEXT_LENGTH = 30;
const MAX_ANNOTATION_TOOLTIP_TEXT_LENGTH = 160;

function attachmentIconName(contentKind?: ContentKind | ExternalFileContentKind | null): string {
    switch (contentKind) {
        case 'pdf':
            return 'attachmentPDF';
        case 'epub':
            return 'attachmentEPUB';
        case 'snapshot':
            return 'attachmentSnapshot';
        case 'image':
            return 'attachmentImage';
        case 'text':
        default:
            return 'attachmentFile';
    }
}

export function ItemChip({
    label,
    itemType,
    contentKind,
    itemRef,
    isAttachment,
    subtitle,
}: {
    label?: string | null;
    itemType?: string | null;
    contentKind?: ContentKind | null;
    itemRef: ZoteroItemReference;
    isAttachment: boolean;
    subtitle?: ChipPopupSubtitle | null;
}) {
    const iconName = isAttachment ? attachmentIconName(contentKind) : itemType || 'document';
    const displayName = label || (isAttachment ? 'Attachment' : 'Item');
    return (
        <ChipWithPopup
            popup={{
                icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                title: displayName,
                subtitle,
                action: { icon: LibraryIcon, label: 'Reveal in library' },
            }}
        >
            <ChipButton onClick={() => getHost().navigation?.revealInLibrary(itemRef)}>
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
                <span className="truncate">
                    {truncateText(displayName, MAX_CHIP_TEXT_LENGTH)}
                </span>
            </ChipButton>
        </ChipWithPopup>
    );
}

export function AnnotationChip({
    annotationType,
    color,
    annotationRef,
    title,
}: {
    annotationType: ValidAnnotationType | string;
    color?: string;
    annotationRef: ZoteroItemReference;
    title?: string;
}) {
    const icon = ANNOTATION_ICON_BY_TYPE[annotationType] || ZOTERO_ICONS.ANNOTATION;
    const typeLabel = ANNOTATION_TEXT_BY_TYPE[annotationType] || 'Annotation';
    return (
        <ChipWithPopup
            popup={buildAnnotationChipPopup({ annotationType, color, title })}
        >
            <ChipButton onClick={() => getHost().navigation?.openAnnotation(annotationRef)}>
                <ZoteroIcon icon={icon} size={14} style={color ? { color } : undefined} />
                <span className="truncate">
                    {typeLabel}
                </span>
            </ChipButton>
        </ChipWithPopup>
    );
}

export function buildAnnotationChipPopup({
    annotationType,
    color,
    title,
}: {
    annotationType: ValidAnnotationType | string;
    color?: string;
    title?: string;
}): ChipPopupContent {
    const icon = ANNOTATION_ICON_BY_TYPE[annotationType] || ZOTERO_ICONS.ANNOTATION;
    const typeLabel = ANNOTATION_TEXT_BY_TYPE[annotationType] || 'Annotation';
    const tooltipText = title ? truncateText(title.replace(/\s+/g, ' ').trim(), MAX_ANNOTATION_TOOLTIP_TEXT_LENGTH) : '';
    return {
        icon: <ZoteroIcon icon={icon} size={16} style={color ? { color } : undefined} />,
        title: typeLabel,
        subtitle: tooltipText ? { text: tooltipText } : null,
        action: { icon: HighlighterIcon, label: 'Open annotation in PDF' },
    };
}

export function NoteChip({
    title,
    noteRef,
    subtitle,
}: {
    title?: string | null;
    noteRef: ZoteroItemReference;
    subtitle?: ChipPopupSubtitle | null;
}) {
    const displayName = title || 'Untitled Note';
    return (
        <ChipWithPopup
            popup={{
                icon: <CSSItemTypeIcon itemType="note" className="scale-90" />,
                title: displayName,
                subtitle,
                action: { icon: NoteIcon, label: 'Open note' },
            }}
        >
            <ChipButton onClick={() => getHost().navigation?.openSource(noteRef)}>
                <span className="scale-80">
                    <CSSItemTypeIcon itemType="note" />
                </span>
                <span className="truncate">
                    {truncateText(displayName, MAX_CHIP_TEXT_LENGTH)}
                </span>
            </ChipButton>
        </ChipWithPopup>
    );
}

export function CollectionChip({
    name,
    collectionRef,
    isFilter = false,
}: {
    name: string;
    collectionRef: ZoteroItemReference;
    /** True for collections used to scope the search (vs. an explicit attachment). */
    isFilter?: boolean;
}) {
    return (
        <ChipWithPopup
            popup={{
                icon: (
                    <span className="scale-90">
                        <CSSIcon name="collection" className="icon-16" />
                    </span>
                ),
                title: name,
                subtitle: { text: isFilter ? 'Search filter' : 'Collection' },
                action: { icon: LibraryIcon, label: 'Reveal in library' },
            }}
        >
            <ChipButton onClick={() => getHost().navigation?.revealCollection(collectionRef)}>
                <span className="scale-90">
                    <CSSIcon name="collection" className="icon-16" />
                </span>
                <span className="truncate">
                    {truncateText(name, 20)}
                </span>
            </ChipButton>
        </ChipWithPopup>
    );
}

export function LibraryChip({
    name,
    libraryId,
}: {
    name: string;
    libraryId: number;
}) {
    return (
        <ChipButton onClick={() => getHost().navigation?.revealLibrary(libraryId)}>
            <span className="scale-90">
                <CSSIcon name="library" className="icon-16" />
            </span>
            <span className="truncate">
                {truncateText(name, 20)}
            </span>
            <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
        </ChipButton>
    );
}

export function TagChip({
    tag,
    color,
}: {
    tag: string;
    color?: string | null;
}) {
    return (
        <ChipButton onClick={() => undefined}>
            <CSSIcon
                name="tag"
                className="icon-16 scale-80"
                style={color ? { color } : undefined}
            />
            <span className="truncate">
                {truncateText(tag, 20)}
            </span>
            <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
        </ChipButton>
    );
}

export function ExternalFileChip({
    extKey,
    filename,
    contentKind,
}: {
    extKey: string;
    filename: string;
    contentKind: ExternalFileContentKind;
}) {
    const iconName = attachmentIconName(contentKind);
    return (
        <ChipWithPopup
            popup={{
                icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                title: filename,
                subtitle: { text: 'External file' },
                action: { icon: ExternalLinkIcon, label: 'Open external file', iconClassName: 'scale-75' },
            }}
        >
            <ChipButton onClick={() => getHost().navigation?.launchExternalFile(extKey)}>
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
                <span className="truncate">
                    {truncateText(filename, MAX_CHIP_TEXT_LENGTH)}
                </span>
            </ChipButton>
        </ChipWithPopup>
    );
}
