import { InputSource, ThreadSource } from '../sources';
import { createSourceFromItem, getZoteroItem } from '../../utils/sourceUtils';
import {
    MessageAttachment,
    SourceAttachment,
    AnnotationAttachment,
    NoteAttachment,
    Annotation,
    AnnotationPosition,
    isSourceAttachment,
    isAnnotationAttachment
} from './apiTypes';
import { ZoteroItemReference } from '../chat/apiTypes';

export function getAnnotationsFromItem(item: Zotero.Item): Annotation[] {
    if(!item.isAttachment()) return [];
    const annotations = item.getAnnotations();
    if(!annotations) return [];
    return annotations.map(toAnnotation).filter(Boolean) as Annotation[];
}

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
        parent_key: item.parentKey,
        annotation_type: item.annotationType,
        ...(item.annotationText && { text: item.annotationText }),
        ...(item.annotationComment && { comment: item.annotationComment }),
        color: item.annotationColor,
        page_label: item.annotationPageLabel,
        position: position,
        date_modified: new Date(item.dateModified + 'Z').toISOString(), // Convert UTC SQL datetime format to ISO string
    } as Annotation;
}


export async function toMessageAttachment(source: InputSource): Promise<MessageAttachment[]> {
    // Get the Zotero item from the source
    const item = getZoteroItem(source);
    if(!item) return [];

    // Convert to MessageAttachment (backend models)
    const zoteroItemReference = {
        library_id: source.libraryID,
        zotero_key: source.itemKey
    } as ZoteroItemReference;
    
    if(source.type === "regularItem" && item.isRegularItem()) {
        return source.childItemKeys.map((key) => {
            const item = Zotero.Items.getIDFromLibraryAndKey(source.libraryID, key)
            if(!item) return null;
            return {
                type: "source",
                include: "fulltext",
                library_id: source.libraryID,
                zotero_key: key,
            } as SourceAttachment;
        }).filter(Boolean) as SourceAttachment[];
    } else if (source.type === "attachment" && item.isAttachment()) {
        return [{
            type: "source",
            include: "fulltext",
            ...zoteroItemReference
        }] as SourceAttachment[];
    } else if (source.type === "note" && item.isNote()) {
        return [{
            type: "note",
            ...zoteroItemReference,
            ...(source.parentKey && { parent_key: source.parentKey }),
            note_content: item.getField("content"),
            date_modified: item.getField("dateModified")
        }] as NoteAttachment[];
    } else if (source.type === "annotation" && item.isAnnotation()) {
        return [{
            type: "annotation",
            ...zoteroItemReference,
            ...toAnnotation(item)
        }] as AnnotationAttachment[];
    } else if (source.type === "reader" && item.isAttachment()) {
        return [{
            ...zoteroItemReference,
            type: "source",
            include: "fulltext"
        }] as SourceAttachment[];
    } else {
        return [];
    }
}


export async function toThreadSource(attachment: MessageAttachment, messageId?: string): Promise<ThreadSource | null> {
    if (isSourceAttachment(attachment)) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
        if (!item) return null;
        return {
            ...(await createSourceFromItem(item)),
            ...(messageId && { messageId: messageId }),
        } as ThreadSource;
    }
    if (isAnnotationAttachment(attachment)) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
        if (!item) return null;
        return {
            ...(await createSourceFromItem(item)),
            ...(messageId && { messageId: messageId }),
            type: "annotation"
        } as ThreadSource;
    }
    return null;
}