import {
    MessageAttachment,
    SourceAttachment,
    AnnotationAttachment,
    NoteAttachment,
    Annotation,
    AnnotationPosition,
    ItemMetadataAttachment
} from './apiTypes';
import { ZoteroItemReference } from '../zotero';
import { safeStub, serializeAttachmentStub, serializeItemStub } from '../../../src/utils/zoteroSerializers';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';


export function toAnnotation(item: Zotero.Item): Annotation | null {
    if(!item.isAnnotation()) return null;
    // parse position
    const position_parsed = JSON.parse(item.annotationPosition);
    const position: AnnotationPosition = {
        page_index: position_parsed.pageIndex,
        rects: position_parsed.rects,
    }
    // return Annotation object
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        parent_key: item.parentKey,
        annotation_type: item.annotationType,
        ...(item.annotationText && { text: item.annotationText }),
        ...(item.annotationComment && { comment: item.annotationComment }),
        color: item.annotationColor,
        page_label: item.annotationPageLabel,
        position: position,
        date_modified: Zotero.Date.sqlToISO8601(item.dateModified), // Convert UTC SQL datetime format to ISO string
    } as Annotation;
}


export function toMessageAttachment(item: Zotero.Item): MessageAttachment | null {
    // Convert to MessageAttachment (backend models)
    const zoteroItemReference = {
        library_id: item.libraryID,
        zotero_key: item.key,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
    } as ZoteroItemReference;
    
    if(item.isRegularItem()) {
        return {
            type: "item",
            item: safeStub(() => serializeItemStub(item)),
            ...zoteroItemReference
        } as ItemMetadataAttachment;

    } else if (item.isAttachment()) {
        return {
            type: "source",
            attachment: safeStub(() => serializeAttachmentStub(item)),
            parent_item: safeStub(() => item.parentItem ? serializeItemStub(item.parentItem) : undefined),
            include: "fulltext",
            ...zoteroItemReference
        } as SourceAttachment;

    } else if (item.isAnnotation()) {
        return {
            type: "annotation",
            ...zoteroItemReference,
            ...toAnnotation(item)
        } as AnnotationAttachment;

    } else if (item.isNote()) {
        return {
            type: "note",
            ...zoteroItemReference,
            parent_key: item.parentKey || undefined,
            title: item.getNoteTitle() || undefined,
            date_modified: Zotero.Date.sqlToISO8601(item.dateModified),
        } as NoteAttachment;

    } else {
        return null;
    }
}

/**
 * Fills optional display stubs on legacy message attachments from a loaded item.
 */
export function enrichMessageAttachmentStub(att: MessageAttachment, item: Zotero.Item): void {
    if (att.type === "item") {
        if (!att.item) att.item = safeStub(() => serializeItemStub(item));
    } else if (att.type === "source") {
        if (!att.attachment) att.attachment = safeStub(() => serializeAttachmentStub(item));
        if (!att.parent_item) {
            att.parent_item = safeStub(() => item.parentItem ? serializeItemStub(item.parentItem) : undefined);
        }
    }
}
