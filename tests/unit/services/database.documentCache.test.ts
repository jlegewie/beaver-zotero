import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB, DocumentCacheMetadataInput, DocumentCachePayloadInput } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

function makeMetadata(overrides: Partial<DocumentCacheMetadataInput> = {}): DocumentCacheMetadataInput {
    return {
        itemId: 100,
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        filePath: '/tmp/a.pdf',
        fileSignature: { mtime_ms: 10, size_bytes: 20 },
        sourceSizeBytes: 20,
        contentType: 'application/pdf',
        pageCount: 3,
        pageLabels: { '0': 'i', '1': '1' },
        errorCode: null,
        extractionSchemaVersion: '4',
        metadataFormatVersion: 1,
        ...overrides,
    };
}

function makePayload(overrides: Partial<DocumentCachePayloadInput> = {}): DocumentCachePayloadInput {
    return {
        metadataId: 1,
        itemId: 100,
        libraryId: 1,
        zoteroKey: 'ABCD1234',
        mode: 'structured',
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
            pageCount: 3,
            pageLabels: { '0': 'i', '1': '1' },
            errorCode: null,
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
        expect(errored?.errorCode).toBe('encrypted');

        await db.upsertDocumentCacheMetadata(makeMetadata({ errorCode: null }));
        const ready = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(ready?.errorCode).toBeNull();
    });

    it('rebuilds a stale document cache schema without touching unrelated tables', async () => {
        const raw = conn.getRawDB();
        // A pre-existing draft schema with the old boolean columns and no `error_code`.
        raw.exec('DROP TABLE IF EXISTS document_cache_payloads');
        raw.exec('DROP TABLE IF EXISTS document_cache_metadata');
        raw.exec(`
            CREATE TABLE document_cache_metadata (
                id INTEGER PRIMARY KEY, library_id INTEGER, zotero_key TEXT,
                is_encrypted INTEGER, needs_ocr INTEGER
            )
        `);
        raw.exec(`INSERT INTO document_cache_metadata (library_id, zotero_key) VALUES (1, 'STALE001')`);
        raw.exec(`CREATE TABLE unrelated_marker (id INTEGER PRIMARY KEY, note TEXT)`);
        raw.exec(`INSERT INTO unrelated_marker (note) VALUES ('keep me')`);

        const rebuilt = new BeaverDB(conn);
        await rebuilt.initDatabase('0.99.0');

        // Stale rows are gone and the new shape round-trips.
        expect(await rebuilt.getDocumentCacheMetadataCount()).toBe(0);
        await rebuilt.upsertDocumentCacheMetadata(makeMetadata());
        const row = await rebuilt.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.errorCode).toBeNull();

        // Unrelated tables are untouched.
        const marker = raw.prepare('SELECT note FROM unrelated_marker').get() as { note: string };
        expect(marker.note).toBe('keep me');
    });

    it('upserts and replaces payload rows by library/key/mode', async () => {
        const { metadata } = await db.upsertDocumentCacheMetadata(makeMetadata());
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id, payloadPath: '/cache/old.gz' }));
        await db.upsertDocumentCachePayload(makePayload({ metadataId: metadata.id, payloadPath: '/cache/new.gz' }));

        const row = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
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
});
