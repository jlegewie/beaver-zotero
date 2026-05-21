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
        hasTextLayer: true,
        needsOcr: false,
        isEncrypted: false,
        isInvalid: false,
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
            hasTextLayer: true,
            needsOcr: false,
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

    it('round trips SQLite booleans and null page labels', async () => {
        await db.upsertDocumentCacheMetadata(makeMetadata({
            pageLabels: null,
            hasTextLayer: null,
            needsOcr: null,
            isEncrypted: true,
            isInvalid: true,
        }));

        const row = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(row?.pageLabels).toBeNull();
        expect(row?.hasTextLayer).toBeNull();
        expect(row?.needsOcr).toBeNull();
        expect(row?.isEncrypted).toBe(true);
        expect(row?.isInvalid).toBe(true);
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
