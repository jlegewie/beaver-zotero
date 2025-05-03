import { InputSource, ThreadSource } from '../sources';
import { createSourceFromItem, getZoteroItem } from '../../utils/sourceUtils';
import { getCurrentPage } from '../../utils/readerUtils';
import {
    MessageAttachment,
    SourceAttachment,
    AnnotationAttachment,
    NoteAttachment,
    ReaderAttachment,
    Annotation,
    AnnotationPosition,
    isSourceAttachment,
    isReaderAttachment,
    isAnnotationAttachment
} from './apiTypes';

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
    const zoteroIdentifiers = {
        library_id: source.libraryID,
        zotero_key: source.itemKey
    }
    
    if(source.type === "regularItem" && item.isRegularItem()) {
        return source.childItemKeys.map((key) => {
            const item = Zotero.Items.getIDFromLibraryAndKey(source.libraryID, key)
            if(!item) return null;
            return {
                type: "source",
                library_id: source.libraryID,
                zotero_key: key,
            } as SourceAttachment;
        }).filter(Boolean) as SourceAttachment[];
    } else if (source.type === "attachment" && item.isAttachment()) {
        return [{
            type: "source",
            ...zoteroIdentifiers
        }] as SourceAttachment[];
    } else if (source.type === "note" && item.isNote()) {
        return [{
            type: "note",
            ...zoteroIdentifiers,
            ...(source.parentKey && { parent_key: source.parentKey }),
            note_content: item.getField("content"),
            date_modified: item.getField("dateModified")
        }] as NoteAttachment[];
    } else if (source.type === "annotation" && item.isAnnotation()) {
        return [{
            type: "annotation",
            ...toAnnotation(item)
        }] as AnnotationAttachment[];
    } else if (source.type === "reader" && item.isAttachment()) {
        // Text selection
        const currentTextSelection = source.textSelection;
        
        // Annotations from child items
        const annotations = await Promise.all(
            source.childItemKeys.map(async (key) => {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID, key);
                if(!item || !item.isAnnotation()) return null;
                return toAnnotation(item);
            })
        ).then((items) => items.filter(Boolean) as Annotation[]);
        
        // ReaderAttachment
        return [{
            type: "reader",
            ...zoteroIdentifiers,
            current_page: getCurrentPage() || 0,
            ...(currentTextSelection && { text_selection: currentTextSelection }),
            annotations: annotations
        }] as ReaderAttachment[];
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
    if (isReaderAttachment(attachment)) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.library_id, attachment.zotero_key);
        if (!item) return null;
        return {
            ...(await createSourceFromItem(item)),
            ...(messageId && { messageId: messageId }),
            type: "reader"
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