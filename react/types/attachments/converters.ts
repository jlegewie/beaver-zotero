import {
    MessageAttachment,
    SourceAttachment,
    AnnotationAttachment,
    Annotation,
    AnnotationPosition,
    ItemMetadataAttachment
} from './apiTypes';
import { ZoteroItemReference } from '../zotero';

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
        date_modified: Zotero.Date.sqlToISO8601(item.dateModified), // Convert UTC SQL datetime format to ISO string
    } as Annotation;
}


export function toMessageAttachment(item: Zotero.Item): MessageAttachment | null {
    // Convert to MessageAttachment (backend models)
    const zoteroItemReference = {
        library_id: item.libraryID,
        zotero_key: item.key
    } as ZoteroItemReference;
    
    if(item.isRegularItem()) {
        return {
            type: "item",
            ...zoteroItemReference
        } as ItemMetadataAttachment;

    } else if (item.isAttachment()) {
        return {
            type: "source",
            include: "fulltext",
            ...zoteroItemReference
        } as SourceAttachment;

    } else if (item.isAnnotation()) {
        return {
            type: "annotation",
            ...zoteroItemReference,
            ...toAnnotation(item)
        } as AnnotationAttachment;

    } else {
        return null;
    }
}