import React, { useState, useEffect } from 'react';
import { truncateText } from '../../utils/stringUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { ItemMetadataAttachment, SourceAttachment } from '../../types/attachments/apiTypes';
import { ZoteroItemReference } from '../../types/zotero';
import { selectItemById } from '../../../src/utils/selectItem';
import { getNoteContentPreviewText } from '../../utils/noteText';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { logger } from '../../../src/utils/logger';
import {
    AnnotationRow,
    ResolvedAnnotation,
    resolveAnnotationRef,
} from '../agentRuns/annotationListShared';
import { EXTERNAL_LIBRARY_ID } from '../../../src/services/externalFiles';
import { EXTERNAL_FILE_ICON_BY_KIND } from '../input/ExternalFileButton';
import type { ExternalFileContentKind } from '../../types/attachments/apiTypes';

export interface ZoteroItemReferenceWithLabel extends ZoteroItemReference {
    label: string;
    faded?: boolean;
}

const NOTE_TITLE_MAX_LENGTH = 100;
const NOTE_PREVIEW_MAX_LENGTH = 200;

function getNoteContentPreview(item: Zotero.Item, maxLength: number): string {
    try {
        return getNoteContentPreviewText(item.getNote(), item.getNoteTitle(), maxLength);
    } catch {
        return '';
    }
}

interface ItemWithSelectionId {
    item: Zotero.Item;
    selectionItemId: number;
    displayName: string;
    subtitle: string;
    muted?: boolean;
    label?: string;
    faded?: boolean;
}

interface ResolvedExternalFile {
    extKey: string;
    filename: string;
    contentKind: ExternalFileContentKind | null;
    /** Path of the managed copy; null when the registry has no row or the copy is gone. */
    storedPath: string | null;
    label?: string;
    faded?: boolean;
}

type ResolvedListEntry =
    | { kind: 'item'; entry: ItemWithSelectionId }
    | { kind: 'annotation'; entry: ResolvedAnnotation; faded?: boolean }
    | { kind: 'externalFile'; entry: ResolvedExternalFile };

interface ZoteroItemsListProps {
    messageAttachments: (
        SourceAttachment |
        ItemMetadataAttachment |
        ZoteroItemReference |
        ZoteroItemReferenceWithLabel
    )[];
    oneLine?: boolean;
    muted?: boolean;
    showParentItem?: boolean;
}

const ZoteroItemsList: React.FC<ZoteroItemsListProps> = ({
    messageAttachments,
    showParentItem = true,
    oneLine = false,
    muted = false
}) => {
    const [resolvedEntries, setResolvedEntries] = useState<ResolvedListEntry[]>([]);
    const [hoveredItemId, setHoveredItemId] = useState<number | null>(null);
    const [hoveredAnnotationKey, setHoveredAnnotationKey] = useState<string | null>(null);

    useEffect(() => {
        const fetchItems = async () => {
            if (messageAttachments) {
                const entries: ResolvedListEntry[] = [];
                for (const attachment of messageAttachments) {
                    // Sentinel references (library_id = EXTERNAL_LIBRARY_ID)
                    // identify external files; the key is the ext key.
                    if (attachment.library_id === EXTERNAL_LIBRARY_ID) {
                        const record = await Zotero.Beaver?.db
                            ?.getExternalFileByKey(attachment.zotero_key)
                            .catch(() => null);
                        const copyExists = record
                            ? await IOUtils.exists(record.storedPath).catch(() => false)
                            : false;
                        entries.push({
                            kind: 'externalFile',
                            entry: {
                                extKey: attachment.zotero_key,
                                filename: record?.filename ?? `Attached file (ext-${attachment.zotero_key})`,
                                contentKind: record?.contentKind ?? null,
                                storedPath: copyExists && record ? record.storedPath : null,
                                label: 'label' in attachment ? attachment.label : undefined,
                                faded: 'faded' in attachment ? attachment.faded : false,
                            },
                        });
                        continue;
                    }

                    const item = await Zotero.Items.getByLibraryAndKeyAsync(
                        attachment.library_id,
                        attachment.zotero_key
                    );
                    if (!item) continue;

                    if (item.isAnnotation()) {
                        const annotation = await resolveAnnotationRef(
                            {
                                library_id: attachment.library_id,
                                zotero_key: attachment.zotero_key,
                            },
                            item
                        );
                        if (annotation) {
                            entries.push({
                                kind: 'annotation',
                                entry: annotation,
                                faded: 'faded' in attachment ? attachment.faded : false,
                            });
                        }
                        continue;
                    }

                    const displayItem = showParentItem ? (item.parentItem || item) : item;
                    const isNote = displayItem.isNote();
                    const displayName = isNote
                        ? truncateText(displayItem.getNoteTitle(), NOTE_TITLE_MAX_LENGTH)
                        : getDisplayNameFromItem(displayItem);
                    const subtitle = isNote
                        ? getNoteContentPreview(displayItem, NOTE_PREVIEW_MAX_LENGTH)
                        : displayItem.getDisplayTitle();
                    entries.push({
                        kind: 'item',
                        entry: {
                            item: displayItem,
                            selectionItemId: item.id,
                            displayName,
                            subtitle,
                            label: 'label' in attachment ? attachment.label : undefined,
                            faded: 'faded' in attachment ? attachment.faded : false
                        },
                    });
                }
                setResolvedEntries(entries);
            }
        };

        fetchItems();
    }, [messageAttachments, showParentItem]);

    const handleItemClick = (selectionItemId: number) => {
        selectItemById(selectionItemId);
    };

    const handleExternalFileClick = (entry: ResolvedExternalFile) => {
        if (!entry.storedPath) return;
        // Zotero.File.reveal is async; route rejections into the logger.
        Promise.resolve()
            .then(() => Zotero.File.reveal(entry.storedPath as string))
            .catch((error) => {
                logger(`ZoteroItemsList: failed to reveal external file ext-${entry.extKey}: ${error}`, 1);
            });
    };

    const handleAnnotationClick = async (annotation: ResolvedAnnotation) => {
        try {
            await navigateToAnnotation(annotation.item);
        } catch (error) {
            logger(`ZoteroItemsList: failed to navigate to ${annotation.ref.library_id}-${annotation.ref.zotero_key}: ${error}`, 1);
        }
    };

    const fontColor = muted ? 'font-color-tertiary' : 'font-color-primary';

    return (
        <div className="min-w-0">
            {resolvedEntries.map((resolvedEntry) => {
                if (resolvedEntry.kind === 'externalFile') {
                    const entry = resolvedEntry.entry;
                    const clickable = !!entry.storedPath;
                    return (
                        <div
                            key={`ext-${entry.extKey}`}
                            className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 transition-colors duration-150 ${clickable ? 'cursor-pointer' : ''} ${entry.faded ? 'opacity-50' : ''}`}
                            onClick={clickable ? () => handleExternalFileClick(entry) : undefined}
                            title={clickable ? 'Click to show the file' : 'File not available on this device'}
                        >
                            <span className="scale-75" style={{ marginTop: '-2px' }}>
                                <CSSItemTypeIcon
                                    itemType={(entry.contentKind && EXTERNAL_FILE_ICON_BY_KIND[entry.contentKind]) || 'attachmentFile'}
                                />
                            </span>
                            <div className={`display-flex flex-col flex-1 gap-1 min-w-0 ${fontColor}`}>
                                <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                    <div className={`truncate text-sm ${fontColor}`}>
                                        {truncateText(entry.filename, 100)}
                                    </div>
                                    {!oneLine && entry.label && (
                                        <>
                                            <div className="flex-1" />
                                            <div className="text-sm display-flex min-w-0 font-color-tertiary mr-1">
                                                {truncateText(entry.label, 15)}
                                            </div>
                                        </>
                                    )}
                                </div>
                                <div className={`truncate text-sm ${muted ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                                    Attached file
                                </div>
                            </div>
                        </div>
                    );
                }

                if (resolvedEntry.kind === 'annotation') {
                    const { entry: annotation, faded } = resolvedEntry;
                    const key = `${annotation.ref.library_id}-${annotation.ref.zotero_key}`;
                    return (
                        <div key={key} className={faded ? 'opacity-50' : undefined}>
                            <AnnotationRow
                                annotation={annotation}
                                variant="with-parent"
                                isHovered={hoveredAnnotationKey === key}
                                onMouseEnter={() => setHoveredAnnotationKey(key)}
                                onMouseLeave={() => setHoveredAnnotationKey(null)}
                                onClick={() => handleAnnotationClick(annotation)}
                            />
                        </div>
                    );
                }

                const { item, selectionItemId, displayName, subtitle, label, faded } = resolvedEntry.entry;
                const isHovered = hoveredItemId === selectionItemId;
                const hasSubtitle = subtitle.length > 0;

                return (
                    <div
                        key={selectionItemId}
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''} ${faded ? 'opacity-50' : ''}`}
                        onClick={() => handleItemClick(selectionItemId)}
                        onMouseEnter={() => setHoveredItemId(selectionItemId)}
                        onMouseLeave={() => setHoveredItemId(null)}
                        title="Click to reveal in Zotero"
                    >
                        <span className="scale-75" style={{ marginTop: '-2px' }}>
                            <CSSItemTypeIcon itemType={item.getItemTypeIconName()} />
                        </span>
                        {oneLine ? (
                            <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                <div className="text-sm whitespace-nowrap">
                                    {displayName}
                                </div>
                                {hasSubtitle && (
                                    <div className="truncate text-sm">
                                        {subtitle}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className={`display-flex flex-col flex-1 gap-1 min-w-0 ${fontColor}`}>
                                <div className={`display-flex flex-row gap-1 min-w-0 ${fontColor}`}>
                                    <div className={`truncate text-sm ${fontColor}`}>
                                        {displayName}
                                    </div>
                                    {!oneLine && label &&
                                         <>
                                            <div className="flex-1" />
                                            <div className="text-sm display-flex min-w-0 font-color-tertiary mr-1">
                                                {truncateText(label, 15)}
                                            </div>
                                        </>
                                    }
                                </div>
                                {hasSubtitle && (
                                    <div className={`truncate text-sm ${muted ? 'font-color-tertiary' : 'font-color-secondary'}`}>
                                        {subtitle}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ZoteroItemsList;
