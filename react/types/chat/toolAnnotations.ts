import { BoundingBox, CoordOrigin } from '../../types/citations';

export type ToolAnnotationType = 'highlight' | 'note';

export type ToolAnnotationColor =
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'blue'
    | 'purple';

export type AnnotationStatus = 'pending' | 'applied' | 'error' | 'deleted';

export interface ToolAnnotationNotePosition {
    pageIndex: number;
    side: 'left' | 'right';
    /** Absolute X coordinate in PDF points. */
    x: number;
    /** Absolute Y coordinate in PDF points. */
    y: number;
}

export interface ToolAnnotationHighlightLocation {
    pageIndex: number;
    boxes: BoundingBox[];
}

/**
 * Represents the structure of an annotation as defined by the backend Pydantic model.
 */
export interface ToolAnnotation {
    // Backend fields
    id: string;
    message_id: string;
    toolcall_id: string;
    user_id?: string;
    library_id: number;
    attachment_key: string;
    /** Key of the Zotero annotation item, populated by the frontend after creation. */
    zotero_key?: string;
    status: AnnotationStatus;
    error_message?: string | null;
    annotation_type: ToolAnnotationType;
    title: string;
    comment: string;
    raw_sentence_ids?: string | null;
    sentence_ids: string[];
    color?: ToolAnnotationColor | null;
    note_position?: ToolAnnotationNotePosition;
    highlight_locations?: ToolAnnotationHighlightLocation[];
    created_at?: string;
    modified_at?: string;
}

export interface AnnotationStreamEvent {
    event: 'annotation';
    messageId: string;
    toolcallId: string;
    annotation: ToolAnnotation;
}

export function isAnnotationTool(functionName: string | undefined): boolean {
    if (!functionName) return false;
    return (
        functionName === 'add_highlight_annotations' ||
        functionName === 'add_note_annotations'
    );
}

function normalizeBoundingBox(raw: any): BoundingBox | null {
    if (!raw) return null;
    const l = typeof raw.l === 'number' ? raw.l : Number(raw.l);
    const t = typeof raw.t === 'number' ? raw.t : Number(raw.t);
    const r = typeof raw.r === 'number' ? raw.r : Number(raw.r);
    const b = typeof raw.b === 'number' ? raw.b : Number(raw.b);
    if ([l, t, r, b].some((value) => Number.isNaN(value))) {
        return null;
    }

    let coordOrigin: CoordOrigin;
    const rawOrigin = raw.coord_origin || raw.coordOrigin;
    if (rawOrigin === CoordOrigin.TOPLEFT || rawOrigin === 't') {
        coordOrigin = CoordOrigin.TOPLEFT;
    } else {
        coordOrigin = CoordOrigin.BOTTOMLEFT;
    }

    return {
        l,
        t,
        r,
        b,
        coord_origin: coordOrigin,
    };
}

function normalizeHighlightLocations(
    raw: any
): ToolAnnotationHighlightLocation[] | undefined {
    const locations =
        raw?.highlightLocations ?? raw?.highlight_locations ?? raw?.locations;
    if (!Array.isArray(locations) || locations.length === 0) {
        return undefined;
    }

    return locations
        .map((loc: any) => {
            const rawPageIndex =
                loc?.pageIndex ??
                loc?.page_index ??
                loc?.pageIdx ??
                loc?.page_idx ??
                loc?.page;
            if (rawPageIndex === undefined || rawPageIndex === null) {
                return null;
            }
            const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
            if (Number.isNaN(pageIndex)) {
                return null;
            }

            const rawBoxes =
                loc?.boxes ??
                loc?.boundingBoxes ??
                loc?.bboxes ??
                loc?.rects ??
                [];
            const boxes = Array.isArray(rawBoxes)
                ? (rawBoxes
                      .map(normalizeBoundingBox)
                      .filter(Boolean) as BoundingBox[])
                : [];

            return {
                pageIndex,
                boxes,
            } as ToolAnnotationHighlightLocation;
        })
        .filter(Boolean) as ToolAnnotationHighlightLocation[];
}

function normalizeNotePosition(raw: any): ToolAnnotationNotePosition | undefined {
    const notePosition = raw?.notePosition ?? raw?.note_position;
    if (!notePosition) return undefined;

    const rawPageIndex = notePosition.pageIndex ?? notePosition.page_index ?? notePosition.page_idx;
    const rawSide = notePosition.side;
    if (rawPageIndex === undefined || rawPageIndex === null || !rawSide) {
        return undefined;
    }

    const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
    if (Number.isNaN(pageIndex)) {
        return undefined;
    }

    const x = typeof notePosition.x === 'number' ? notePosition.x : Number(notePosition.x ?? 0);
    const y = typeof notePosition.y === 'number' ? notePosition.y : Number(notePosition.y ?? 0);

    const side = rawSide === 'left' ? 'left' : 'right';

    return {
        pageIndex,
        side,
        x,
        y,
    };
}

function toToolAnnotationType(raw: any): ToolAnnotationType {
    const type = raw?.annotationType ?? raw?.annotation_type ?? raw?.type;
    return type === 'note' ? 'note' : 'highlight';
}

function normalizeSentenceIdList(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter((id): id is string => typeof id === 'string');
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
    }
    return [];
}

/**
 * Deserializes and normalizes a raw annotation object from the backend
 * into a typed ToolAnnotation object. This is necessary because the
 * backend sends raw JSON, and this function ensures field names are consistent
 * (e.g., snake_case vs. camelCase) and nested structures are correctly typed.
 * @param raw - The raw annotation object from the backend.
 * @returns A typed ToolAnnotation object.
 */
export function toToolAnnotation(raw: Record<string, any>): ToolAnnotation {
    const annotationType = toToolAnnotationType(raw);
    const libraryIdRaw = raw.library_id ?? raw.libraryId;
    const attachmentKeyRaw =
        raw.attachment_key ?? raw.attachmentKey ?? raw.zotero_key;

    const sentenceIds = normalizeSentenceIdList(
        raw.sentence_ids ?? raw.sentenceIds
    );
    const highlightLocations =
        annotationType === 'highlight'
            ? normalizeHighlightLocations(raw)
            : undefined;
    const notePosition =
        annotationType === 'note' ? normalizeNotePosition(raw) : undefined;

    return {
        id: raw.id,
        message_id: raw.message_id ?? raw.messageId,
        toolcall_id: raw.toolcall_id ?? raw.toolcallId,
        user_id: raw.user_id ?? raw.userId,
        annotation_type: annotationType,
        library_id:
            typeof libraryIdRaw === 'number'
                ? libraryIdRaw
                : Number(libraryIdRaw ?? 0),
        attachment_key:
            typeof attachmentKeyRaw === 'string'
                ? attachmentKeyRaw
                : String(attachmentKeyRaw ?? ''),
        zotero_key: raw.zotero_key ?? raw.zoteroKey,
        title: raw.title ?? '',
        comment: raw.comment ?? '',
        color: raw.color ?? raw.highlight_color ?? null,
        raw_sentence_ids:
            raw.raw_sentence_ids ?? raw.rawSentenceIds ?? null,
        sentence_ids: sentenceIds,
        highlight_locations: highlightLocations,
        note_position: notePosition,
        status: raw.status ?? 'pending',
        error_message: raw.error_message ?? raw.errorMessage,
        created_at: raw.created_at ?? raw.createdAt,
        modified_at: raw.modified_at ?? raw.modifiedAt,
    };
}

function normalizeRawAnnotations(value: any): Record<string, any>[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter(
            (candidate): candidate is Record<string, any> =>
                typeof candidate === 'object' &&
                candidate !== null &&
                typeof candidate.id === 'string'
        );
    }
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return normalizeRawAnnotations(parsed);
        } catch (_error) {
            return [];
        }
    }
    if (typeof value === 'object') {
        const candidate = value as Record<string, any>;
        if (typeof candidate.id === 'string') {
            return [candidate];
        }
    }
    return [];
}

export function annotationsFromMetadata(metadata: unknown): ToolAnnotation[] {
    if (!metadata) return [];

    const rawAnnotations = Array.isArray(metadata)
        ? normalizeRawAnnotations(metadata)
        : normalizeRawAnnotations(
              (metadata as any)?.annotations ??
                  (metadata as any)?.annotation_results
          );

    return rawAnnotations
        .map((raw) => {
            try {
                return toToolAnnotation(raw);
            } catch (_error) {
                return null;
            }
        })
        .filter(
            (annotation): annotation is ToolAnnotation => annotation !== null
        );
}

export function mergeAnnotations(
    existing: ToolAnnotation[] | undefined,
    incoming: ToolAnnotation[]
): ToolAnnotation[] {
    if (!existing || existing.length === 0) {
        return [...incoming].sort(
            (a, b) =>
                Date.parse(a.created_at || '0') -
                Date.parse(b.created_at || '0')
        );
    }

    const byId = new Map(
        incoming.map((annotation) => [annotation.id, annotation] as const)
    );
    const merged = existing.map((annotation) => {
        const update = byId.get(annotation.id);
        if (!update) return annotation;
        return {
            ...annotation,
            ...update,
            status: update.status ?? annotation.status,
            zotero_key: update.zotero_key ?? annotation.zotero_key,
            error_message:
                update.error_message ?? annotation.error_message ?? null,
        };
    });

    for (const annotation of incoming) {
        if (
            !existing.some(
                (existingAnnotation) => existingAnnotation.id === annotation.id
            )
        ) {
            merged.push(annotation);
        }
    }

    return merged.sort(
        (a, b) =>
            Date.parse(a.created_at || '0') - Date.parse(b.created_at || '0')
    );
}
