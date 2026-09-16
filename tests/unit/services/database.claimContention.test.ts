import { afterEach, beforeEach, expect, it } from "vitest";
import { BeaverDB } from "../../../src/services/database";
import { MockDBConnection } from "../../mocks/mockDBConnection";

let connection: MockDBConnection;
let db: BeaverDB;
beforeEach(async () => {
    connection = new MockDBConnection();
    db = new BeaverDB(connection);
    await db.initDatabase("0.99.0");
});
afterEach(async () => {
    await connection.closeDatabase();
});

async function enqueue(key: string) {
    await db.enqueueBackgroundJob({
        jobType: "document_ocr",
        libraryId: 1,
        zoteroKey: key,
        contentKind: "pdf",
        payloadKind: "structured",
        now: 0,
    });
}

it.each([0, 1])(
    "returns the parked claim despite an intervening write affecting %i rows",
    async (affected) => {
        await enqueue("ABCDEFGH");
        const original = connection.queryAsync.bind(connection);
        let injected = false;
        connection.queryAsync = async (sql, params, options) => {
            const result = await original(sql, params, options);
            if (
                !injected &&
                /UPDATE background_jobs\s+SET available_at/.test(sql)
            ) {
                injected = true;
                await original(
                    affected
                        ? "UPDATE background_jobs SET priority = priority"
                        : "DELETE FROM background_jobs WHERE id = -1",
                );
            }
            return result;
        };
        const claimed = await db.claimNextBackgroundJob(1, 360000, undefined, [
            "document_ocr",
        ]);
        expect(injected).toBe(true);
        expect(claimed).toMatchObject({
            zoteroKey: "ABCDEFGH",
            availableAt: 360001,
        });
        expect(await db.peekBackgroundJobs()).toEqual([claimed]);
    },
);

it.each([1, 8])(
    "gives each of %i parked rows exactly one owner across competing consumers",
    async (count) => {
        for (let i = 0; i < count; i++) await enqueue(`KEY0000${i}`);
        const claims = await Promise.all(
            Array.from({ length: count + 4 }, () =>
                db.claimNextBackgroundJob(1, 360000, undefined, [
                    "document_ocr",
                ]),
            ),
        );
        const owners = claims.filter((claim) => claim !== null);
        expect(owners).toHaveLength(count);
        expect(new Set(owners.map((claim) => claim.id)).size).toBe(count);
        const parked = await db.peekBackgroundJobs();
        expect(parked.every((row) => row.availableAt === 360001)).toBe(true);
        expect(parked.map((row) => row.id).sort()).toEqual(
            owners.map((row) => row.id).sort(),
        );
        expect(await db.claimNextBackgroundJob(360000, 360000)).toBeNull();
        expect(await db.claimNextBackgroundJob(360001, 360000)).not.toBeNull();
    },
);

it("does not report an unsuccessful guarded update as accepted after an unrelated successful write", async () => {
    await enqueue("ABCDEFGH");
    const original = connection.queryAsync.bind(connection);
    connection.queryAsync = async (sql, params, options) => {
        const result = await original(sql, params, options);
        if (
            /UPDATE attachment_processing_state SET extraction_source/.test(sql)
        ) {
            await original("UPDATE background_jobs SET priority = priority");
        }
        return result;
    };
    expect(
        await db.adoptAttachmentExtractionSource({
            libraryId: 1,
            zoteroKey: "MISSING1",
            contentKind: "pdf",
            source: "source",
            fileMtimeMs: 1,
            fileSizeBytes: 1,
        }),
    ).toBe(false);
});
