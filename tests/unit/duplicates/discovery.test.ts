import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
    excluded: false,
    failSearch: false,
    modified: "2024-01-01 00:00:00",
    scans: 0,
    groups: [
        [1, 2],
        [3, 4],
    ],
}));
vi.mock("../../../src/services/agentDataProvider/utils", () => ({
    checkLibraryExcluded: () =>
        state.excluded ? { message: "Excluded" } : null,
    validateLibraryAccess: () =>
        state.excluded
            ? {
                  valid: false,
                  error: "Excluded",
                  error_code: "library_excluded",
              }
            : { valid: true, library: { libraryID: 1 } },
    getCollectionByIdOrName: () => ({
        libraryID: 1,
        collection: { key: "COLL1234" },
    }),
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    modelObjectId: (_: number, key: string) => `u-${key}`,
    libraryRefForLibraryID: () => "u",
    parseItemReference: (id: string) => ({
        zotero_key: id.slice(2),
        library_ref: "u",
    }),
    resolveLibraryRef: () => 1,
}));
import { handleDuplicatesRequest } from "../../../src/services/duplicates/discovery";
let items: any[];
beforeEach(() => {
    state.excluded = false;
    state.failSearch = false;
    // A unique stamp per test keeps module-level cached scans from leaking.
    state.modified = `${Math.random()}`;
    state.scans = 0;
    state.groups = [
        [1, 2],
        [3, 4],
    ];
    items = [1, 2, 3, 4].map((id) => ({
        id,
        libraryID: 1,
        key: `ITEM000${id}`,
        itemType: "journalArticle",
        dateAdded: "2024-01-01",
        deleted: false,
        isRegularItem: () => true,
        isNote: () => false,
        isAttachment: () => false,
        isAnnotation: () => false,
        getField: (f: string) =>
            f === "title" ? `Paper ${Math.ceil(id / 2)}` : "",
        toJSON: () => ({
            title: `Paper ${Math.ceil(id / 2)}`,
            inPublications: id % 2 === 0,
            citationKey: `paper${id}`,
            abstractNote: id % 2 ? "" : "Abstract",
        }),
        getAttachments: () => [],
        getNotes: () => [],
    }));
    vi.stubGlobal("Zotero", {
        Duplicates: class {
            async getSearchObject() {
                return {
                    getConditions: () => ({
                        0: {
                            condition: "tempTable",
                            value: "tmpDuplicates_TEST",
                        },
                    }),
                    search: async () => {
                        state.scans++;
                        if (state.failSearch) throw Error("search failed");
                        return state.groups.flat();
                    },
                };
            }
            getSetItemsByItemID(id: number) {
                return state.groups.find((g) => g.includes(id));
            }
        },
        Search: class {
            libraryID = 1;
            addCondition() {}
            async search() {
                return [2];
            }
        },
        Libraries: { get: () => ({ editable: true }) },
        Utilities: {
            Internal: {
                md5: (s: string) => createHash("md5").update(s).digest("hex"),
            },
        },
        DB: {
            queryAsync: vi.fn(async (sql: string, _params?: unknown, opts?: any) => {
                if (sql.includes("clientDateModified"))
                    opts.onRow({
                        getResultByIndex: (i: number) =>
                            i ? state.modified : items.length,
                    });
            }),
        },
        Items: {
            getAsync: async (ids: number[]) =>
                items.filter((i) => ids.includes(i.id)),
            loadDataTypes: async () => {},
            getByLibraryAndKeyAsync: async (_: number, key: string) =>
                items.find((i) => i.key === key),
        },
    });
});
const find = (args = {}) =>
    handleDuplicatesRequest({
        event: "duplicates_request",
        request_id: "test",
        mode: "find",
        ...args,
    });
it("pages whole groups and requires a stable snapshot for continuation", async () => {
    const first = await find({ limit: 1 });
    expect(first.snapshot_id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.groups[0].members).toHaveLength(2);
    expect(first.next_offset).toBe(1);
    expect((await find({ offset: 1 })).error_code).toBe("snapshot_required");
    const second = await find({
        offset: 1,
        limit: 1,
        snapshot_id: first.snapshot_id,
    });
    expect(second.groups[0].members[0].item_id).toBe("u-ITEM0003");
    expect(second.has_more).toBe(false);
    state.groups = [[1, 2]];
    state.modified = "2024-01-02 00:00:00";
    expect(
        (await find({ offset: 1, snapshot_id: first.snapshot_id })).error_code,
    ).toBe("stale_snapshot");
});
it("asks for the exact snapshot_id before a restart when it does not match", async () => {
    const first = await find({ limit: 1 });
    const mistyped = await find({
        offset: 1,
        limit: 1,
        snapshot_id: first.snapshot_id.slice(0, -1) + "x",
    });
    expect(mistyped.error_code).toBe("stale_snapshot");
    expect(mistyped.error).toMatch(/exact snapshot_id from the previous page/);
    expect(mistyped.error).toMatch(/restart find_duplicates at offset 0/);
});
it("retains out-of-collection members of a matching group", async () => {
    const result = await find({ collection: "COLL1234" });
    expect(result.total_count).toBe(1);
    expect(result.groups[0].members.map((m) => m.item_id)).toEqual([
        "u-ITEM0001",
        "u-ITEM0002",
    ]);
});
it("continues paging when the collection is named one way, then the other", async () => {
    // A key and a name that resolve to the same collection share one snapshot.
    const first = await find({ collection: "COLL1234", limit: 1 });
    const second = await find({
        collection: "Policing",
        limit: 1,
        offset: 1,
        snapshot_id: first.snapshot_id,
    });
    expect(second.error).toBeUndefined();
    expect(second.snapshot_id).toBe(first.snapshot_id);
});
const drops = () =>
    vi
        .mocked(Zotero.DB.queryAsync)
        .mock.calls.filter(([sql]) => String(sql).startsWith("DROP TABLE"));
it("releases native temporary tables on success and failure", async () => {
    await find();
    state.failSearch = true;
    expect((await find()).error).toBe("search failed");
    expect(drops()).toEqual([
        ["DROP TABLE IF EXISTS tmpDuplicates_TEST"],
        ["DROP TABLE IF EXISTS tmpDuplicates_TEST"],
    ]);
});
it("returns complete field comparisons and child inventories from discovery", async () => {
    const result = await find();
    expect(result.groups[0].members[0].children).toEqual([]);
    expect(result.groups[0].differing_fields).toContain("abstractNote");
    expect(result.groups[0].differing_fields).not.toContain("inPublications");
    expect(result.groups[0].differing_fields).not.toContain("citationKey");
    expect(result.groups[0].members[1].fields).not.toHaveProperty("citationKey");
    expect(result.groups[0].members[1].fields.abstractNote).toBe("Abstract");
});
it("enforces exclusions before querying and after asynchronous inspection", async () => {
    state.excluded = true;
    expect((await find()).error_code).toBe("library_excluded");
    expect(Zotero.DB.queryAsync).not.toHaveBeenCalled();
    state.excluded = false;
    vi.spyOn(Zotero.Items, "loadDataTypes").mockImplementation(async () => {
        state.excluded = true;
    });
    const result = await find();
    expect(result.error_code).toBe("library_excluded");
    expect(result.groups).toEqual([]);
});

it("keeps required group fields well-formed when the library record is gone", async () => {
    // Every field is required on the wire; a null or undefined here fails
    // validation on the far side and kills the whole call, so a missing
    // library must surface as a handled error instead.
    vi.spyOn(Zotero.Libraries, "get").mockReturnValue(undefined as any);
    const result = await find();
    expect(result.error).toBeUndefined();
    for (const group of result.groups) {
        expect(group.mergeable).toBe(false);
        expect(group.warnings).toContain("This library is read-only.");
        for (const member of group.members)
            expect(typeof member.library_ref).toBe("string");
    }
});

it("serves continuation pages from the first page's scan", async () => {
    const first = await find({ limit: 1 });
    const second = await find({
        offset: 1,
        limit: 1,
        snapshot_id: first.snapshot_id,
    });
    expect(state.scans).toBe(1);
    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(second.total_count).toBe(2);
    expect(second.groups[0].members[0].item_id).toBe("u-ITEM0003");
});
it("rescans every first page", async () => {
    await find({ limit: 1 });
    await find({ limit: 1 });
    expect(state.scans).toBe(2);
});
it("rescans once a cached scan expires and reports a changed population", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
        const first = await find({ limit: 1 });
        state.groups = [[1, 2]];
        // Still cached: the continuation reads the scan's population.
        expect(
            (await find({ offset: 1, limit: 1, snapshot_id: first.snapshot_id }))
                .error,
        ).toBeUndefined();
        clock.mockReturnValue(now + 5 * 60 * 1000);
        const late = await find({
            offset: 1,
            limit: 1,
            snapshot_id: first.snapshot_id,
        });
        expect(state.scans).toBe(2);
        expect(late.error_code).toBe("stale_snapshot");
    } finally {
        clock.mockRestore();
    }
});
it("rescans when a write such as a merge changed the library", async () => {
    const first = await find({ limit: 1 });
    // A merge trashes the other members, which stamps clientDateModified.
    items[3].deleted = true;
    state.modified = "2024-01-02 00:00:00";
    const after = await find({
        offset: 1,
        limit: 1,
        snapshot_id: first.snapshot_id,
    });
    expect(state.scans).toBe(2);
    expect(after.error_code).toBe("stale_snapshot");
});
it("shares one scan across a parallel burst, first page included", async () => {
    const first = await find({ limit: 1 });
    state.scans = 0;
    const pages = await Promise.all([
        find({ limit: 1 }),
        find({ offset: 1, limit: 1, snapshot_id: first.snapshot_id }),
        find({ offset: 1, limit: 1, snapshot_id: first.snapshot_id }),
    ]);
    expect(state.scans).toBe(1);
    for (const page of pages) {
        expect(page.error).toBeUndefined();
        expect(page.snapshot_id).toBe(first.snapshot_id);
    }
});
it("never caches a failed scan", async () => {
    state.failSearch = true;
    const failed = await Promise.all([find(), find()]);
    expect(state.scans).toBe(1);
    for (const page of failed) expect(page.error).toBe("search failed");
    state.failSearch = false;
    expect((await find()).error).toBeUndefined();
    expect(state.scans).toBe(2);
});
it("drops members trashed since the scan from a cached page", async () => {
    state.groups = [
        [1, 2],
        [3, 4],
        [5, 6, 7],
    ];
    for (const id of [5, 6, 7])
        items.push({ ...items[0], id, key: `ITEM000${id}` });
    const first = await find({ limit: 1 });
    // Trashed without a fingerprint change, as by a write in the same second.
    items[3].deleted = true;
    items[6].deleted = true;
    const page = await find({
        offset: 1,
        limit: 2,
        snapshot_id: first.snapshot_id,
    });
    expect(state.scans).toBe(1);
    expect(page.total_count).toBe(3);
    expect(page.has_more).toBe(false);
    expect(page.groups.map((g) => g.members.map((m) => m.item_id))).toEqual([
        ["u-ITEM0005", "u-ITEM0006"],
    ]);
});
