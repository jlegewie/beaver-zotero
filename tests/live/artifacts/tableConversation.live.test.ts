import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from "../../helpers/zoteroAvailability";
import { post } from "../../helpers/zoteroHttpClient";

const libraryRef = process.env.BEAVER_TEST_TABLE_LIBRARY_REF || "u";
let libraryID: number;
let available = false;
let key: string | undefined;
const operation = `table-conversation-${Date.now()}`;
const runtime = (command: string, fields: Record<string, unknown> = {}) =>
    post<any>("/beaver/test/window-runtime", { command, ...fields });
const provider = (op: string, fields: Record<string, unknown> = {}) =>
    post<any>("/beaver/artifact", {
        event: "artifact_request",
        request_id: `${operation}-${op}`,
        op,
        ...(key ? { key } : {}),
        ...fields,
    });

beforeAll(async () => {
    available = await isZoteroAvailable();
});
afterAll(async () => {
    if (!available || !key) return;
    await runtime("table-remove", {
        library_id: libraryID,
        zotero_key: key.split("-")[1],
    });
    await provider("delete");
});

describe("table composer state with the real Zotero provider", () => {
    it("creates a table without selecting a composer attachment", async (ctx) => {
        skipIfNoZotero(ctx, available);
        await post("/beaver/test/new-thread", {});
        const before = await runtime("table-conversation");
        const created = await provider("create", {
            kind: "table",
            library_ref: libraryRef,
            title: "Table conversation test",
            operation_id: operation,
            meta: { actor: "user" },
            spec: {
                id: operation,
                title: "Table conversation test",
                columns: [{ id: "answer", header: "Answer", type: "text" }],
                rows: [],
            },
        });
        expect(created.ok).toBe(true);
        expect(created.zotero_item.library_ref).toBe(libraryRef);
        libraryID = created.zotero_item.library_id;
        key = `${created.zotero_item.library_ref}-${created.zotero_item.zotero_key}`;
        const after = await runtime("table-conversation");
        expect(after.selectedItems).toEqual(before.selectedItems);
        expect(after.runs).toHaveLength(0);
    });
    it("attaches a never-referenced table, removes it from the draft, and leaves the document intact", async (ctx) => {
        skipIfNoZotero(ctx, available);
        const ref = { library_id: libraryID, zotero_key: key!.split("-")[1] };
        expect(await runtime("table-attach", ref)).toEqual({ ok: true });
        const selected = await runtime("table-conversation");
        expect(selected.selectedItems).toContainEqual({
            libraryID,
            key: ref.zotero_key,
        });
        expect(selected.runs).toHaveLength(0);
        expect(await runtime("table-remove", ref)).toEqual({ ok: true });
        expect((await runtime("table-conversation")).selectedItems).toEqual([]);
        expect((await provider("read")).ok).toBe(true);
    });
    it("opens the stored table in Zotero's snapshot reader", async (ctx) => {
        skipIfNoZotero(ctx, available);
        expect(
            await post("/beaver/test/open-stored-table", {
                libraryID,
                key: key!.split("-")[1],
            }),
        ).toMatchObject({ ok: true, library_id: libraryID });
    });
});
