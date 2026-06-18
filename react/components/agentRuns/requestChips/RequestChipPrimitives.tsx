import React from 'react';
import { CSSIcon, CSSItemTypeIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { getHost } from '../../../host';
import type { ZoteroItemReference } from '../../../types/zotero';
import type { ContentKind } from '../../../types/zotero';
import { truncateText } from '../../../utils/stringUtils';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import type { ValidAnnotationType, ExternalFileContentKind } from '../../../types/attachments/apiTypes';

const MAX_CHIP_TEXT_LENGTH = 30;

function stopLeftClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (e.button !== 0) {
        e.preventDefault();
    }
}

interface ChipButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: React.ReactNode;
}

function ChipButton({ children, className = '', onClick, ...rest }: ChipButtonProps) {
    return (
        <button
            type="button"
            style={{ height: '22px' }}
            className={`variant-outline source-button ${className}`}
            onClick={(e) => {
                stopLeftClick(e);
                if (e.button === 0) onClick?.(e);
            }}
            {...rest}
        >
            {children}
        </button>
    );
}

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
}: {
    label?: string | null;
    itemType?: string | null;
    contentKind?: ContentKind | null;
    itemRef: ZoteroItemReference;
    isAttachment: boolean;
}) {
    const iconName = isAttachment ? attachmentIconName(contentKind) : itemType || 'document';
    return (
        <ChipButton onClick={() => getHost().navigation?.revealInLibrary(itemRef)}>
            <span className="scale-80">
                <CSSItemTypeIcon itemType={iconName} />
            </span>
            <span className="truncate">
                {truncateText(label || (isAttachment ? 'Attachment' : 'Item'), MAX_CHIP_TEXT_LENGTH)}
            </span>
        </ChipButton>
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
    return (
        <ChipButton title={title} onClick={() => getHost().navigation?.openAnnotation(annotationRef)}>
            <ZoteroIcon icon={icon} size={14} style={color ? { color } : undefined} />
            <span className="truncate">
                {ANNOTATION_TEXT_BY_TYPE[annotationType] || 'Annotation'}
            </span>
        </ChipButton>
    );
}

export function NoteChip({
    title,
    noteRef,
}: {
    title?: string | null;
    noteRef: ZoteroItemReference;
}) {
    return (
        <ChipButton onClick={() => getHost().navigation?.openSource(noteRef)}>
            <CSSIcon name="note" className="icon-16" />
            <span className="truncate">
                {truncateText(title || 'Note', MAX_CHIP_TEXT_LENGTH)}
            </span>
        </ChipButton>
    );
}

export function CollectionChip({
    name,
    collectionRef,
}: {
    name: string;
    collectionRef: ZoteroItemReference;
}) {
    return (
        <ChipButton onClick={() => getHost().navigation?.revealCollection(collectionRef)}>
            <span className="scale-90">
                <CSSIcon name="collection" className="icon-16" />
            </span>
            <span className="truncate">
                {truncateText(name, 20)}
            </span>
        </ChipButton>
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
        <ChipButton onClick={() => getHost().navigation?.launchExternalFile(extKey)}>
            <span className="scale-80">
                <CSSItemTypeIcon itemType={iconName} />
            </span>
            <span className="truncate">
                {truncateText(filename, MAX_CHIP_TEXT_LENGTH)}
            </span>
        </ChipButton>
    );
}
