/**
 * Handle find_annotations requests from the backend.
 */

import { BEAVER_ANNOTATION_COLORS } from '../../constants/annotations';
import { logger } from '../../utils/logger';
import { serializeAnnotation } from '../../utils/zoteroSerializers';
import {
    AvailableLibraryInfo,
    WSFindAnnotationsRequest,
    WSFindAnnotationsResponse,
} from '../agentProtocol';
import {
    getCollectionByIdOrName,
    getSearchableLibraries,
    isLibrarySearchable,
    validateLibraryAccess,
} from './utils';

const MAX_ANNOTATION_SCAN = 5000;
const ANNOTATION_TYPE_DB_IDS: Record<string, number> = {
    highlight: 1,
    note: 2,
    image: 3,
    ink: 4,
    underline: 5,
    text: 6,
};

type AnnotationItem = Zotero.Item & {
    annotationType?: string;
    annotationText?: string;
    annotationComment?: string;
    annotationColor?: string;
    annotationAuthorName?: string;
    annotationSortIndex?: string;
};

function itemID(item: Zotero.Item): number {
    return item.id;
}

function invalidResponse(
    request: WSFindAnnotationsRequest,
    error: string,
    errorCode: string,
    availableLibraries?: AvailableLibraryInfo[],
): WSFindAnnotationsResponse {
    return {
        type: 'find_annotations',
        request_id: request.request_id,
        annotations: [],
        total_count: 0,
        error,
        error_code: errorCode,
        available_libraries: availableLibraries,
    };
}

function cleanString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    return cleaned.length > 0 ? cleaned : null;
}

function hasNarrowingFilter(request: WSFindAnnotationsRequest): boolean {
    return Boolean(
        cleanString(request.text_contains) ||
        cleanString(request.comment_contains) ||
        cleanString(request.tag) ||
        cleanString(request.modified_in_last) ||
        cleanString(request.collection) ||
        cleanString(request.attachment_id) ||
        cleanString(request.color) ||
        cleanString(request.annotation_type) ||
        cleanString(request.author)
    );
}

function hasNativeSearchFilter(request: WSFindAnnotationsRequest): boolean {
    return Boolean(
        cleanString(request.text_contains) ||
        cleanString(request.comment_contains) ||
        cleanString(request.tag) ||
        cleanString(request.modified_in_last)
    );
}

function isValidModifiedInLast(value: string): boolean {
    return /^\d+\s+(days?|weeks?|months?|years?)$/i.test(value);
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function parseAttachmentId(attachmentId: string | null): { libraryId: number; key: string } | null {
    if (!attachmentId) return null;
    const dashIndex = attachmentId.indexOf('-');
    if (dashIndex === -1) return null;
    const libraryId = parseInt(attachmentId.substring(0, dashIndex), 10);
    const key = attachmentId.substring(dashIndex + 1);
    if (!Number.isFinite(libraryId) || !key) return null;
    return { libraryId, key };
}

function getDateSortValue(annotation: Zotero.Item, sortBy: string): number {
    const raw = sortBy === 'date_added' ? annotation.dateAdded : annotation.dateModified;
    const time = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
}

function getReadingOrderValue(annotation: AnnotationItem): string {
    const parent = annotation.parentID ?? 0;
    const sortIndex = annotation.annotationSortIndex ?? '';
    return `${String(parent).padStart(12, '0')}:${sortIndex}`;
}

function sortAnnotations(
    annotations: AnnotationItem[],
    sortBy: string,
    sortOrder: string,
): AnnotationItem[] {
    const direction = sortOrder === 'asc' ? 1 : -1;
    return annotations.sort((a, b) => {
        if (sortBy === 'reading_order') {
            return getReadingOrderValue(a).localeCompare(getReadingOrderValue(b)) * direction;
        }
        const diff = getDateSortValue(a, sortBy) - getDateSortValue(b, sortBy);
        if (diff !== 0) return diff * direction;
        return (itemID(a) - itemID(b)) * direction;
    });
}

async function collectCollectionScope(collection: any, recursive: boolean): Promise<any[]> {
    const collections: any[] = [];
    const queue: any[] = [collection];
    const seen = new Set<number>();

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current.id)) {
            continue;
        }
        seen.add(current.id);

        await current.loadDataType?.('childItems');
        if (recursive) {
            await current.loadDataType?.('childCollections');
        }
        collections.push(current);

        if (recursive) {
            const children = current.getChildCollections?.(false, false) ?? [];
            queue.push(...children);
        }
    }

    return collections;
}

async function getCollectionAnnotationIDs(collection: any, recursive: boolean): Promise<Set<number>> {
    const collections = await collectCollectionScope(collection, recursive);

    const memberMap = new Map<number, Zotero.Item>();
    for (const col of collections) {
        const children = col.getChildItems(false) ?? [];
        for (const item of children) {
            if (item?.id) {
                memberMap.set(item.id, item);
            }
        }
    }

    const members = Array.from(memberMap.values());
    if (members.length === 0) {
        return new Set();
    }

    await Zotero.Items.loadDataTypes(members, ['primaryData', 'itemData', 'childItems']);

    const attachments: Zotero.Item[] = [];
    for (const member of members) {
        if (member.isFileAttachment?.()) {
            attachments.push(member);
            continue;
        }
        const attachmentIDs = member.getAttachments?.() ?? [];
        if (attachmentIDs.length > 0) {
            const loaded = await Zotero.Items.getAsync(attachmentIDs);
            attachments.push(...loaded.filter((item: Zotero.Item | false): item is Zotero.Item => Boolean(item)));
        }
    }

    if (attachments.length === 0) {
        return new Set();
    }
    await Zotero.Items.loadDataTypes(attachments, ['primaryData', 'itemData', 'childItems']);

    const allowed = new Set<number>();
    for (const attachment of attachments) {
        for (const annotation of attachment.getAnnotations?.() ?? []) {
            allowed.add(itemID(annotation));
        }
    }
    return allowed;
}

async function getAttachmentAnnotationIDs(attachment: Zotero.Item): Promise<Set<number>> {
    await Zotero.Items.loadDataTypes([attachment], ['primaryData', 'itemData', 'childItems']);
    return new Set((attachment.getAnnotations?.() ?? []).map(annotation => itemID(annotation)));
}

async function buildParentInfo(
    annotations: AnnotationItem[],
): Promise<{
    attachmentInfoByID: Map<number, { item_id: string }>;
    itemInfoByAttachmentID: Map<number, { item_id: string; title: string } | null>;
}> {
    const attachmentIDs = Array.from(new Set(annotations.map(a => a.parentID).filter((id): id is number => Boolean(id))));
    const attachmentInfoByID = new Map<number, { item_id: string }>();
    const itemInfoByAttachmentID = new Map<number, { item_id: string; title: string } | null>();

    if (attachmentIDs.length === 0) {
        return { attachmentInfoByID, itemInfoByAttachmentID };
    }

    const attachments = (await Zotero.Items.getAsync(attachmentIDs))
        .filter((item: Zotero.Item | false): item is Zotero.Item => Boolean(item));
    if (attachments.length > 0) {
        await Zotero.Items.loadDataTypes(attachments, ['primaryData', 'itemData']);
    }

    const regularParentIDs = Array.from(new Set(attachments.map(att => att.parentID).filter((id): id is number => Boolean(id))));
    const regularParents = regularParentIDs.length > 0
        ? (await Zotero.Items.getAsync(regularParentIDs)).filter((item: Zotero.Item | false): item is Zotero.Item => Boolean(item))
        : [];
    if (regularParents.length > 0) {
        await Zotero.Items.loadDataTypes(regularParents, ['primaryData', 'itemData']);
    }
    const regularByID = new Map<number, Zotero.Item>();
    for (const parent of regularParents) {
        regularByID.set(itemID(parent), parent);
    }

    for (const attachment of attachments) {
        attachmentInfoByID.set(itemID(attachment), {
            item_id: `${attachment.libraryID}-${attachment.key}`,
        });

        const parent = attachment.parentID ? regularByID.get(attachment.parentID) : null;
        if (!parent) {
            itemInfoByAttachmentID.set(itemID(attachment), null);
            continue;
        }

        let title = '';
        try {
            title = (parent.getField('title') as string) || '';
        } catch {
            title = parent.getDisplayTitle?.() || '';
        }
        itemInfoByAttachmentID.set(itemID(attachment), {
            item_id: `${parent.libraryID}-${parent.key}`,
            title,
        });
    }

    return { attachmentInfoByID, itemInfoByAttachmentID };
}

async function loadAnnotationItems(annotationIDs: number[]): Promise<AnnotationItem[]> {
    const candidates = annotationIDs.length > 0
        ? (await Zotero.Items.getAsync(annotationIDs)).filter((item: Zotero.Item | false): item is Zotero.Item => Boolean(item)) as AnnotationItem[]
        : [];
    if (candidates.length > 0) {
        await Zotero.Items.loadDataTypes(candidates, ['primaryData', 'itemData', 'tags', 'annotationDeferred']);
    }
    return candidates;
}

async function serializeAnnotationPage(
    request: WSFindAnnotationsRequest,
    page: AnnotationItem[],
    totalCount: number,
    note: string | null,
): Promise<WSFindAnnotationsResponse> {
    const { attachmentInfoByID, itemInfoByAttachmentID } = await buildParentInfo(page);
    const annotations = page.map(annotation =>
        serializeAnnotation(
            annotation,
            attachmentInfoByID.get(annotation.parentID || 0) ?? null,
            itemInfoByAttachmentID.get(annotation.parentID || 0) ?? null,
        )
    );

    logger(`handleFindAnnotationsRequest: Returning ${annotations.length}/${totalCount} annotations`, 1);
    return {
        type: 'find_annotations',
        request_id: request.request_id,
        annotations,
        total_count: totalCount,
        note,
    };
}

async function queryAnnotationIDsFromDB(options: {
    libraryID: number;
    colorHex: string | null;
    annotationType: string | null;
    author: string | null;
    attachmentScopeItemID: number | null;
    sortBy: string;
    sortOrder: string;
    limit: number;
    offset: number;
    capBareScan: boolean;
}): Promise<{ ids: number[]; totalCount: number; note: string | null; invalidAnnotationType: boolean }> {
    const where = [
        'I.libraryID = ?',
        `I.itemID NOT IN (
            SELECT itemID FROM deletedItems
            UNION SELECT itemID FROM itemAnnotations
                WHERE parentItemID IN (SELECT itemID FROM deletedItems)
            UNION SELECT itemID FROM itemAnnotations
                WHERE parentItemID IN (
                    SELECT itemID FROM itemAttachments
                    WHERE parentItemID IN (SELECT itemID FROM deletedItems)
                )
        )`,
    ];
    const params: any[] = [options.libraryID];

    if (options.colorHex) {
        // Color names intentionally map to exact Beaver/Zotero palette hexes.
        where.push('LOWER(IA.color) = ?');
        params.push(options.colorHex.toLowerCase());
    }

    if (options.annotationType) {
        const typeID = ANNOTATION_TYPE_DB_IDS[options.annotationType];
        if (!typeID) {
            return { ids: [], totalCount: 0, note: null, invalidAnnotationType: true };
        }
        where.push('IA.type = ?');
        params.push(typeID);
    }

    if (options.author) {
        where.push("LOWER(COALESCE(IA.authorName, '')) LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(options.author.toLowerCase())}%`);
    }

    if (options.attachmentScopeItemID !== null) {
        where.push('IA.parentItemID = ?');
        params.push(options.attachmentScopeItemID);
    }

    let totalCount = 0;
    await Zotero.DB.queryAsync(
        `SELECT COUNT(*)
         FROM itemAnnotations IA
         JOIN items I ON I.itemID = IA.itemID
         WHERE ${where.join(' AND ')}`,
        params,
        {
            onRow: (row: any) => {
                totalCount = row.getResultByIndex(0) as number;
            },
        },
    );

    let note: string | null = null;
    let effectiveTotal = totalCount;
    let effectiveLimit = options.limit;
    if (options.capBareScan && totalCount > MAX_ANNOTATION_SCAN) {
        effectiveTotal = MAX_ANNOTATION_SCAN;
        note = `Result set was truncated to the most relevant ${MAX_ANNOTATION_SCAN} annotations before pagination. Add a filter to scan the full matching set.`;
        effectiveLimit = Math.max(0, Math.min(options.limit, MAX_ANNOTATION_SCAN - options.offset));
    }

    if (effectiveLimit <= 0 || options.offset >= effectiveTotal) {
        return { ids: [], totalCount: effectiveTotal, note, invalidAnnotationType: false };
    }

    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const orderBy = options.sortBy === 'reading_order'
        ? `IA.parentItemID ${sortOrder}, IA.sortIndex ${sortOrder}, IA.itemID ${sortOrder}`
        : options.sortBy === 'date_added'
            ? `I.dateAdded ${sortOrder}, I.itemID ${sortOrder}`
            : `I.dateModified ${sortOrder}, I.itemID ${sortOrder}`;

    const ids: number[] = [];
    await Zotero.DB.queryAsync(
        `SELECT IA.itemID
         FROM itemAnnotations IA
         JOIN items I ON I.itemID = IA.itemID
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
        [...params, effectiveLimit, options.offset],
        {
            onRow: (row: any) => {
                ids.push(row.getResultByIndex(0) as number);
            },
        },
    );

    return { ids, totalCount: effectiveTotal, note, invalidAnnotationType: false };
}

/**
 * Return paginated annotations matching library-wide filters.
 */
export async function handleFindAnnotationsRequest(
    request: WSFindAnnotationsRequest
): Promise<WSFindAnnotationsResponse> {
    logger('handleFindAnnotationsRequest: Finding annotations', 1);

    try {
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return invalidResponse(
                request,
                validation.error || 'Library not found',
                validation.error_code || 'library_not_found',
                validation.available_libraries,
            );
        }

        let library = validation.library!;
        let collection: any | null = null;
        let attachmentScopeItemID: number | null = null;
        let attachmentScopeItem: Zotero.Item | null = null;
        const collectionInput = cleanString(request.collection);
        if (collectionInput) {
            const result = getCollectionByIdOrName(collectionInput, library.libraryID);
            if (!result) {
                return invalidResponse(request, `Collection not found: ${collectionInput}`, 'collection_not_found');
            }
            if (result.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(result.libraryID);
                if (!resolvedLib || !isLibrarySearchable(result.libraryID)) {
                    return invalidResponse(
                        request,
                        `Collection "${result.collection.name}" is in a library that is not synced with Beaver.`,
                        'library_not_searchable',
                        getSearchableLibraries(),
                    );
                }
                library = resolvedLib;
            }
            collection = result.collection;
        }

        const attachmentInput = cleanString(request.attachment_id);
        if (attachmentInput) {
            const parsed = parseAttachmentId(attachmentInput);
            if (!parsed) {
                return invalidResponse(request, 'Invalid attachment_id format', 'invalid_attachment_id');
            }
            const attachment = await Zotero.Items.getByLibraryAndKeyAsync(parsed.libraryId, parsed.key);
            if (!attachment) {
                return invalidResponse(request, 'Attachment not found', 'not_found');
            }
            if (!attachment.isFileAttachment?.()) {
                return invalidResponse(request, 'Item is not a file attachment', 'not_attachment');
            }
            if (attachment.libraryID !== library.libraryID) {
                const resolvedLib = Zotero.Libraries.get(attachment.libraryID);
                if (!resolvedLib || !isLibrarySearchable(attachment.libraryID)) {
                    return invalidResponse(
                        request,
                        `Attachment "${attachmentInput}" is in a library that is not synced with Beaver.`,
                        'library_not_searchable',
                        getSearchableLibraries(),
                    );
                }
                library = resolvedLib;
            }
            attachmentScopeItemID = itemID(attachment);
            attachmentScopeItem = attachment;
        }

        const colorName = cleanString(request.color);
        const colorHex = colorName ? BEAVER_ANNOTATION_COLORS[colorName] : null;
        if (colorName && !colorHex) {
            return invalidResponse(request, `Unknown annotation color: ${colorName}`, 'invalid_color');
        }
        const modifiedInLast = cleanString(request.modified_in_last);
        if (modifiedInLast && !isValidModifiedInLast(modifiedInLast)) {
            return invalidResponse(
                request,
                `Invalid modified_in_last value "${modifiedInLast}". Use a value like "30 days", "2 weeks", "6 months", or "1 year".`,
                'invalid_modified_in_last',
            );
        }

        const annotationType = cleanString(request.annotation_type);
        const author = cleanString(request.author)?.toLowerCase() ?? null;
        const sortBy = request.sort_by || 'date_modified';
        const sortOrder = request.sort_order === 'asc' ? 'asc' : 'desc';
        const offset = Math.max(0, request.offset || 0);
        const limit = Math.min(Math.max(1, request.limit || 25), 50);

        if (!collection && !hasNativeSearchFilter(request)) {
            const dbResult = await queryAnnotationIDsFromDB({
                libraryID: library.libraryID,
                colorHex,
                annotationType,
                author,
                attachmentScopeItemID,
                sortBy,
                sortOrder,
                limit,
                offset,
                capBareScan: !hasNarrowingFilter(request),
            });
            if (dbResult.invalidAnnotationType) {
                return invalidResponse(request, `Unknown annotation type: ${annotationType}`, 'invalid_annotation_type');
            }
            const page = await loadAnnotationItems(dbResult.ids);
            return serializeAnnotationPage(request, page, dbResult.totalCount, dbResult.note);
        }

        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;
        search.addCondition('itemType', 'is', 'annotation');
        if (cleanString(request.text_contains)) {
            search.addCondition('annotationText', 'contains', cleanString(request.text_contains)!);
        }
        if (cleanString(request.comment_contains)) {
            search.addCondition('annotationComment', 'contains', cleanString(request.comment_contains)!);
        }
        if (cleanString(request.tag)) {
            search.addCondition('tag', 'is', cleanString(request.tag)!);
        }
        if (modifiedInLast) {
            search.addCondition('dateModified', 'isInTheLast', modifiedInLast);
        }

        let annotationIDs = await search.search();

        if (collection) {
            const allowed = await getCollectionAnnotationIDs(collection, request.recursive !== false);
            annotationIDs = annotationIDs.filter(id => allowed.has(id));
        }

        if (attachmentScopeItemID !== null) {
            const allowed = await getAttachmentAnnotationIDs(attachmentScopeItem!);
            annotationIDs = annotationIDs.filter(id => allowed.has(id));
        }

        let candidates = await loadAnnotationItems(annotationIDs);

        if (colorHex) {
            const expected = colorHex.toLowerCase();
            candidates = candidates.filter(annotation => (annotation.annotationColor || '').toLowerCase() === expected);
        }
        if (annotationType) {
            candidates = candidates.filter(annotation => annotation.annotationType === annotationType);
        }
        if (author) {
            candidates = candidates.filter(annotation => (annotation.annotationAuthorName || '').toLowerCase().includes(author));
        }

        candidates = sortAnnotations(candidates, sortBy, sortOrder);

        let note: string | null = null;
        if (!hasNarrowingFilter(request) && candidates.length > MAX_ANNOTATION_SCAN) {
            candidates = candidates.slice(0, MAX_ANNOTATION_SCAN);
            note = `Result set was truncated to the most relevant ${MAX_ANNOTATION_SCAN} annotations before pagination. Add a filter to scan the full matching set.`;
        }

        const totalCount = candidates.length;
        const page = candidates.slice(offset, offset + limit);
        return serializeAnnotationPage(request, page, totalCount, note);
    } catch (error: any) {
        logger(`handleFindAnnotationsRequest: Failed: ${error}`, 1);
        return invalidResponse(
            request,
            error instanceof Error ? error.message : String(error),
            'internal_error',
        );
    }
}
