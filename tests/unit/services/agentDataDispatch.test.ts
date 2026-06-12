/**
 * Completeness lock for the Zotero data-provider dispatch map.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroDocumentRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentImageRequest: vi.fn(),
    handleZoteroViewImagesRequest: vi.fn(),
    handleZoteroAttachmentSearchRequest: vi.fn(),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleZoteroSearchRequest: vi.fn(),
    handleListItemsRequest: vi.fn(),
    handleListCollectionsRequest: vi.fn(),
    handleListTagsRequest: vi.fn(),
    handleListLibrariesRequest: vi.fn(),
    handleGetMetadataRequest: vi.fn(),
    handleGetAnnotationsRequest: vi.fn(),
    handleFindAnnotationsRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    handleAgentActionExecuteRequest: vi.fn(),
    handleReadNoteRequest: vi.fn(),
}));

import { createZoteroDataProvider } from '../../../src/services/agentDataDispatch';

// The full set of backend data-request events the Zotero plugin answers. If the
// backend adds a new data-request type for the Zotero data plane, add it here
// AND to the provider map — this list is the deliberate contract.
const EXPECTED_EVENTS = [
    'zotero_document_request',
    'zotero_attachment_page_images_request',
    'zotero_attachment_image_request',
    'zotero_view_images_request',
    'zotero_attachment_search_request',
    'external_reference_check_request',
    'zotero_data_request',
    'item_search_by_metadata_request',
    'item_search_by_topic_request',
    'zotero_search_request',
    'list_items_request',
    'get_metadata_request',
    'get_annotations_request',
    'find_annotations_request',
    'list_collections_request',
    'list_tags_request',
    'list_libraries_request',
    'read_note_request',
    'agent_action_validate',
    'agent_action_execute',
];

describe('createZoteroDataProvider dispatch map', () => {
    it('covers exactly the expected backend data-request events', () => {
        const map = createZoteroDataProvider();
        expect(Object.keys(map).sort()).toEqual([...EXPECTED_EVENTS].sort());
    });

    it('every entry has a handler and a well-formed error fallback', () => {
        const map = createZoteroDataProvider();
        for (const [event, entry] of Object.entries(map)) {
            expect(typeof entry.handle, `${event}.handle`).toBe('function');
            expect(typeof entry.errorResponse, `${event}.errorResponse`).toBe('function');
            const resp = entry.errorResponse({ request_id: 'req-1', items: [] } as any, new Error('boom'));
            // The fallback must echo the request_id so the backend can resolve
            // the pending future, and carry a response `type`.
            expect(resp.request_id, `${event} fallback request_id`).toBe('req-1');
            expect(typeof (resp as any).type, `${event} fallback type`).toBe('string');
        }
    });

    it('only agent_action_execute is serialized', () => {
        const map = createZoteroDataProvider();
        const serialized = Object.entries(map)
            .filter(([, entry]) => entry.serialize)
            .map(([event]) => event);
        expect(serialized).toEqual(['agent_action_execute']);
    });
});
