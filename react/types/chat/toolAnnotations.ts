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
    /** Raw zotero key as provided by the backend. */
    zoteroKey?: string;
    title: string;
    comment: string;
    color?: ToolAnnotationColor | null;
    rawSentenceIds?: string | null;
    sentenceIds: string[];
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
    /** Persisted Zotero annotation item ID when known. */
    zoteroItemId?: number;
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
    const locations = raw?.highlightLocations ?? raw?.highlight_locations ?? raw?.locations;
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

export function toToolAnnotationResult(
    raw: RawToolAnnotationResult,
    origin: 'stream' | 'summary' = 'stream'
): ToolAnnotationResult {
    const annotationType = toToolAnnotationType(raw);
    const libraryIdRaw = raw.libraryId ?? raw.library_id;
    const attachmentKeyRaw = raw.attachmentKey ?? raw.attachment_key ?? raw.zotero_key;
    const zoteroKeyRaw = raw.zoteroKey ?? raw.zotero_key ?? raw.attachmentKey ?? raw.attachment_key;

    const sentenceIds = normalizeSentenceIdList(raw.sentenceIds ?? raw.sentence_ids);
    const highlightLocations = annotationType === 'highlight' ? normalizeHighlightLocations(raw) : undefined;
    const notePosition = annotationType === 'note' ? normalizeNotePosition(raw) : undefined;

    const createdAtRaw = raw.createdAt ?? raw.created_at;
    const parsedCreatedAt =
        typeof createdAtRaw === 'number'
            ? createdAtRaw
            : typeof createdAtRaw === 'string'
            ? Date.parse(createdAtRaw)
            : undefined;
    const createdAt = Number.isFinite(parsedCreatedAt) ? (parsedCreatedAt as number) : Date.now();

    return {
        id: raw.id,
        annotationType,
        libraryId: typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw ?? 0),
        attachmentKey: typeof attachmentKeyRaw === 'string' ? attachmentKeyRaw : String(attachmentKeyRaw ?? ''),
        zoteroKey: typeof zoteroKeyRaw === 'string' ? zoteroKeyRaw : undefined,
        title: raw.title ?? '',
        comment: raw.comment ?? '',
        color: (raw.color ?? raw.highlight_color) ?? null,
        rawSentenceIds: raw.rawSentenceIds ?? raw.raw_sentence_ids ?? null,
        sentenceIds,
        highlightLocations,
        notePosition,
        isApplied: Boolean(raw.isApplied ?? false),
        zoteroAnnotationKey: raw.zoteroAnnotationKey ?? raw.zotero_annotation_key,
        applicationError: raw.applicationError ?? raw.application_error ?? null,
        isDeleted: Boolean(raw.isDeleted ?? false),
        pendingAttachmentOpen: Boolean(raw.pendingAttachmentOpen ?? false),
        createdAt,
        origin,
        zoteroItemId:
            typeof raw.zoteroItemId === 'number'
                ? raw.zoteroItemId
                : typeof raw.zotero_item_id === 'number'
                ? raw.zotero_item_id
                : undefined,
    };
}

function normalizeRawAnnotations(value: any): RawToolAnnotationResult[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter((candidate): candidate is RawToolAnnotationResult =>
            typeof candidate === 'object' && candidate !== null && typeof candidate.id === 'string'
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
        const candidate = value as RawToolAnnotationResult;
        if (typeof candidate.id === 'string') {
            return [candidate];
        }
    }
    return [];
}

export function annotationsFromMetadata(
    metadata: unknown,
    origin: 'stream' | 'summary' = 'summary'
): ToolAnnotationResult[] {
    if (!metadata) return [];

    const rawAnnotations = Array.isArray(metadata)
        ? normalizeRawAnnotations(metadata)
        : normalizeRawAnnotations((metadata as any)?.annotations ?? (metadata as any)?.annotation_results);

    return rawAnnotations
        .map((raw) => {
            try {
                return toToolAnnotationResult(raw, origin);
            } catch (_error) {
                return null;
            }
        })
        .filter((annotation): annotation is ToolAnnotationResult => annotation !== null);
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
