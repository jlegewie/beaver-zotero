import { atom } from "jotai";
import { ToolAnnotation, mergeAnnotations } from '../types/chat/toolAnnotations';


/*
* Tool call annotations stored in a map of tool call ID to annotations.
*/
export const toolCallAnnotationsAtom = atom<Map<string, ToolAnnotation[]>>(new Map());
export const getToolCallAnnotationsAtom = atom(
    (get) => (toolCallId: string) => get(toolCallAnnotationsAtom).get(toolCallId) || []
);

// All annotations stored in a flat array
export const allAnnotationsAtom = atom((get) => {
    const annotationsMap = get(toolCallAnnotationsAtom);
    return Array.from(annotationsMap.values()).flat();
});


/**
 * Upserts tool call annotations
 */
export const upsertToolcallAnnotationAtom = atom(
    null,
    (get, set, {toolcallId, annotations} : { toolcallId: string; annotations: ToolAnnotation[] }) => {
        set(toolCallAnnotationsAtom, (prevMap) => {
            const newMap = new Map(prevMap);
            const existingAnnotations = newMap.get(toolcallId) || [];
            const mergedAnnotations = mergeAnnotations(existingAnnotations, annotations);
            newMap.set(toolcallId, mergedAnnotations);
            return newMap;
        });
    }
);

/**
 * Updates a tool call annotation
 */
export const updateToolcallAnnotationAtom = atom(
    null,
    (get, set, { toolcallId, annotationId, updates }: { toolcallId: string; annotationId?: string; updates: Partial<ToolAnnotation> }) => {
        set(toolCallAnnotationsAtom, (prevMap) => {
            const newMap = new Map(prevMap);
            const annotations = newMap.get(toolcallId);
            
            if (!annotations) return prevMap; // No annotations for this tool call
            
            const updatedAnnotations = annotations.map((annotation) =>
                annotationId === undefined || annotation.id === annotationId
                    ? { ...annotation, ...updates }
                    : annotation
            );
            
            newMap.set(toolcallId, updatedAnnotations);
            return newMap;
        });
    }
);

/**
 * Updates a tool call annotation
 */
export interface AnnotationUpdates {
    annotationId: string;
    updates: Partial<ToolAnnotation>;
}

export const updateToolcallAnnotationsAtom = atom(
    null,
    (get, set, { toolcallId, updates }: { toolcallId: string; updates: AnnotationUpdates[] }) => {
        set(toolCallAnnotationsAtom, (prevMap) => {
            const newMap = new Map(prevMap);
            const annotations = newMap.get(toolcallId);
            
            if (!annotations) return prevMap; // No annotations for this tool call
            
            const updatesById = new Map(updates.map(u => [u.annotationId, u.updates]));
            
            const updatedAnnotations = annotations.map((annotation) => {
                const annotationUpdates = updatesById.get(annotation.id);
                return annotationUpdates
                    ? { ...annotation, ...annotationUpdates }
                    : annotation;
            });
            
            newMap.set(toolcallId, updatedAnnotations);
            return newMap;
        });
    }
);