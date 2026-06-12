import { describe, it, expect } from 'vitest';
import {
    CLIENT_FEATURES,
    ZOTERO_PLUGIN_CLIENT_TYPE,
    ZOTERO_PLUGIN_FEATURES,
} from '../../../src/services/agentProtocol';

// Guards the client-feature handshake (Lane C). The string values MUST match the
// backend's FEAT_* constants exactly — a drift silently disables tools server-side
// rather than erroring, so it is asserted here against a frozen expected list.
const EXPECTED_FEATURE_STRINGS = [
    'library_management',
    'manage_library_structure',
    'note_support',
    'note_append',
    'annotation_support',
    'find_annotations',
    'extract',
    'beaver_extract',
    'image_extraction',
    'view_page_images',
    'read_tool',
    'view_tool',
    'find_in_attachments',
    'filter_only_search',
    'sentence_level_citation',
    'unified_citation_format',
    'external_search_surcharge',
    'edit_metadata_creators',
    'document_payload_budget',
].sort();

describe('client feature declaration (Lane C)', () => {
    it('declares the Zotero plugin client type', () => {
        expect(ZOTERO_PLUGIN_CLIENT_TYPE).toBe('zotero-plugin');
    });

    it('feature vocabulary matches the backend FEAT_* string values exactly', () => {
        expect(Object.values(CLIENT_FEATURES).slice().sort()).toEqual(EXPECTED_FEATURE_STRINGS);
    });

    it('the Zotero plugin declares the full current feature set', () => {
        expect(ZOTERO_PLUGIN_FEATURES.slice().sort()).toEqual(EXPECTED_FEATURE_STRINGS);
    });

    it('declares no duplicate features', () => {
        expect(new Set(ZOTERO_PLUGIN_FEATURES).size).toBe(ZOTERO_PLUGIN_FEATURES.length);
    });
});
