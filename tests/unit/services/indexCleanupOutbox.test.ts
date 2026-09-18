import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB, type BackgroundJobInput, type BackgroundJobRecord } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const cleanup = (account = 'account-a'): BackgroundJobInput => ({
    jobType: 'fulltext_untag', libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'snapshot', payloadKind: 'structured', now: Date.now(),
    payload: { content_kind: 'snapshot', doc_hash: 'a'.repeat(64), index_account_id: account, index_scope_ref: 'g123', index_local_id: 'DEVICE01' },
});

describe('durable index cleanup', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    beforeEach(async () => {
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
    });
    afterEach(async () => { await connection.closeDatabase(); });
    it('preserves an ambiguous upload identity atomically when native extraction replaces its hash', async () => {
        const oldHash = 'a'.repeat(64);
        const newHash = 'b'.repeat(64);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'snapshot' });
        await db.markAttachmentExtracted({ libraryId: 1, zoteroKey: 'ABCDEFGH', expectedFileMtimeMs: null, expectedFileSizeBytes: null,
            previousDocumentHash: null, expectedExtractStatus: null, fileMtimeMs: 1, fileSizeBytes: 2,
            fileHash: 'file-a', structuredDocumentHash: oldHash, extractSchemaVersion: '1', ocrStatus: 'na' });
        await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', oldHash, {
            index_account_id: 'account-a', index_scope_ref: 'g123', index_local_id: 'DEVICE01',
        });
        const anotherOwner = { index_account_id: 'account-b', index_scope_ref: 'g123', index_local_id: 'DEVICE01' };
        expect(await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: 'ABCDEFGH',
            structuredDocumentHash: oldHash, upsertIndexVersion: '3', remoteIdentity: anotherOwner })).toBe(false);
        // No success stamp: the server may have committed an upload whose response was lost.
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus).toBeNull();
        await db.markAttachmentExtracted({ libraryId: 1, zoteroKey: 'ABCDEFGH', expectedFileMtimeMs: 1, expectedFileSizeBytes: 2,
            previousDocumentHash: oldHash, expectedExtractStatus: 'done', fileMtimeMs: 3, fileSizeBytes: 4,
            fileHash: 'file-b', structuredDocumentHash: newHash, extractSchemaVersion: '1', ocrStatus: 'na' });
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
        const jobs = await db.peekBackgroundJobs();
        expect(jobs).toEqual([expect.objectContaining({ jobType: 'fulltext_untag', payload: expect.objectContaining({ doc_hash: oldHash, index_account_id: 'account-a' }) })]);
        // Replacement has durably preserved the old identity, so the new
        // content can safely acquire its own upload owner.
        expect(await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', newHash, anotherOwner)).toMatchObject({ upsertRemoteIdentity: anotherOwner });
    });

    it.each(['account', 'scope', 'device'])('preserves cleanup across a %s ownership transfer and restart', async (field) => {
        const old = { index_account_id: 'account-a', index_scope_ref: 'g123', index_local_id: 'DEVICE01' };
        const next = { ...old, [field === 'account' ? 'index_account_id' : field === 'scope' ? 'index_scope_ref' : 'index_local_id']: 'new-owner' };
        const hash = 'a'.repeat(64);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'snapshot' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', structured_document_hash = ?", [hash]);
        await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', hash, old);
        await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: 'ABCDEFGH', structuredDocumentHash: hash,
            upsertIndexVersion: '3', remoteIdentity: old });
        expect(await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', hash, next)).toMatchObject({ upsertRemoteIdentity: next });
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({ upsertRemoteIdentity: next, upsertStatus: null, upsertIndexVersion: null });
        await connection.queryAsync('DELETE FROM background_jobs');
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        expect(await db.restoreIndexCleanup('account-a')).toBe(1);
        expect((await db.peekBackgroundJobs())[0].payload).toMatchObject({ ...old, doc_hash: hash });
    });

    it('does not update ownership already held by the same identity', async () => {
        const identity = { index_account_id: 'owner', index_scope_ref: 'g123', index_local_id: 'DEVICE' };
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'snapshot' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', structured_document_hash = 'hash'");
        await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', 'hash', identity);
        const query = vi.spyOn(connection, 'queryAsync');
        expect(await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', 'hash', identity)).toMatchObject({ upsertRemoteIdentity: identity });
        expect(query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toEqual([]);
    });

    it('rolls ownership back when preserving cleanup fails', async () => {
        const old = { index_account_id: 'account-a', index_scope_ref: 'g123', index_local_id: 'DEVICE01' };
        const hash = 'a'.repeat(64);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'snapshot' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', structured_document_hash = ?", [hash]);
        await db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', hash, old);
        const query = connection.queryAsync.bind(connection);
        vi.spyOn(connection, 'queryAsync').mockImplementation(async (...args) => {
            if (args[0].includes('UPDATE attachment_processing_state SET upsert_remote_identity')) throw new Error('disk full');
            return query(...args);
        });
        await expect(db.recordAttachmentIndexIdentity(1, 'ABCDEFGH', hash, { ...old, index_account_id: 'account-b' })).rejects.toThrow('disk full');
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertRemoteIdentity).toEqual(old);
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
    });

    it('survives queue loss and reopens only under its owning account until acknowledged', async () => {
        await db.enqueueBackgroundJob(cleanup());
        await connection.queryAsync('DELETE FROM background_jobs');
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        expect(await db.restoreIndexCleanup('account-b')).toBe(0);
        expect(await db.restoreIndexCleanup('account-a')).toBe(1);
        const record = await db.claimNextBackgroundJob(Date.now(), 60000, undefined, ['fulltext_untag']);
        expect(record?.payload).toMatchObject(cleanup().payload!);
        await db.acknowledgeIndexCleanup(record!);
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
    });
    it('retains separate identities for two accounts sharing the same local attachment', async () => {
        await db.enqueueBackgroundJob(cleanup('account-a'));
        await db.enqueueBackgroundJob(cleanup('account-b'));
        const first = await db.claimNextBackgroundJob(Date.now(), 60000, undefined, ['fulltext_untag']);
        const second = await db.claimNextBackgroundJob(Date.now(), 60000, undefined, ['fulltext_untag']);
        expect(first!.id).not.toBe(second!.id);
        await db.acknowledgeIndexCleanup(first as BackgroundJobRecord);
        await db.completeBackgroundJob(second!.id);
        expect(await db.restoreIndexCleanup('account-b')).toBe(1);
    });
    it('queues distinct devices independently while deduplicating the same frozen identity', async () => {
        const first = cleanup();
        const second = { ...first, payload: { ...first.payload!, index_local_id: 'DEVICE02' } };
        const a = await db.enqueueBackgroundJob(first);
        const b = await db.enqueueBackgroundJob(second);
        expect(a.id).not.toBe(b.id);
        expect(await db.enqueueBackgroundJob(second)).toEqual({ id: b.id, enqueued: false });
        const jobs = await db.peekBackgroundJobs();
        expect(jobs.map((job) => job.payload?.index_local_id).sort()).toEqual(['DEVICE01', 'DEVICE02']);
        for (const job of jobs) {
            await db.acknowledgeIndexCleanup(job);
            await db.completeBackgroundJob(job.id);
        }
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
    });

    it('retires acknowledged dead copies after restoration without touching another device', async () => {
        for (let i = 0; i < 102; i++) {
            const job = { ...cleanup(), zoteroKey: `KEY${String(i).padStart(5, '0')}` };
            const { id } = await db.enqueueBackgroundJob(job);
            await db.failBackgroundJob(id, 'offline', { maxAttempts: 1, backoffMs: () => 0, now: i });
        }
        expect(await db.restoreIndexCleanup('account-a')).toBe(102);
        const jobs = await db.peekBackgroundJobs(200);
        expect(jobs).toHaveLength(102);
        const otherDevice = { ...cleanup(), zoteroKey: jobs[101].zoteroKey,
            payload: { ...cleanup().payload!, index_local_id: 'DEVICE02' } };
        const { id } = await db.enqueueBackgroundJob(otherDevice);
        await db.failBackgroundJob(id, 'offline', { maxAttempts: 1, backoffMs: () => 0, now: 200 });
        for (const job of jobs) {
            await db.acknowledgeIndexCleanup(job);
            await db.completeBackgroundJob(job.id);
        }
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        expect(await db.restoreIndexCleanup('account-a')).toBe(1);
        const remaining = await db.peekBackgroundJobs();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].payload).toMatchObject(otherDevice.payload!);
    });

    it('does not rewrite cleanup already queued when a lane restarts', async () => {
        await db.enqueueBackgroundJob(cleanup());
        const query = vi.spyOn(connection, 'queryAsync');
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
        expect(query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)\b/.test(sql.trim()))).toEqual([]);
    });

    it('preserves remote identities through local processing resets', async () => {
        await db.enqueueBackgroundJob(cleanup());
        await db.resetLocalProcessingState();
        await connection.queryAsync('DELETE FROM background_jobs');
        expect(await db.restoreIndexCleanup('account-a')).toBe(1);
    });

    it.each([undefined, 1])('discards durable cleanup only for the reset scope: %s', async (libraryId) => {
        await db.enqueueBackgroundJob(cleanup('account-a'));
        await db.enqueueBackgroundJob(cleanup('account-b'));
        const otherLibrary = cleanup('account-a');
        await db.enqueueBackgroundJob({ ...otherLibrary, libraryId: 2,
            payload: { ...otherLibrary.payload!, index_scope_ref: 'g456' } });
        await connection.queryAsync('DELETE FROM background_jobs');
        await db.resetLocalProcessingState(libraryId, true);
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');

        expect(await db.restoreIndexCleanup('account-a')).toBe(libraryId === undefined ? 0 : 1);
        expect(await db.restoreIndexCleanup('account-b')).toBe(0);
        const jobs = await db.peekBackgroundJobs();
        expect(jobs.map((job) => job.libraryId)).toEqual(libraryId === undefined ? [] : [2]);
    });

    it.each([
        'restore-first', 'acknowledge-first',
    ])('does not resurrect cleanup with %s replay', async (order) => {
        // Zotero serializes executeTransaction calls on a shared connection.
        const transaction = connection.executeTransaction.bind(connection);
        let tail = Promise.resolve();
        vi.spyOn(connection, 'executeTransaction').mockImplementation((fn) => {
            const next = tail.then(() => transaction(fn));
            tail = next.catch(() => undefined);
            return next;
        });
        await db.enqueueBackgroundJob(cleanup());
        const record = (await db.claimNextBackgroundJob(Date.now(), 60000, undefined, ['fulltext_untag']))!;
        const replay = () => db.restoreIndexCleanup('account-a');
        const query = connection.queryAsync.bind(connection);
        let entered!: () => void;
        const paused = new Promise<void>((resolve) => { entered = resolve; });
        let resume!: () => void;
        const barrier = new Promise<void>((resolve) => { resume = resolve; });
        let held = false;
        vi.spyOn(connection, 'queryAsync').mockImplementation(async (...args) => {
            const rows = await query(...args);
            const target = order === 'restore-first'
                ? 'FROM index_cleanup_outbox WHERE account_id'
                : 'DELETE FROM index_cleanup_outbox';
            if (!held && args[0].includes(target)) {
                held = true;
                entered();
                await barrier;
            }
            return rows;
        });
        const first = order === 'restore-first'
            ? replay() : db.acknowledgeIndexCleanup(record);
        await paused;
        let secondFinished = false;
        const second = (order === 'restore-first'
            ? db.acknowledgeIndexCleanup(record) : replay())
            .then(() => { secondFinished = true; });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const overlapped = secondFinished;
        resume();
        await Promise.all([first, second]);
        expect(overlapped).toBe(false);
        for (const live of await db.peekBackgroundJobs()) await db.completeBackgroundJob(live.id);
        expect(await db.restoreIndexCleanup('account-a')).toBe(0);
        expect(await db.peekBackgroundJobs()).toEqual([]);
    });
});
