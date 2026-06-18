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
import {
    AnnotationChip,
    CollectionChip,
    ExternalFileChip,
    ItemChip,
    LibraryChip,
    NoteChip,
    TagChip,
} from './RequestChipPrimitives';

const EMPTY_ATTACHMENTS: NonNullable<BeaverAgentPrompt['attachments']> = [];

function refKey(ref: ZoteroItemReference): string {
    return `${ref.library_id}-${ref.zotero_key}`;
}

function attachmentRef(att: ItemMetadataAttachment | SourceAttachment): ZoteroItemReference {
    return { library_id: att.library_id, zotero_key: att.zotero_key };
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
                    collectionRef={{ library_id: collection.library_id, zotero_key: collection.zotero_key }}
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
                            />
                        );
                    }
                    case 'annotation': {
                        const annotation = att as AnnotationAttachment;
                        return (
                            <AnnotationChip
                                key={`annotation-${annotation.library_id}-${annotation.zotero_key}`}
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
                                key={`note-${note.library_id}-${note.zotero_key}`}
                                noteRef={{ library_id: note.library_id, zotero_key: note.zotero_key }}
                                title={note.title}
                            />
                        );
                    }
                    case 'collection': {
                        const collection = att as CollectionAttachment;
                        return (
                            <CollectionChip
                                key={`collection-${collection.library_id}-${collection.zotero_key}`}
                                name={collection.name}
                                collectionRef={{ library_id: collection.library_id, zotero_key: collection.zotero_key }}
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
