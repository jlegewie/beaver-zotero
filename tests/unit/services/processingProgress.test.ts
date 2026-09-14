import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeaverDB } from "../../../src/services/database";
import { MockDBConnection } from "../../mocks/mockDBConnection";
import type { ProcessingProgressScope } from "../../../src/services/backgroundProcessing/progress";

let conn: MockDBConnection;
let db: BeaverDB;
const scope: ProcessingProgressScope = {
    accountId: "account-a",
    libraryIds: [1],
    hasOcrAccess: true,
    hasSearchIndexAccess: true,
};
const ref = (key: string, libraryId = 1) => ({
    libraryId,
    zoteroKey: key,
    contentKind: "pdf" as const,
});
const pending = (key: string, libraryId = 1) =>
    db.ensureAttachmentProcessingState(ref(key, libraryId));
const queue = (
    key: string,
    jobType:
        | "document_extract"
        | "document_ocr"
        | "fulltext_upsert"
        | "fulltext_untag" = "document_extract",
    libraryId = 1,
) =>
    db.enqueueBackgroundJob({
        ...ref(key, libraryId),
        jobType,
        payloadKind: "structured",
        now: Date.now(),
    });
const ready = async (key: string, extra = "upsert_status = 'done'") => {
    await conn.queryAsync(
        `UPDATE attachment_processing_state SET extract_status = 'done',
        ocr_status = 'na', structured_document_hash = 'hash', ${extra} WHERE zotero_key = ?`,
        [key],
    );
};
const read = (discovering = false, inFlight = 0) =>
    db.getProcessingProgress(discovering, inFlight);

beforeEach(async () => {
    vi.clearAllMocks();
    conn = new MockDBConnection();
    db = new BeaverDB(conn as any);
    await db.initDatabase("0.99.0");
    await db.configureProcessingProgress(scope);
});
afterEach(async () => {
    await conn.closeDatabase();
});

describe("durable attachment progress", () => {
    it("does not change SQLite write results when reading paused or already settled progress", async () => {
        await pending("PAUSED");
        await conn.queryAsync(
            "UPDATE attachment_processing_state SET last_error = NULL WHERE zotero_key = 'PAUSED'",
        );
        expect(await read()).toMatchObject({ pending: 1, finishedAt: null });
        expect(
            (await conn.queryAsync("SELECT changes() AS count"))[0].count,
        ).toBe(1);
        await ready("PAUSED");
        await read();
        await conn.queryAsync(
            "UPDATE attachment_processing_state SET last_error = NULL WHERE zotero_key = 'PAUSED'",
        );
        await read();
        expect(
            (await conn.queryAsync("SELECT changes() AS count"))[0].count,
        ).toBe(1);
    });

    it("reads scope-filtered queue counts and file outcomes together, including future retries", async () => {
        await queue("INCLUDED");
        const retry = await queue("RETRY");
        await db.releaseBackgroundJob(retry.id, Date.now() + 60_000);
        await queue("EXCLUDED", "document_extract", 2);
        await queue("CLEANUP", "fulltext_untag");
        expect(
            await db.getProcessingProgress(true, 0, undefined, [
                "document_extract",
            ]),
        ).toMatchObject({
            total: 2,
            pending: 2,
            queue: { available: 1, deferred: 1, attachments: 2 },
        });
        expect(
            await db.getProcessingProgress(true, 0, undefined, []),
        ).toMatchObject({
            total: 2,
            pending: 2,
            queue: { available: 0, deferred: 0, attachments: 0 },
        });
        expect(await db.getProcessingProgress(true, 0, 2)).toMatchObject({
            total: 0,
            pending: 0,
            queue: { available: 0, deferred: 0, attachments: 0 },
        });
    });

    it("retains 1000 of 4000 through waiting, discovery, and repeated status reads", async () => {
        for (let i = 0; i < 4000; i++) await pending(`FILE${i}`);
        for (let i = 0; i < 1000; i++) await ready(`FILE${i}`);
        const before = await read();
        expect(before).toMatchObject({
            total: 4000,
            pending: 3000,
            succeeded: 1000,
            finishedAt: null,
        });
        expect(await read(true)).toMatchObject({
            ...before,
            discovering: true,
        });
        expect(await read()).toEqual(before);
    });

    it("counts simultaneous completions and additions even without an intermediate read", async () => {
        await pending("FIRST");
        const before = await read();
        await ready("FIRST");
        await pending("SECOND");
        await ready("SECOND");
        await pending("THIRD");
        expect(await read()).toMatchObject({
            runId: before.runId,
            total: 3,
            pending: 1,
            succeeded: 2,
        });
    });

    it("takes a union of unfinished stages and queue-only rereads, deduplicated by attachment", async () => {
        await pending("LEDGER1");
        await pending("LEDGER2");
        await pending("BOTH");
        await queue("BOTH");
        await queue("BOTH", "document_ocr");
        await pending("REREAD");
        await ready("REREAD");
        await queue("REREAD");
        expect(await read()).toMatchObject({
            total: 4,
            pending: 4,
            succeeded: 0,
        });
    });

    it("does not finish an attachment between extraction, remote OCR and indexing jobs", async () => {
        await pending("SCANNED");
        const extraction = await queue("SCANNED");
        const first = await read();
        await ready("SCANNED", "ocr_status = 'needed', upsert_status = NULL");
        await db.completeBackgroundJob(extraction.id);
        expect(await read()).toMatchObject({
            runId: first.runId,
            pending: 1,
            succeeded: 0,
        });
        const ocr = await queue("SCANNED", "document_ocr");
        await db.releaseBackgroundJob(ocr.id, Date.now() + 60_000);
        expect(await read()).toMatchObject({ pending: 1, finishedAt: null });
        await ready("SCANNED", "upsert_status = NULL");
        await db.completeBackgroundJob(ocr.id);
        expect(await read()).toMatchObject({ pending: 1, succeeded: 0 });
        const upload = await queue("SCANNED", "fulltext_upsert");
        await ready("SCANNED");
        expect(await read()).toMatchObject({ pending: 1, succeeded: 0 });
        await db.completeBackgroundJob(upload.id);
        expect(await read()).toMatchObject({
            runId: first.runId,
            total: 1,
            succeeded: 1,
            pending: 0,
            finishedAt: expect.any(Number),
        });
    });

    it("keeps a run open through empty discovery and active job settlement", async () => {
        await pending("FIRST");
        const first = await read();
        await ready("FIRST");
        expect(await read(true)).toMatchObject({
            pending: 0,
            finishedAt: null,
        });
        await pending("ADDITIONAL");
        expect(await read(true)).toMatchObject({
            runId: first.runId,
            total: 2,
            succeeded: 1,
        });
        await ready("ADDITIONAL");
        expect(await read(false, 1)).toMatchObject({ finishedAt: null });
        expect(await read()).toMatchObject({ finishedAt: expect.any(Number) });
        await pending("NEXT");
        expect(await read()).toMatchObject({
            runId: first.runId + 1,
            total: 1,
            pending: 1,
            succeeded: 0,
        });
    });

    it("keeps terminal failures and removals separate from successful completion", async () => {
        for (const key of ["GOOD", "FAILED", "DELETED", "DEAD"])
            await pending(key);
        await ready("GOOD");
        await conn.queryAsync(
            "UPDATE attachment_processing_state SET extract_status = 'failed' WHERE zotero_key = 'FAILED'",
        );
        await db.deleteAttachmentProcessingState(1, "DELETED");
        await conn.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'DEAD', 'pdf', 'structured', 0, 1, 5)`);
        expect(await read()).toMatchObject({
            total: 4,
            pending: 0,
            succeeded: 1,
            problems: 2,
            removed: 1,
        });
        // A fresh queued retry takes precedence over an old dead letter.
        await queue("DEAD");
        expect(await read()).toMatchObject({
            total: 1,
            pending: 1,
            problems: 0,
        });
    });

    it("resumes after database initialization and unknown authentication, but isolates another account", async () => {
        await pending("DONE");
        await pending("PENDING");
        await ready("DONE");
        const before = await read();
        db = new BeaverDB(conn as any);
        await db.initDatabase("0.99.0");
        await db.configureProcessingProgress({
            ...scope,
            accountId: "",
            libraryIds: [],
        });
        await db.configureProcessingProgress(scope);
        expect(await read()).toEqual(before);
        await db.configureProcessingProgress({
            ...scope,
            accountId: "account-b",
        });
        expect(await read()).toMatchObject({
            total: 1,
            pending: 1,
            succeeded: 0,
        });
    });

    it("excludes cleanup and unavailable entitlements and accounts for scope removal", async () => {
        await db.configureProcessingProgress({
            ...scope,
            libraryIds: [1, 2],
            hasOcrAccess: false,
            hasSearchIndexAccess: false,
        });
        await pending("SCANNED");
        await ready("SCANNED", "ocr_status = 'needed', upsert_status = NULL");
        await queue("SCANNED", "document_ocr");
        await queue("UNTAG", "fulltext_untag");
        await queue("UPLOAD", "fulltext_upsert");
        await pending("OTHER", 2);
        expect(await read()).toMatchObject({
            total: 2,
            pending: 1,
            problems: 1,
        });
        await db.configureProcessingProgress({
            ...scope,
            hasOcrAccess: false,
            hasSearchIndexAccess: false,
        });
        expect(await read()).toMatchObject({
            total: 2,
            pending: 0,
            problems: 1,
            removed: 1,
        });
        await pending("EXCLUDED", 2);
        expect(await read()).toMatchObject({ total: 2, pending: 0 });
    });

    it("rolls admission back with the operation and keeps enqueue change detection intact", async () => {
        await expect(
            conn.executeTransaction(async () => {
                await pending("ROLLBACK");
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await read()).toMatchObject({ total: 0, runId: 0 });
        expect(await queue("NEW")).toMatchObject({ enqueued: true });
        expect(await queue("NEW")).toMatchObject({ enqueued: false });
        expect(await read()).toMatchObject({ total: 1, pending: 1 });
    });
});
