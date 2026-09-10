import { mcpError, generateRequestId, buildNoopTimeoutContext } from './utils';
import {
    handleListLibrariesRequest,
    handleFindAnnotationsRequest,
    validateCreateHighlightAnnotationsAction,
    executeCreateHighlightAnnotationsAction,
    validateCreateNoteAnnotationsAction,
    executeCreateNoteAnnotationsAction,
} from '../../../src/services/agentDataProvider';
import type { WSFindAnnotationsRequest } from '@beaver/agent-core/protocol/agentProtocol';
import { resolveObjectId, modelObjectIdFromReference, UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';
import { getZoteroSelectURI } from '../../../src/utils/zoteroUtils';

const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const colors = ['yellow', 'red', 'green', 'blue', 'purple', 'magenta', 'orange', 'gray'];
const string = { type: 'string', minLength: 1 };
const pageIndex = { type: 'integer', minimum: 0 };
const origin = { type: 'string', enum: ['t', 'b'], description: 't = top-left, b = bottom-left.' };
const boxSchema = {
    type: 'object', additionalProperties: false, required: ['l', 't', 'r', 'b', 'coord_origin'],
    properties: { l: { type: 'number' }, t: { type: 'number' }, r: { type: 'number' }, b: { type: 'number' }, coord_origin: origin },
};
const locationSchema = {
    type: 'object', additionalProperties: false, required: ['page_idx', 'boxes'],
    properties: {
        page_idx: pageIndex,
        boxes: { type: 'array', minItems: 1, maxItems: 1000, items: boxSchema },
        page_label: string,
        reading_order_offset: pageIndex,
    },
};
const notePositionSchema = {
    type: 'object', additionalProperties: false, required: ['page_index', 'x', 'y', 'side', 'coord_origin'],
    properties: {
        page_index: pageIndex, x: { type: 'number' }, y: { type: 'number' },
        side: { type: 'string', enum: ['left', 'right'] }, coord_origin: origin,
    },
};

export const LIST_LIBRARIES_TOOL = {
    name: 'list_libraries', annotations: { title: 'List Libraries', ...readHints },
    description: 'List Zotero libraries available to Beaver, with portable library_ref, name, read-only status, and item, note, collection, and tag counts. Excluded libraries are omitted. Use library_ref as the library argument of other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const FIND_ANNOTATIONS_TOOL = {
    name: 'find_annotations', annotations: { title: 'Find Annotations', ...readHints },
    description: 'Find highlights, underlines, and note annotations in a Zotero library. Filters are combined with AND; supply at least one filter besides library. Returns annotation text, comments, tags, source IDs, and pagination. Defaults to the personal library; use list_libraries for other libraries.',
    inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
            text_contains: { ...string, description: 'Substring in highlighted text.' },
            comment_contains: { ...string, description: 'Substring in annotation comments.' },
            tag: string, color: { ...string, description: 'Zotero color name or hex color (matched to nearest palette color).' },
            annotation_type: { type: 'string', enum: ['highlight', 'underline', 'note'] },
            author: string,
            attachment_id: { ...string, description: 'Attachment or parent item ID from another tool.' },
            collection: { ...string, description: 'Collection ID or name.' },
            library: { type: ['string', 'integer'], description: 'Library ref (u or g<groupID>), numeric ID, or name.' },
            recursive: { type: 'boolean', default: true },
            modified_in_last: { ...string, description: 'Relative duration, e.g. "7 days" or "2 months".' },
            sort_by: { type: 'string', enum: ['date_modified', 'date_added', 'reading_order'], default: 'date_modified' },
            sort_order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            offset: { type: 'integer', minimum: 0, default: 0 },
        },
    },
};

function creationTool(highlight: boolean) {
    return {
        name: highlight ? 'create_highlight_annotations' : 'create_note_annotations',
        annotations: { title: highlight ? 'Create Highlight Annotations' : 'Create Note Annotations', ...writeHints },
        description: `Create a batch of ${highlight ? 'highlights' : 'sticky-note annotations (not standalone Zotero notes)'} on one local PDF, EPUB, or HTML snapshot attachment. ` +
            'For PDFs, copy exact page_locations or note_position from read_attachment with include_annotation_locations=true; never guess coordinates. ' +
            'The same read option returns EPUB section and text/anchor locators; snapshots use text or anchor_id. ' +
            'Writes immediately after validation; the MCP client handles approval. Returns created annotation IDs and per-item failures. ' +
            'A multi-page highlight creates one annotation per page. Retrying successful items creates duplicates; retry only failed items.',
        inputSchema: {
            type: 'object', additionalProperties: false, required: ['attachment_id', 'items'],
            properties: {
                attachment_id: { ...string, description: 'Attachment ID from search or get_item_details, e.g. u-ABC12345.' },
                tags: { type: 'array', maxItems: 100, items: string },
                items: {
                    type: 'array', minItems: 1, maxItems: 50,
                    items: {
                        type: 'object', additionalProperties: false, required: [highlight ? 'text' : 'comment'],
                        properties: {
                            text: { ...string, description: 'Exact source passage. Required for highlights; optional anchor for notes.' },
                            comment: { type: 'string', ...(highlight ? {} : { minLength: 1 }) },
                            color: { type: 'string', enum: colors, default: 'yellow' },
                            page_label: string,
                            ...(highlight ? { page_locations: { type: 'array', minItems: 1, maxItems: 30, items: locationSchema } }
                                : { note_position: notePositionSchema, reading_order_offset: pageIndex }),
                            section_href: string,
                            section_ordinal: { type: 'integer', minimum: 1 },
                            anchor_id: string,
                        },
                    },
                },
            },
        },
    };
}
export const CREATE_HIGHLIGHT_ANNOTATIONS_TOOL = creationTool(true);
export const CREATE_NOTE_ANNOTATIONS_TOOL = creationTool(false);

/** Validate the JSON Schema subset used by these tools, including direct HTTP calls. */
function validateInput(value: any, schema: any, path = 'arguments'): void {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type: string) => type === 'integer' ? Number.isSafeInteger(value)
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'array' ? Array.isArray(value)
                : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
                    : typeof value === type);
    if (!matches) throw new Error(`${path} must be ${types.join(' or ')}.`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(', ')}.`);
    if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) {
        throw new Error(`${path} is outside the allowed range (${schema.minimum ?? '-infinity'}–${schema.maximum ?? 'infinity'}).`);
    }
    if (typeof value === 'string' && schema.minLength && value.trim().length < schema.minLength) throw new Error(`${path} cannot be empty.`);
    if (Array.isArray(value)) {
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path} has an invalid number of items.`);
        value.forEach((item, index) => validateInput(item, schema.items, `${path}[${index}]`));
    } else if (value !== null && typeof value === 'object') {
        for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required.`);
        for (const [key, item] of Object.entries(value)) {
            if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) throw new Error(`Unknown argument: ${path}.${key}.`);
            validateInput(item, schema.properties[key], `${path}.${key}`);
        }
    }
}

export async function handleListLibraries(args: unknown = {}): Promise<any> {
    try {
        validateInput(args, LIST_LIBRARIES_TOOL.inputSchema);
        const response = await handleListLibrariesRequest({ event: 'list_libraries_request', request_id: generateRequestId() });
        if (response.error) return mcpError(response.error);
        return { libraries: response.libraries, total_count: response.total_count };
    } catch (error) { return mcpError(error); }
}

export async function handleFindAnnotations(args: any = {}): Promise<any> {
    try {
        validateInput(args, FIND_ANNOTATIONS_TOOL.inputSchema);
        const { library, ...filters } = args;
        const request: WSFindAnnotationsRequest = {
            ...filters, event: 'find_annotations_request', request_id: generateRequestId(), library_id: library,
            recursive: args.recursive ?? true, sort_by: args.sort_by ?? 'date_modified', sort_order: args.sort_order ?? 'desc',
            limit: args.limit ?? 25, offset: args.offset ?? 0,
        };
        const response = await handleFindAnnotationsRequest(request);
        if (response.error) return mcpError(response.error);
        const next = request.offset + response.annotations.length;
        const hasMore = response.annotations.length > 0 && next < response.total_count;
        return {
            annotations: response.annotations.map(annotation => {
                const ref = resolveObjectId(annotation.annotation_id);
                return { ...annotation, zotero_uri: ref && ref.library_id !== UNRESOLVED_LIBRARY_ID ? getZoteroSelectURI(ref.library_id, ref.zotero_key) : null };
            }),
            total_count: response.total_count, has_more: hasMore, next_offset: hasMore ? next : null,
            ...(response.note ? { note: response.note } : {}),
        };
    } catch (error) { return mcpError(error); }
}

async function createAnnotations(args: any, highlight: boolean): Promise<any> {
    try {
        const tool = highlight ? CREATE_HIGHLIGHT_ANNOTATIONS_TOOL : CREATE_NOTE_ANNOTATIONS_TOOL;
        validateInput(args, tool.inputSchema);
        const ref = resolveObjectId(args.attachment_id);
        if (!ref) throw new Error('Invalid attachment_id. Use an ID returned by search or get_item_details.');
        if (ref.library_id === UNRESOLVED_LIBRARY_ID) throw new Error('The attachment library is not available on this computer.');
        for (const [index, item] of args.items.entries()) {
            for (const location of item.page_locations ?? []) {
                for (const box of location.boxes) {
                    if (box.r <= box.l || (box.coord_origin === 't' ? box.b <= box.t : box.t <= box.b)) {
                        throw new Error(`items[${index}] contains an empty or inverted bounding box.`);
                    }
                }
            }
        }
        const actionType = highlight ? 'create_highlight_annotations' : 'create_note_annotations';
        const data = {
            requested_ref: ref, resolved_ref: ref, tags: args.tags,
            items: args.items.map((item: any, index: number) => ({
                ...item, index, client_item_id: String(index), title: '', loc_raw: '',
                loc: { kind: 'unknown', value: '', raw: '' }, color: item.color ?? 'yellow',
            })),
        };
        const validate = highlight ? validateCreateHighlightAnnotationsAction : validateCreateNoteAnnotationsAction;
        const execute = highlight ? executeCreateHighlightAnnotationsAction : executeCreateNoteAnnotationsAction;
        const validation = await validate({ event: 'agent_action_validate', request_id: generateRequestId(), action_type: actionType, action_data: data });
        if (!validation.valid) return mcpError(validation.error ?? 'Annotation validation failed.');
        const kind = validation.current_value?.content_kind;
        for (const [index, item] of args.items.entries()) {
            if (kind === 'pdf' && !(highlight ? item.page_locations : item.note_position)) {
                throw new Error(`items[${index}] requires ${highlight ? 'page_locations' : 'note_position'} for a PDF. Read with include_annotation_locations=true first.`);
            }
            if (kind === 'epub' && !item.section_href && !item.section_ordinal) {
                throw new Error(`items[${index}] requires section_href or section_ordinal for an EPUB.`);
            }
            if (kind === 'snapshot' && !item.text && !item.anchor_id) {
                throw new Error(`items[${index}] requires text or anchor_id for a snapshot.`);
            }
        }
        const response = await execute({
            event: 'agent_action_execute', request_id: generateRequestId(), action_type: actionType,
            action_data: { ...data, ...validation.normalized_action_data },
        }, buildNoopTimeoutContext());
        if (!response.success) return mcpError(response.error ?? 'Annotation creation failed.');
        const result = response.result_data ?? {};
        const output = {
            attachment_id: modelObjectIdFromReference(ref),
            created: (result.created ?? []).map((annotation: any) => ({
                ...annotation, annotation_id: modelObjectIdFromReference(annotation),
                zotero_uri: getZoteroSelectURI(annotation.library_id, annotation.zotero_key),
            })),
            failed: result.failed ?? [], total_created: result.total_created ?? 0, total_failed: result.total_failed ?? 0,
        };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], ...(output.total_failed > 0 ? { isError: true } : {}) };
    } catch (error) { return mcpError(error); }
}
export const handleCreateHighlightAnnotations = (args: any) => createAnnotations(args, true);
export const handleCreateNoteAnnotations = (args: any) => createAnnotations(args, false);
