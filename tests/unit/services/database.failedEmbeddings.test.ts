import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB - failed embedding retry tracking', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('inserts transient pre-API failures as immediately retryable rows', async () => {
        await db.recordFailedEmbeddingsBatch(
            [{ itemId: 101, libraryId: 1 }],
            'local hash lookup failed',
            { incrementExisting: false },
        );

        const record = await db.getFailedEmbedding(101);
        expect(record).not.toBeNull();
        expect(record!.failure_count).toBe(0);
        expect(record!.next_retry_after).toBe(record!.last_attempt);

        const ready = await db.getItemsReadyForRetry();
        expect(ready).toContain(101);
    });

    it('preserves the existing backoff window for transient retries of known failures', async () => {
        await db.recordFailedEmbeddingsBatch(
            [{ itemId: 202, libraryId: 1 }],
            'api timeout',
        );
        const initial = await db.getFailedEmbedding(202);

        await db.recordFailedEmbeddingsBatch(
            [{ itemId: 202, libraryId: 1 }],
            'local metadata lookup failed',
            { incrementExisting: false },
        );

        const updated = await db.getFailedEmbedding(202);
        expect(updated).not.toBeNull();
        expect(updated!.failure_count).toBe(initial!.failure_count);
        expect(updated!.next_retry_after).toBe(initial!.next_retry_after);
        expect(updated!.last_error).toBe('local metadata lookup failed');
    });
});
