import React from 'react';
import type { BeaverAgentPrompt } from '../../../agents/types';
import {
    AnnotationAttachment,
    CollectionAttachment,
    ExternalFileAttachment,
    ItemMetadataAttachment,
    NoteAttachment,
    SourceAttachment,
} from '../../../types/attachments/apiTypes';
import type { ZoteroItemReference } from '../../../types/zotero';
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
import type { ChipPopupSubtitle } from './ChipPopup';

const EMPTY_ATTACHMENTS: NonNullable<BeaverAgentPrompt['attachments']> = [];

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

export function RequestChips({ userPrompt }: { userPrompt: BeaverAgentPrompt }) {
    const attachments = userPrompt.attachments ?? EMPTY_ATTACHMENTS;

    return (
        <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
            {userPrompt.filters?.libraries?.map((library) => (
                <LibraryChip
                    key={library.library_id}
                    libraryId={library.library_id}
                    name={library.name}
                />
            ))}
            {userPrompt.filters?.collections?.map((collection) => (
                    <CollectionChip
                        key={`${collection.library_id}-${collection.zotero_key}`}
                        name={collection.name}
                        collectionRef={{
                            library_id: collection.library_id,
                            zotero_key: collection.zotero_key,
                            library_ref: collection.library_ref,
                        }}
                        isFilter={true}
                    />
            ))}
            {userPrompt.filters?.tags?.map((tag) => (
                <TagChip key={`${tag.libraryId}-${tag.id}-${tag.tag}`} tag={tag.tag} color={tag.color} />
            ))}
            {attachments.map((att) => {
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
