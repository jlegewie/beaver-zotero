import { BoundingBox, CoordOrigin } from '../../types/citations';

export type ToolAnnotationType = 'highlight' | 'note';

export type ToolAnnotationColor =
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'blue'
    | 'purple';

export interface ToolAnnotationNotePosition {
    pageIndex: number;
    side: 'left' | 'right';
    /** Absolute X coordinate in PDF points. */
    x: number;
    /** Absolute Y coordinate in PDF points. */
    y: number;
    /** Normalized X coordinate [0, 1]. */
    normalizedX: number;
    /** Normalized Y coordinate [0, 1]. */
    normalizedY: number;
}

export interface ToolAnnotationHighlightLocation {
    pageIndex: number;
    boxes: BoundingBox[];
}

export interface ToolAnnotationResult {
    id: string;
    annotationType: ToolAnnotationType;
    libraryId: number;
    attachmentKey: string;
    title: string;
    comment: string;
    color?: ToolAnnotationColor;
    rawSentenceIds?: string;
    sentenceIds: string[];
    missingSentenceIds: string[];
    isValid: boolean;
    errors: string[];
    highlightLocations?: ToolAnnotationHighlightLocation[];
    notePosition?: ToolAnnotationNotePosition;
    /**
     * True once the Zotero annotation has been materialised in the reader.
     */
    isApplied?: boolean;
    /**
     * Zotero annotation key once persisted. Used for navigation/deletion.
     */
    zoteroAnnotationKey?: string;
    /** Runtime error encountered when applying the annotation. */
    applicationError?: string | null;
    /** Indicates the annotation has been deleted by the user. */
    isDeleted?: boolean;
    /** Indicates the annotation still needs the reader to be opened. */
    pendingAttachmentOpen?: boolean;
    /** Timestamp of creation to maintain arrival order. */
    createdAt?: number;
    /** Identifies whether the annotation originated from streaming or summary metadata. */
    origin?: 'stream' | 'summary';
}

export interface AnnotationValidationSummary {
    annotationType: ToolAnnotationType;
    libraryId: number;
    attachmentKey: string;
    explanation?: string;
    totalAnnotations: number;
    validAnnotations: number;
    invalidAnnotations: number;
    allValid: boolean;
    annotations: ToolAnnotationResult[];
}

export interface AnnotationStreamEvent {
    event: 'annotation';
    messageId: string;
    toolcallId: string;
    annotation: ToolAnnotationResult;
}

export type RawToolAnnotationResult = Partial<Record<string, any>> & {
    id: string;
};

export type RawAnnotationValidationSummary = Partial<Record<string, any>> & {
    annotations?: RawToolAnnotationResult[];
};

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

function normalizeHighlightLocations(raw: any): ToolAnnotationHighlightLocation[] | undefined {
    const locations = raw?.highlightLocations ?? raw?.highlight_locations;
    if (!Array.isArray(locations) || locations.length === 0) {
        return undefined;
    }

    return locations
        .map((loc: any) => {
            const rawPageIndex = loc?.pageIndex ?? loc?.page_index ?? loc?.pageIdx ?? loc?.page_idx;
            if (rawPageIndex === undefined || rawPageIndex === null) {
                return null;
            }
            const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
            if (Number.isNaN(pageIndex)) {
                return null;
            }

            const rawBoxes = loc?.boxes ?? loc?.boundingBoxes ?? loc?.bboxes ?? [];
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

    const rawPageIndex = notePosition.pageIndex ?? notePosition.page_index;
    const rawSide = notePosition.side;
    if (rawPageIndex === undefined || !rawSide) {
        return undefined;
    }

    const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
    if (Number.isNaN(pageIndex)) {
        return undefined;
    }

    const x = typeof notePosition.x === 'number' ? notePosition.x : Number(notePosition.x ?? 0);
    const y = typeof notePosition.y === 'number' ? notePosition.y : Number(notePosition.y ?? 0);
    const normalizedX =
        typeof notePosition.normalizedX === 'number'
            ? notePosition.normalizedX
            : Number(notePosition.normalized_x ?? 0);
    const normalizedY =
        typeof notePosition.normalizedY === 'number'
            ? notePosition.normalizedY
            : Number(notePosition.normalized_y ?? 0);

    const side = rawSide === 'left' ? 'left' : 'right';

    return {
        pageIndex,
        side,
        x,
        y,
        normalizedX: Number.isNaN(normalizedX) ? 0 : normalizedX,
        normalizedY: Number.isNaN(normalizedY) ? 0 : normalizedY,
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

function normalizeErrors(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter((error): error is string => typeof error === 'string');
    }
    if (typeof value === 'string') {
        return [value];
    }
    return [];
}

export function toToolAnnotationResult(
    raw: RawToolAnnotationResult,
    origin: 'stream' | 'summary' = 'stream'
): ToolAnnotationResult {
    const annotationType = toToolAnnotationType(raw);
    const libraryId = raw.libraryId ?? raw.library_id;
    const attachmentKey = raw.attachmentKey ?? raw.attachment_key;

    const sentenceIds = normalizeSentenceIdList(raw.sentenceIds ?? raw.sentence_ids);
    const missingSentenceIds = normalizeSentenceIdList(
        raw.missingSentenceIds ?? raw.missing_sentence_ids
    );

    const highlightLocations = normalizeHighlightLocations(raw);
    const notePosition = normalizeNotePosition(raw);

    const result: ToolAnnotationResult = {
        id: raw.id,
        annotationType,
        libraryId: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
        attachmentKey: typeof attachmentKey === 'string' ? attachmentKey : String(attachmentKey ?? ''),
        title: raw.title ?? '',
        comment: raw.comment ?? '',
        color: raw.color ?? raw.highlight_color,
        rawSentenceIds: raw.rawSentenceIds ?? raw.raw_sentence_ids,
        sentenceIds,
        missingSentenceIds,
        isValid: Boolean(raw.isValid ?? raw.is_valid ?? true),
        errors: normalizeErrors(raw.errors),
        highlightLocations,
        notePosition,
        isApplied: Boolean(raw.isApplied ?? false),
        zoteroAnnotationKey: raw.zoteroAnnotationKey,
        applicationError: raw.applicationError ?? null,
        isDeleted: Boolean(raw.isDeleted ?? false),
        pendingAttachmentOpen: Boolean(raw.pendingAttachmentOpen ?? false),
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        origin,
    };

    return result;
}

export function toAnnotationValidationSummary(
    raw: RawAnnotationValidationSummary
): AnnotationValidationSummary {
    const libraryId = raw.libraryId ?? raw.library_id;
    const attachmentKey = raw.attachmentKey ?? raw.attachment_key;
    const annotationType = toToolAnnotationType(raw);
    const annotations = Array.isArray(raw.annotations)
        ? raw.annotations.map((annotation) => toToolAnnotationResult(annotation, 'summary'))
        : [];

    return {
        annotationType,
        libraryId: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
        attachmentKey: typeof attachmentKey === 'string' ? attachmentKey : String(attachmentKey ?? ''),
        explanation: raw.explanation,
        totalAnnotations: Number(raw.totalAnnotations ?? raw.total_annotations ?? annotations.length),
        validAnnotations: Number(raw.validAnnotations ?? raw.valid_annotations ?? 0),
        invalidAnnotations: Number(raw.invalidAnnotations ?? raw.invalid_annotations ?? 0),
        allValid: Boolean(raw.allValid ?? raw.all_valid ?? false),
        annotations,
    };
}

export function mergeAnnotations(
    existing: ToolAnnotationResult[] | undefined,
    incoming: ToolAnnotationResult[]
): ToolAnnotationResult[] {
    if (!existing || existing.length === 0) {
        return [...incoming];
    }

    const byId = new Map(incoming.map((annotation) => [annotation.id, annotation] as const));
    const merged = existing.map((annotation) => {
        const update = byId.get(annotation.id);
        if (!update) return annotation;
        return {
            ...annotation,
            ...update,
            isApplied: update.isApplied ?? annotation.isApplied,
            zoteroAnnotationKey: update.zoteroAnnotationKey ?? annotation.zoteroAnnotationKey,
            applicationError: update.applicationError ?? annotation.applicationError ?? null,
            isDeleted: update.isDeleted ?? annotation.isDeleted,
            pendingAttachmentOpen: update.pendingAttachmentOpen ?? annotation.pendingAttachmentOpen,
            createdAt: annotation.createdAt ?? update.createdAt,
            origin: annotation.origin ?? update.origin,
        };
    });

    for (const annotation of incoming) {
        if (!existing.some((existingAnnotation) => existingAnnotation.id === annotation.id)) {
            merged.push(annotation);
        }
    }

    return merged.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
