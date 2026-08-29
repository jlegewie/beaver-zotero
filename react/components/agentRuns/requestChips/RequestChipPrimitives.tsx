import React from 'react';
import { CSSIcon, CSSItemTypeIcon, LibraryIcon, NoteIcon, HighlighterIcon, ExternalLinkIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { getHost } from '@beaver/agent-ui/host';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { ContentKind } from '@beaver/agent-core/types/zotero';
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import type { ValidAnnotationType, ExternalFileContentKind } from '@beaver/agent-core/types/attachments/apiTypes';
import { ChipWithPopup, type ChipPopupContent, type ChipPopupSubtitle } from '@beaver/agent-ui/chat/ChipPopup';
import { useRemoveContextMenu } from '../../../hooks/useRemoveContextMenu';
import { ChipButton } from './ChipButton';
import { ChipRemovableIcon } from './ChipRemovableIcon';

const MAX_CHIP_TEXT_LENGTH = 30;
const MAX_ANNOTATION_TOOLTIP_TEXT_LENGTH = 160;

/**
 * Makes a chip removable. Passed only while the parent message is being
 * edited; omitted, the chip is the read-only history affordance.
 */
export interface ChipRemoveConfig {
    onRemove: () => void;
    /** Omitted when there is nothing else to remove. */
    onRemoveAll?: () => void;
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

/** Shared chip body. `remove` adds the hover "x" and the Remove context menu. */
function ChipShell({
    icon,
    label,
    trailing,
    popup,
    onClick,
    remove,
}: {
    icon: React.ReactNode;
    label: string;
    trailing?: React.ReactNode;
    popup?: ChipPopupContent | null;
    onClick?: () => void;
    remove?: ChipRemoveConfig;
}) {
    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => remove?.onRemove(),
        onRemoveAll: remove?.onRemoveAll,
        canEdit: Boolean(remove),
    });

    const button = (
        <ChipButton onClick={onClick} {...contextMenuHandlers}>
            {remove ? (
                <ChipRemovableIcon
                    normalIcon={icon}
                    removeHandlers={removeHandlers}
                    removeMenuOpen={isRemoveMenuOpen}
                />
            ) : (
                icon
            )}
            <span className="truncate">{label}</span>
            {trailing}
        </ChipButton>
    );

    return (
        <>
            {popup ? (
                <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                    {button}
                </ChipWithPopup>
            ) : (
                button
            )}
            {removeMenu}
        </>
    );
}

/** The trailing glyph that marks a chip as a search filter rather than an attachment. */
const filterGlyph = (
    <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
);

export function ItemChip({
    label,
    itemType,
    contentKind,
    itemRef,
    isAttachment,
    subtitle,
    remove,
}: {
    label?: string | null;
    itemType?: string | null;
    contentKind?: ContentKind | null;
    itemRef: ZoteroItemReference;
    isAttachment: boolean;
    subtitle?: ChipPopupSubtitle | null;
    remove?: ChipRemoveConfig;
}) {
    const iconName = isAttachment ? attachmentIconName(contentKind) : itemType || 'document';
    const displayName = label || (isAttachment ? 'Attachment' : 'Item');
    return (
        <ChipShell
            icon={
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            }
            label={truncateText(displayName, MAX_CHIP_TEXT_LENGTH)}
            popup={{
                icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                title: displayName,
                subtitle,
                action: { icon: LibraryIcon, label: 'Reveal in library' },
            }}
            onClick={() => getHost().navigation?.revealInLibrary(itemRef)}
            remove={remove}
        />
    );
}

export function AnnotationChip({
    annotationType,
    color,
    annotationRef,
    title,
    remove,
}: {
    annotationType: ValidAnnotationType | string;
    color?: string;
    annotationRef: ZoteroItemReference;
    title?: string;
    remove?: ChipRemoveConfig;
}) {
    const icon = ANNOTATION_ICON_BY_TYPE[annotationType] || ZOTERO_ICONS.ANNOTATION;
    const typeLabel = ANNOTATION_TEXT_BY_TYPE[annotationType] || 'Annotation';
    return (
        <ChipShell
            icon={<ZoteroIcon icon={icon} size={14} style={color ? { color } : undefined} />}
            label={typeLabel}
            popup={buildAnnotationChipPopup({ annotationType, color, title })}
            onClick={() => getHost().navigation?.openAnnotation(annotationRef)}
            remove={remove}
        />
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
    remove,
}: {
    title?: string | null;
    noteRef: ZoteroItemReference;
    subtitle?: ChipPopupSubtitle | null;
    remove?: ChipRemoveConfig;
}) {
    const displayName = title || 'Untitled Note';
    return (
        <ChipShell
            icon={
                <span className="scale-80">
                    <CSSItemTypeIcon itemType="note" />
                </span>
            }
            label={truncateText(displayName, MAX_CHIP_TEXT_LENGTH)}
            popup={{
                icon: <CSSItemTypeIcon itemType="note" className="scale-90" />,
                title: displayName,
                subtitle,
                action: { icon: NoteIcon, label: 'Open note' },
            }}
            onClick={() => getHost().navigation?.openSource(noteRef)}
            remove={remove}
        />
    );
}

export function CollectionChip({
    name,
    collectionRef,
    isFilter = false,
    remove,
}: {
    name: string;
    collectionRef: ZoteroItemReference;
    /** True for collections used to scope the search (vs. an explicit attachment). */
    isFilter?: boolean;
    remove?: ChipRemoveConfig;
}) {
    return (
        <ChipShell
            icon={
                <span className="scale-90">
                    <CSSIcon name="collection" className="icon-16" />
                </span>
            }
            label={truncateText(name, 20)}
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
            onClick={() => getHost().navigation?.revealCollection(collectionRef)}
            remove={remove}
        />
    );
}

export function LibraryChip({
    name,
    libraryId,
    remove,
}: {
    name: string;
    libraryId: number;
    remove?: ChipRemoveConfig;
}) {
    return (
        <ChipShell
            icon={
                <span className="scale-90">
                    <CSSIcon name="library" className="icon-16" />
                </span>
            }
            label={truncateText(name, 20)}
            trailing={filterGlyph}
            onClick={() => getHost().navigation?.revealLibrary(libraryId)}
            remove={remove}
        />
    );
}

export function TagChip({
    tag,
    color,
    remove,
}: {
    tag: string;
    color?: string | null;
    remove?: ChipRemoveConfig;
}) {
    return (
        <ChipShell
            icon={
                <CSSIcon
                    name="tag"
                    className="icon-16 scale-80"
                    style={color ? { color } : undefined}
                />
            }
            label={truncateText(tag, 20)}
            trailing={filterGlyph}
            remove={remove}
        />
    );
}

export function ExternalFileChip({
    extKey,
    filename,
    contentKind,
    remove,
}: {
    extKey: string;
    filename: string;
    contentKind: ExternalFileContentKind;
    remove?: ChipRemoveConfig;
}) {
    const iconName = attachmentIconName(contentKind);
    return (
        <ChipShell
            icon={
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            }
            label={truncateText(filename, MAX_CHIP_TEXT_LENGTH)}
            popup={{
                icon: <CSSItemTypeIcon itemType={iconName} className="scale-90" />,
                title: filename,
                subtitle: { text: 'External file' },
                action: { icon: ExternalLinkIcon, label: 'Open external file', iconClassName: 'scale-75' },
            }}
            onClick={() => getHost().navigation?.launchExternalFile(extKey)}
            remove={remove}
        />
    );
}
