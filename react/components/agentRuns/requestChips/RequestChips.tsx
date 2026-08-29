import React from 'react';
import type { BeaverAgentPrompt } from '@beaver/agent-core/agents/types';
import {
    AnnotationAttachment,
    CollectionAttachment,
    ExternalFileAttachment,
    ItemMetadataAttachment,
    NoteAttachment,
    SourceAttachment,
    messageAttachmentIdentity,
    zoteroReferenceKey,
} from '@beaver/agent-core/types/attachments/apiTypes';
import type { ZoteroCollection, ZoteroItemReference, ZoteroTag } from '@beaver/agent-core/types/zotero';
import { EXTERNAL_LIBRARY_ID } from '../../../../src/services/externalFiles';
import {
    AnnotationChip,
    CollectionChip,
    ExternalFileChip,
    ItemChip,
    LibraryChip,
    NoteChip,
    TagChip,
} from './RequestChipPrimitives';
import type { ChipPopupSubtitle } from '@beaver/agent-ui/chat/ChipPopup';

const EMPTY_ATTACHMENTS: NonNullable<BeaverAgentPrompt['attachments']> = [];

/** Identifies one chip for removal while editing. */
export type RequestChipRef =
    | { kind: 'attachment'; key: string }
    | { kind: 'library'; libraryId: number }
    | { kind: 'collection'; key: string }
    | { kind: 'tag'; key: string };

export function requestFilterCollectionKey(collection: ZoteroCollection): string {
    return zoteroReferenceKey(collection);
}

export function requestFilterTagKey(tag: ZoteroTag): string {
    return `${tag.libraryId}-${tag.id}-${tag.tag}`;
}

/** Chip-row edit mode: hover "x" and right-click Remove on every chip. */
export interface RequestChipsEditing {
    onRemove: (ref: RequestChipRef) => void;
    /** "Remove all" in the context menu; omit when only one chip is present. */
    onRemoveAll?: () => void;
}

function refKey(ref: ZoteroItemReference): string {
    return `${ref.library_id}-${ref.zotero_key}`;
}

function attachmentRef(att: ItemMetadataAttachment | SourceAttachment): ZoteroItemReference {
    return {
        library_id: att.library_id,
        zotero_key: att.zotero_key,
        library_ref: att.library_ref,
    };
}

function itemStubLabel(att: ItemMetadataAttachment): string | null {
    const stub = att.item;
    if (!stub) return null;
    return itemStubDisplayLabel(stub);
}

function itemStubDisplayLabel(stub: { creators?: string | null; year?: number | null; title?: string | null }): string | null {
    const creatorYear = [stub.creators, stub.year].filter(Boolean).join(' ');
    return creatorYear || stub.title || null;
}

function sourceStubLabel(att: SourceAttachment): string | null {
    const stub = att.attachment;
    return stub?.title || stub?.filename || (att.parent_item ? itemStubDisplayLabel(att.parent_item) : null);
}

function annotationTitle(att: AnnotationAttachment): string | undefined {
    return [att.text, att.comment].filter(Boolean).join('\n') || undefined;
}

/**
 * Popup second line for a regular item. The chip headline is the
 * creator/year (when present), so the title goes beneath it — mirroring a
 * regular-item row in ItemListResultView. When the headline already is the
 * title (no creator/year), there is no second line.
 */
function itemStubSubtitle(att: ItemMetadataAttachment): ChipPopupSubtitle | null {
    const stub = att.item;
    if (!stub) return null;
    const creatorYear = [stub.creators, stub.year].filter(Boolean).join(' ');
    return creatorYear && stub.title ? { text: stub.title } : null;
}

/**
 * Popup second line for an attachment: "Attached to <parent>" (parent bib
 * italicized) when the parent is known, else a standalone/external label.
 */
function sourceSubtitle(att: SourceAttachment): ChipPopupSubtitle | null {
    const parent = att.parent_item ? itemStubDisplayLabel(att.parent_item) : null;
    if (parent) return { prefix: 'Attached to ', text: parent, italic: true };
    if (att.library_id === EXTERNAL_LIBRARY_ID) return { text: 'External file' };
    return { text: 'Standalone attachment' };
}

/**
 * Popup second line for a note. Hydrated note attachments carry only the
 * parent key (no parent bib), so a child note shows a generic "Attached note".
 */
function noteSubtitle(att: NoteAttachment): ChipPopupSubtitle {
    return att.parent_key ? { text: 'Attached note' } : { text: 'Standalone note' };
}

export function RequestChips({
    userPrompt,
    editing,
}: {
    userPrompt: BeaverAgentPrompt;
    editing?: RequestChipsEditing;
}) {
    const attachments = userPrompt.attachments ?? EMPTY_ATTACHMENTS;

    // Undefined in read-only mode, which leaves chips without an "x" or menu.
    const removeConfig = (ref: RequestChipRef) =>
        editing
            ? { onRemove: () => editing.onRemove(ref), onRemoveAll: editing.onRemoveAll }
            : undefined;

    return (
        <div className="composer-attachments">
            {userPrompt.filters?.libraries?.map((library) => (
                <LibraryChip
                    key={library.library_id}
                    libraryId={library.library_id}
                    name={library.name}
                    remove={removeConfig({ kind: 'library', libraryId: library.library_id })}
                />
            ))}
            {userPrompt.filters?.collections?.map((collection) => (
                    <CollectionChip
                        key={requestFilterCollectionKey(collection)}
                        name={collection.name}
                        collectionRef={{
                            library_id: collection.library_id,
                            zotero_key: collection.zotero_key,
                            library_ref: collection.library_ref,
                        }}
                        isFilter={true}
                        remove={removeConfig({ kind: 'collection', key: requestFilterCollectionKey(collection) })}
                    />
            ))}
            {userPrompt.filters?.tags?.map((tag) => (
                <TagChip
                    key={requestFilterTagKey(tag)}
                    tag={tag.tag}
                    color={tag.color}
                    remove={removeConfig({ kind: 'tag', key: requestFilterTagKey(tag) })}
                />
            ))}
            {attachments.map((att) => {
                const attachmentRemove = removeConfig({ kind: 'attachment', key: messageAttachmentIdentity(att) });
                switch (att.type) {
                    case 'item': {
                        const ref = attachmentRef(att);
                        return (
                            <ItemChip
                                key={`item-${refKey(ref)}`}
                                itemRef={ref}
                                isAttachment={false}
                                itemType={att.item?.item_type}
                                label={itemStubLabel(att)}
                                subtitle={itemStubSubtitle(att)}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    case 'source': {
                        const ref = attachmentRef(att);
                        return (
                            <ItemChip
                                key={`source-${refKey(ref)}`}
                                itemRef={ref}
                                isAttachment={true}
                                contentKind={att.attachment?.content_kind}
                                label={sourceStubLabel(att)}
                                subtitle={sourceSubtitle(att)}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    case 'annotation': {
                        const annotation = att as AnnotationAttachment;
                        return (
                            <AnnotationChip
                                key={`annotation-${annotation.library_id}-${annotation.zotero_key}`}
                                annotationRef={{
                                    library_id: annotation.library_id,
                                    zotero_key: annotation.zotero_key,
                                    library_ref: annotation.library_ref,
                                }}
                                annotationType={annotation.annotation_type}
                                color={annotation.color}
                                title={annotationTitle(annotation)}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    case 'note': {
                        const note = att as NoteAttachment;
                        return (
                            <NoteChip
                                key={`note-${note.library_id}-${note.zotero_key}`}
                                noteRef={{
                                    library_id: note.library_id,
                                    zotero_key: note.zotero_key,
                                    library_ref: note.library_ref,
                                }}
                                title={note.title}
                                subtitle={noteSubtitle(note)}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    case 'collection': {
                        const collection = att as CollectionAttachment;
                        return (
                            <CollectionChip
                                key={`collection-${collection.library_id}-${collection.zotero_key}`}
                                name={collection.name}
                                collectionRef={{
                                    library_id: collection.library_id,
                                    zotero_key: collection.zotero_key,
                                    library_ref: collection.library_ref,
                                }}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    case 'external_file': {
                        const file = att as ExternalFileAttachment;
                        return (
                            <ExternalFileChip
                                key={`external-${file.ext_key}`}
                                extKey={file.ext_key}
                                filename={file.filename}
                                contentKind={file.content_kind}
                                remove={attachmentRemove}
                            />
                        );
                    }
                    default:
                        return null;
                }
            })}
        </div>
    );
}
