import React from 'react';
import { CSSIcon, CSSItemTypeIcon, LibraryIcon, NoteIcon, HighlighterIcon, ExternalLinkIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { getHost } from '../../../host';
import type { ZoteroItemReference } from '../../../types/zotero';
import type { ContentKind } from '../../../types/zotero';
import { truncateText } from '../../../utils/stringUtils';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import type {
    AnnotationAttachment,
    AnswerReference,
    CollectionAttachment,
    ExternalFileAttachment,
    ExternalFileContentKind,
    ItemMetadataAttachment,
    MessageAttachment,
    NoteAttachment,
    SourceAttachment,
    ValidAnnotationType,
} from '../../../types/attachments/apiTypes';
import { EXTERNAL_LIBRARY_ID } from '../../../../src/services/externalFiles';
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

function stopLeftClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (e.button !== 0) {
        e.preventDefault();
    }
}

function refKey(ref: ZoteroItemReference): string {
    return `${ref.library_id}-${ref.zotero_key}`;
}

function attachmentRef(att: ItemMetadataAttachment | SourceAttachment): ZoteroItemReference {
    return { library_id: att.library_id, zotero_key: att.zotero_key };
}

function itemStubDisplayLabel(stub: { creators?: string | null; year?: number | null; title?: string | null }): string | null {
    const creatorYear = [stub.creators, stub.year].filter(Boolean).join(' ');
    return creatorYear || stub.title || null;
}

function itemStubLabel(att: ItemMetadataAttachment): string | null {
    const stub = att.item;
    if (!stub) return null;
    return itemStubDisplayLabel(stub);
}

function sourceStubLabel(att: SourceAttachment): string | null {
    const stub = att.attachment;
    return stub?.title || stub?.filename || (att.parent_item ? itemStubDisplayLabel(att.parent_item) : null);
}

function annotationTitle(att: AnnotationAttachment): string | undefined {
    return [att.text, att.comment].filter(Boolean).join('\n') || undefined;
}

function itemStubSubtitle(att: ItemMetadataAttachment): ChipPopupSubtitle | null {
    const stub = att.item;
    if (!stub) return null;
    const creatorYear = [stub.creators, stub.year].filter(Boolean).join(' ');
    return creatorYear && stub.title ? { text: stub.title } : null;
}

function sourceSubtitle(att: SourceAttachment): ChipPopupSubtitle | null {
    const parent = att.parent_item ? itemStubDisplayLabel(att.parent_item) : null;
    if (parent) return { prefix: 'Attached to ', text: parent, italic: true };
    if (att.library_id === EXTERNAL_LIBRARY_ID) return { text: 'External file' };
    return { text: 'Standalone attachment' };
}

function noteSubtitle(att: NoteAttachment): ChipPopupSubtitle {
    return att.parent_key ? { text: 'Attached note' } : { text: 'Standalone note' };
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

export function chipForMessageAttachment(
    att: MessageAttachment | AnswerReference,
    key?: React.Key,
): React.ReactNode {
    switch (att.type) {
        case 'item': {
            const ref = attachmentRef(att);
            return (
                <ItemChip
                    key={key ?? `item-${refKey(ref)}`}
                    itemRef={ref}
                    isAttachment={false}
                    itemType={att.item?.item_type}
                    label={itemStubLabel(att)}
                    subtitle={itemStubSubtitle(att)}
                />
            );
        }
        case 'source': {
            const ref = attachmentRef(att);
            return (
                <ItemChip
                    key={key ?? `source-${refKey(ref)}`}
                    itemRef={ref}
                    isAttachment={true}
                    contentKind={att.attachment?.content_kind}
                    label={sourceStubLabel(att)}
                    subtitle={sourceSubtitle(att)}
                />
            );
        }
        case 'annotation': {
            const annotation = att as AnnotationAttachment;
            return (
                <AnnotationChip
                    key={key ?? `annotation-${annotation.library_id}-${annotation.zotero_key}`}
                    annotationRef={{ library_id: annotation.library_id, zotero_key: annotation.zotero_key }}
                    annotationType={annotation.annotation_type}
                    color={annotation.color}
                    title={annotationTitle(annotation)}
                />
            );
        }
        case 'note': {
            const note = att as NoteAttachment;
            return (
                <NoteChip
                    key={key ?? `note-${note.library_id}-${note.zotero_key}`}
                    noteRef={{ library_id: note.library_id, zotero_key: note.zotero_key }}
                    title={note.title}
                    subtitle={noteSubtitle(note)}
                />
            );
        }
        case 'collection': {
            const collection = att as CollectionAttachment;
            return (
                <CollectionChip
                    key={key ?? `collection-${collection.library_id}-${collection.zotero_key}`}
                    name={collection.name}
                    collectionRef={{ library_id: collection.library_id, zotero_key: collection.zotero_key }}
                />
            );
        }
        case 'external_file': {
            const file = att as ExternalFileAttachment;
            return (
                <ExternalFileChip
                    key={key ?? `external-${file.ext_key}`}
                    extKey={file.ext_key}
                    filename={file.filename}
                    contentKind={file.content_kind}
                />
            );
        }
        case 'tag':
            return (
                <TagChip
                    key={key ?? `tag-${att.library_id ?? 'all'}-${att.name}`}
                    tag={att.name}
                    color={att.color}
                />
            );
        default:
            return null;
    }
}

function InlineRefButton({
    popup,
    children,
    onClick,
}: {
    popup: ChipPopupContent;
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
}) {
    return (
        <ChipWithPopup popup={popup}>
            <button
                type="button"
                className="inline-ref-chip"
                onClick={(e) => {
                    stopLeftClick(e);
                    if (e.button === 0) onClick?.(e);
                }}
            >
                {children}
            </button>
        </ChipWithPopup>
    );
}

function InlineRefIcon({ children }: { children: React.ReactNode }) {
    return <span className="inline-ref-chip-icon">{children}</span>;
}

export function inlineChipForMessageAttachment(
    att: MessageAttachment,
    key?: React.Key,
): React.ReactNode {
    switch (att.type) {
        case 'item': {
            const ref = attachmentRef(att);
            const displayName = itemStubLabel(att) || 'Item';
            const iconName = att.item?.item_type || 'document';
            return (
                <InlineRefButton
                    key={key ?? `inline-item-${refKey(ref)}`}
                    popup={{
                        icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                        title: displayName,
                        subtitle: itemStubSubtitle(att),
                        action: { icon: LibraryIcon, label: 'Reveal in library' },
                    }}
                    onClick={() => getHost().navigation?.revealInLibrary(ref)}
                >
                    <InlineRefIcon>
                        <CSSItemTypeIcon itemType={iconName} />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{displayName}</span>
                </InlineRefButton>
            );
        }
        case 'source': {
            const ref = attachmentRef(att);
            const displayName = sourceStubLabel(att) || 'Attachment';
            const iconName = attachmentIconName(att.attachment?.content_kind);
            return (
                <InlineRefButton
                    key={key ?? `inline-source-${refKey(ref)}`}
                    popup={{
                        icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                        title: displayName,
                        subtitle: sourceSubtitle(att),
                        action: { icon: LibraryIcon, label: 'Reveal in library' },
                    }}
                    onClick={() => getHost().navigation?.revealInLibrary(ref)}
                >
                    <InlineRefIcon>
                        <CSSItemTypeIcon itemType={iconName} />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{displayName}</span>
                </InlineRefButton>
            );
        }
        case 'annotation': {
            const icon = ANNOTATION_ICON_BY_TYPE[att.annotation_type] || ZOTERO_ICONS.ANNOTATION;
            const typeLabel = ANNOTATION_TEXT_BY_TYPE[att.annotation_type] || 'Annotation';
            const ref = { library_id: att.library_id, zotero_key: att.zotero_key };
            return (
                <InlineRefButton
                    key={key ?? `inline-annotation-${refKey(ref)}`}
                    popup={buildAnnotationChipPopup({
                        annotationType: att.annotation_type,
                        color: att.color,
                        title: annotationTitle(att),
                    })}
                    onClick={() => getHost().navigation?.openAnnotation(ref)}
                >
                    <InlineRefIcon>
                        <ZoteroIcon icon={icon} size={14} style={att.color ? { color: att.color } : undefined} />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{typeLabel}</span>
                </InlineRefButton>
            );
        }
        case 'note': {
            const ref = { library_id: att.library_id, zotero_key: att.zotero_key };
            const displayName = att.title || 'Untitled Note';
            return (
                <InlineRefButton
                    key={key ?? `inline-note-${refKey(ref)}`}
                    popup={{
                        icon: <CSSItemTypeIcon itemType="note" className="scale-90" />,
                        title: displayName,
                        subtitle: noteSubtitle(att),
                        action: { icon: NoteIcon, label: 'Open note' },
                    }}
                    onClick={() => getHost().navigation?.openSource(ref)}
                >
                    <InlineRefIcon>
                        <CSSItemTypeIcon itemType="note" />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{displayName}</span>
                </InlineRefButton>
            );
        }
        case 'collection': {
            const ref = { library_id: att.library_id, zotero_key: att.zotero_key };
            return (
                <InlineRefButton
                    key={key ?? `inline-collection-${refKey(ref)}`}
                    popup={{
                        icon: <CSSIcon name="collection" className="icon-16" />,
                        title: att.name,
                        subtitle: { text: 'Collection' },
                        action: { icon: LibraryIcon, label: 'Reveal in library' },
                    }}
                    onClick={() => getHost().navigation?.revealCollection(ref)}
                >
                    <InlineRefIcon>
                        <CSSIcon name="collection" className="icon-16" />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{att.name}</span>
                </InlineRefButton>
            );
        }
        case 'external_file':
            return (
                <InlineRefButton
                    key={key ?? `inline-external-${att.ext_key}`}
                    popup={{
                        icon: <CSSItemTypeIcon itemType={attachmentIconName(att.content_kind)} className="scale-90" />,
                        title: att.filename,
                        subtitle: { text: 'External file' },
                        action: { icon: ExternalLinkIcon, label: 'Open external file', iconClassName: 'scale-75' },
                    }}
                    onClick={() => getHost().navigation?.launchExternalFile(att.ext_key)}
                >
                    <InlineRefIcon>
                        <CSSItemTypeIcon itemType={attachmentIconName(att.content_kind)} />
                    </InlineRefIcon>
                    <span className="inline-ref-chip-label">{att.filename}</span>
                </InlineRefButton>
            );
        default:
            return null;
    }
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
