import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BeaverDB,
    DocumentCacheMetadataInput,
    DocumentCachePayloadInput,
} from '../../../src/services/database';
import { buildPdfCachedMetadata } from '../../../src/services/documentExtraction/shared/contentKinds';
import type { DocumentCachePageLabels } from '../../../src/services/database';
import type { PageGeometry } from '../../../src/beaver-extract/types';
import { MockDBConnection } from '../../mocks/mockDBConnection';

type MetadataOverrides = Partial<DocumentCacheMetadataInput> & {
    pageCount?: number | null;
    pageLabels?: DocumentCachePageLabels | null;
    pages?: (PageGeometry | null)[] | null;
};

const defaultPages: (PageGeometry | null)[] = [
    { viewBox: [0, 0, 612, 792], width: 612, height: 792, rotation: 0 },
    null,
    { viewBox: [36, 36, 576, 756], width: 540, height: 720, rotation: 90 },
];

function makeMetadata(overrides: MetadataOverrides = {}): DocumentCacheMetadataInput {
    const pageCount = 'pageCount' in overrides ? overrides.pageCount ?? null : 3;
    const pageLabels = 'pageLabels' in overrides
        ? overrides.pageLabels ?? null
        : { '0': 'i', '1': '1' };
    const pages = 'pages' in overrides ? overrides.pages ?? null : defaultPages;
    const {
        pageCount: _pageCount,
        pageLabels: _pageLabels,
        pages: _pages,
        ...recordOverrides
    } = overrides;

    return {
        itemId: 100,
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        contentKind: 'pdf',
        filePath: '/tmp/a.pdf',
        fileSignature: { mtime_ms: 10, size_bytes: 20 },
        sourceSizeBytes: 20,
        contentType: 'application/pdf',
        documentMetadata: buildPdfCachedMetadata(pageCount, pageLabels, pages),
        errorCode: null,
        extractionSchemaVersion: '4',
        metadataFormatVersion: 1,
        ...recordOverrides,
    };
}

function makePayload(overrides: Partial<DocumentCachePayloadInput> = {}): DocumentCachePayloadInput {
    return {
        metadataId: 1,
        itemId: 100,
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        mode: 'structured',
        contentKind: 'pdf',
        sourceFilePath: '/tmp/a.pdf',
        sourceFileSignature: { mtime_ms: 10, size_bytes: 20 },
        sourceSizeBytes: 20,
        payloadPath: '/cache/a.structured.hash.json.gz',
        payloadSizeBytes: 123,
        payloadSha256: 'hash',
        extractionSchemaVersion: '4',
        cacheFormatVersion: 1,
        ...overrides,
    };
}

function recreateLegacyPayloadWithoutContentKind(conn: MockDBConnection): void {
    const raw = conn.getRawDB();
    raw.exec('DROP TABLE IF EXISTS document_cache_payloads');
    raw.exec(`
        CREATE TABLE document_cache_payloads (
            id INTEGER PRIMARY KEY,
            metadata_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            library_id INTEGER NOT NULL,
            zotero_key TEXT NOT NULL,
            mode TEXT NOT NULL,
            source_file_path TEXT NOT NULL,
            source_file_mtime_ms INTEGER NOT NULL,
            source_file_size_bytes INTEGER NOT NULL,
            source_size_bytes INTEGER NOT NULL,
            payload_path TEXT NOT NULL,
            payload_size_bytes INTEGER NOT NULL,
            payload_sha256 TEXT,
            extraction_schema_version TEXT NOT NULL,
            cache_format_version INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_accessed_at TEXT,
            UNIQUE(library_id, zotero_key, mode)
        )
    `);
    raw.exec(`
        INSERT INTO document_cache_payloads (
            metadata_id, item_id, library_id, zotero_key, mode,
            source_file_path, source_file_mtime_ms, source_file_size_bytes,
            source_size_bytes, payload_path, payload_size_bytes,
            extraction_schema_version, cache_format_version
        ) VALUES (1, 100, 1, 'STALE003', 'structured', '/tmp/a.pdf',
            10, 20, 20, '/cache/old.gz', 10, '4', 1)
    `);
}

describe('BeaverDB document cache methods', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('upserts and reads metadata by library/key', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata());

        const row = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row).toMatchObject({
            itemId: 100,
            libraryId: 1,
            zoteroKey: 'ABCD1234',
            contentKind: 'pdf',
            documentMetadata: {
                content_kind: 'pdf',
                pageCount: 3,
                pageLabels: { '0': 'i', '1': '1' },
                pages: defaultPages,
            },
            pageCount: 3,
            pageLabels: { '0': 'i', '1': '1' },
            pages: defaultPages,
            errorCode: null,
        });

        const raw = conn.getRawDB();
        const stored = raw.prepare(`
            SELECT content_kind, document_metadata_json
            FROM document_cache_metadata
            WHERE library_id = 1 AND zotero_key = 'ABCD1234'
        `).get() as { content_kind: string; document_metadata_json: string };
        expect(stored.content_kind).toBe('pdf');
        expect(JSON.parse(stored.document_metadata_json)).toEqual({
            content_kind: 'pdf',
            pageCount: 3,
            pageLabels: { '0': 'i', '1': '1' },
            pages: defaultPages,
        });
    });

    it('updates the row when local item_id changes for the same library/key', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata({ itemId: 100 }));
        await db.upsertDocumentCacheMetadata(makeMetadata({ itemId: 101 }));

        const row = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.itemId).toBe(101);
        expect(await db.getDocumentCacheMetadataCount()).toBe(1);
    });

    it('deletes existing payload rows when source identity changes', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id }));

        const result = await db.upsertDocumentCacheMetadata(makeMetadata({
            fileSignature: { mtime_ms: 11, size_bytes: 20 },
        }));

        expect(result.deletedPayloads).toHaveLength(1);
        expect(await db.getDocumentCachePayload(1, 'ABCD1234', 'structured')).toBeNull();
    });

    it('round trips error code and null page labels', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata({
            pageLabels: null,
            errorCode: 'encrypted',
        }));

        const errored = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(errored?.pageLabels).toBeNull();
        expect(errored?.pages).toEqual(defaultPages);
        expect(errored?.errorCode).toBe('encrypted');

        await db.upsertDocumentCacheMetadata(makeMetadata({ errorCode: null }));
        const ready = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(ready?.errorCode).toBeNull();
    });

    it('keeps the durable document cache schema on repeated init', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id }));

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        expect(await rebuilt.getDocumentCacheMetadataCount()).toBe(1);
        expect(await rebuilt.getDocumentCachePayloadCount()).toBe(1);
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.documentMetadata).toEqual(makeMetadata().documentMetadata);
    });

    it('rebuilds a stale document cache schema without touching unrelated tables', async () => {
        const raw = conn.getRawDB();
        raw.exec('DROP TABLE IF EXISTS document_cache_payloads');
        raw.exec('DROP TABLE IF EXISTS document_cache_metadata');
        raw.exec(`
            CREATE TABLE document_cache_metadata (
                id INTEGER PRIMARY KEY, library_id INTEGER, zotero_key TEXT,
                content_kind TEXT, document_metadata_json TEXT,
                page_count INTEGER, is_encrypted INTEGER, needs_ocr INTEGER
            )
        `);
        raw.exec(`INSERT INTO document_cache_metadata (library_id, zotero_key) VALUES (1, 'STALE001')`);
        raw.exec(`CREATE TABLE unrelated_marker (id INTEGER PRIMARY KEY, note TEXT)`);
        raw.exec(`INSERT INTO unrelated_marker (note) VALUES ('keep me')`);

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        expect(await rebuilt.getDocumentCacheMetadataCount()).toBe(0);
        await rebuilt.upsertDocumentCacheMetadata(makeMetadata());
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.contentKind).toBe('pdf');

        const marker = raw.prepare('SELECT note FROM unrelated_marker').get() as { note: string };
        expect(marker.note).toBe('keep me');
    });

    it('rebuilds document cache metadata when durable columns are missing', async () => {
        const raw = conn.getRawDB();
        raw.exec('DROP TABLE IF EXISTS document_cache_payloads');
        raw.exec('DROP TABLE IF EXISTS document_cache_metadata');
        raw.exec(`
            CREATE TABLE document_cache_metadata (
                id INTEGER PRIMARY KEY,
                item_id INTEGER NOT NULL,
                library_id INTEGER NOT NULL,
                zotero_key TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_mtime_ms INTEGER NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                source_size_bytes INTEGER NOT NULL,
                content_type TEXT NOT NULL,
                error_code TEXT,
                extraction_schema_version TEXT NOT NULL,
                metadata_format_version INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_accessed_at TEXT,
                UNIQUE(library_id, zotero_key)
            )
        `);
        raw.exec(`
            INSERT INTO document_cache_metadata (
                item_id, library_id, zotero_key, file_path, file_mtime_ms,
                file_size_bytes, source_size_bytes, content_type,
                extraction_schema_version, metadata_format_version
            ) VALUES (100, 1, 'STALE002', '/tmp/a.pdf', 10, 20, 20, 'application/pdf', '4', 1)
        `);

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        expect(await rebuilt.getDocumentCacheMetadataCount()).toBe(0);
        await rebuilt.upsertDocumentCacheMetadata(makeMetadata());
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.documentMetadata).toEqual(makeMetadata().documentMetadata);
    });

    it('rebuilds document cache payloads when content_kind is missing', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata());
        recreateLegacyPayloadWithoutContentKind(conn);

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        expect(await rebuilt.getDocumentCacheMetadataCount()).toBe(0);
        expect(await rebuilt.getDocumentCachePayloadCount()).toBe(0);
        await rebuilt.upsertDocumentCacheMetadata(makeMetadata());
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.contentKind).toBe('pdf');
    });

    it('creates the durable schema when document cache tables are absent', async () => {
        const raw = conn.getRawDB();
        raw.exec('DROP TABLE IF EXISTS document_cache_payloads');
        raw.exec('DROP TABLE IF EXISTS document_cache_metadata');

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        await rebuilt.upsertDocumentCacheMetadata(makeMetadata());
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.documentMetadata).toEqual(makeMetadata().documentMetadata);
    });

    it('round trips null, empty, and populated page geometry', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata({ zoteroKey: 'NULL0001', pages: null }));
        await db.upsertDocumentCacheMetadata(makeMetadata({ zoteroKey: 'EMPTY001', pages: [] }));
        await db.upsertDocumentCacheMetadata(makeMetadata({
            zoteroKey: 'PAGES001',
            pages: [
                { viewBox: [0, 0, 612, 792], width: 612, height: 792, rotation: 0 },
                null,
                { viewBox: [10, 20, 210, 320], width: 200, height: 300, rotation: 270 },
            ],
        }));

        await expect(db.getDocumentCacheMetadataByKey(1, 'NULL0001'))
            .resolves.toMatchObject({ pages: null });
        await expect(db.getDocumentCacheMetadataByKey(1, 'EMPTY001'))
            .resolves.toMatchObject({ pages: [] });
        await expect(db.getDocumentCacheMetadataByKey(1, 'PAGES001'))
            .resolves.toMatchObject({
                pages: [
                    { viewBox: [0, 0, 612, 792], width: 612, height: 792, rotation: 0 },
                    null,
                    { viewBox: [10, 20, 210, 320], width: 200, height: 300, rotation: 270 },
                ],
            });
    });

    it('upserts and replaces payload rows by library/key/mode', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id, payloadPath: '/cache/old.gz' }));
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id, payloadPath: '/cache/new.gz' }));

        const row = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(row?.contentKind).toBe('pdf');
        expect(row?.payloadPath).toBe('/cache/new.gz');
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('conditional payload deletion does not delete a refreshed row', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        const oldPayload = await db.upsertDocumentCachePayload(makePayload({
            metadataId: metadata.id,
            payloadPath: '/cache/old.gz',
        }));
        await db.upsertDocumentCachePayload(makePayload({
            metadataId: metadata.id,
            sourceFileSignature: { mtime_ms: 11, size_bytes: 20 },
            payloadPath: '/cache/new.gz',
        }));

        await expect(db.deleteDocumentCachePayloadIfUnchanged(oldPayload)).resolves.toBeNull();
        const current = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(current?.payloadPath).toBe('/cache/new.gz');
        expect(current?.sourceFileSignature.mtime_ms).toBe(11);
    });

    it('conditional payload deletion refuses a refreshed content kind', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        const oldPayload = await db.upsertDocumentCachePayload(makePayload({
            metadataId: metadata.id,
            payloadPath: '/cache/old.gz',
        }));
        await db.upsertDocumentCachePayload(makePayload({
            metadataId: metadata.id,
            contentKind: 'epub',
            extractionSchemaVersion: '1',
            payloadPath: '/cache/new.gz',
        }));

        await expect(db.deleteDocumentCachePayloadIfUnchanged(oldPayload)).resolves.toBeNull();
        const current = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(current?.contentKind).toBe('epub');
    });

    it('maps malformed document metadata JSON to a corrupt read record', async () => {
        const raw = conn.getRawDB();
        raw.prepare(`
            INSERT INTO document_cache_metadata (
                item_id, library_id, zotero_key, content_kind, file_path,
                file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                document_metadata_json, extraction_schema_version, metadata_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            100,
            1,
            'BADJSON1',
            'pdf',
            '/tmp/a.pdf',
            10,
            20,
            20,
            'application/pdf',
            '{not json',
            '4',
            1,
        );

        const row = await db.getDocumentCacheMetadataByKey(1, 'BADJSON1');
        expect(row?.contentKind).toBe('pdf');
        expect(row?.documentMetadata).toBeNull();
        expect(row?.pageCount).toBeNull();
    });

    it('maps document metadata discriminator mismatch to a corrupt read record', async () => {
        const raw = conn.getRawDB();
        raw.prepare(`
            INSERT INTO document_cache_metadata (
                item_id, library_id, zotero_key, content_kind, file_path,
                file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                document_metadata_json, extraction_schema_version, metadata_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            100,
            1,
            'MISMATCH',
            'pdf',
            '/tmp/a.pdf',
            10,
            20,
            20,
            'application/pdf',
            JSON.stringify({ content_kind: 'epub', sectionCount: 1, sections: [] }),
            '4',
            1,
        );

        const row = await db.getDocumentCacheMetadataByKey(1, 'MISMATCH');
        expect(row?.contentKind).toBe('pdf');
        expect(row?.documentMetadata).toBeNull();
        expect(row?.pageCount).toBeNull();
    });

    it('deleting metadata cascades payload rows', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id }));

        await db.deleteDocumentCacheMetadata(1, 'ABCD1234');

        expect(await db.getDocumentCachePayloadCount()).toBe(0);
    });

    it('delete by library removes only that library', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata({ libraryId: 1, zoteroKey: 'AAAA1111' }));
        await db.upsertDocumentCacheMetadata(makeMetadata({ libraryId: 2, zoteroKey: 'BBBB2222' }));

        await db.deleteDocumentCacheMetadataByLibrary(1);

        expect(await db.getDocumentCacheMetadataByKey(1, 'AAAA1111')).toBeNull();
        expect(await db.getDocumentCacheMetadataByKey(2, 'BBBB2222')).not.toBeNull();
    });

    it('conditional metadata deletion does not delete refreshed metadata or payload', async () => {
        const { metadata: oldMetadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        const { metadata: refreshedMetadata } = await db.upsertDocumentCacheMetadata(makeMetadata({
            fileSignature: { mtime_ms: 11, size_bytes: 20 },
        }));
        await db.upsertDocumentCachePayload(makePayload({
            metadataId: refreshedMetadata.id,
            sourceFileSignature: { mtime_ms: 11, size_bytes: 20 },
            payloadPath: '/cache/fresh.gz',
        }));

        await expect(db.deleteDocumentCacheMetadataIfUnchanged(oldMetadata)).resolves.toBeNull();
        const current = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(current?.fileSignature.mtime_ms).toBe(11);
        expect(await db.getDocumentCachePayload(1, 'ABCD1234', 'structured')).not.toBeNull();
    });

    it('conditional metadata deletion detects document metadata changes', async () => {
        const { metadata: oldMetadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCacheMetadata(makeMetadata({
            documentMetadata: buildPdfCachedMetadata(4, { '0': '1' }, defaultPages),
        }));

        await expect(db.deleteDocumentCacheMetadataIfUnchanged(oldMetadata)).resolves.toBeNull();
        const current = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(current?.documentMetadata).toEqual(buildPdfCachedMetadata(4, { '0': '1' }, defaultPages));
    });
});
