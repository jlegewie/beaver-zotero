import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/zoteroInstanceWire', () => ({ buildZoteroInstanceWire: () => ({ local_user_key: 'test', index_scope_refs: [] }) }));
import { registerZoteroClientIdentity } from '../../../src/services/zoteroClientIdentity';
import { resolveClientIdentity } from '@beaver/agent-core/transport/clientIdentity';
import { EPUB_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/epub/schema';
import { SNAPSHOT_SCHEMA_VERSION } from '@beaver/agent-core/extract/document/snapshot/schema';
import { producibleExtractionSchemaVersions } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';

beforeEach(() => {
    vi.stubGlobal('Zotero', { Beaver: { pluginVersion: 'test', searchableLibraryIds: [] } });
});

it('declares the current and producible extraction schema versions at connect', () => {
    registerZoteroClientIdentity();
    expect(resolveClientIdentity().extractSchemaVersions).toEqual({
        pdf: { current: '5', producible: ['4', '5'] },
        epub: { current: EPUB_SCHEMA_VERSION, producible: [EPUB_SCHEMA_VERSION] },
        snapshot: { current: SNAPSHOT_SCHEMA_VERSION, producible: [SNAPSHOT_SCHEMA_VERSION] },
    });
});

it('produces no versions for unversioned text documents', () => {
    expect(producibleExtractionSchemaVersions('text')).toEqual([]);
});
