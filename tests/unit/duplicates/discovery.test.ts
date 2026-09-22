import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
    excluded: false,
    failSearch: false,
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
        Utilities: { Internal: { md5: (s: string) => s } },
        DB: { queryAsync: vi.fn(async () => {}) },
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
    expect(
        (await find({ offset: 1, snapshot_id: first.snapshot_id })).error_code,
    ).toBe("stale_snapshot");
});
it("retains out-of-collection members of a matching group", async () => {
    const result = await find({ collection: "COLL1234" });
    expect(result.total_count).toBe(1);
    expect(result.groups[0].members.map((m) => m.item_id)).toEqual([
        "u-ITEM0001",
        "u-ITEM0002",
    ]);
});
it("releases native temporary tables on success and failure", async () => {
    await find();
    state.failSearch = true;
    expect((await find()).error).toBe("search failed");
    expect(Zotero.DB.queryAsync).toHaveBeenCalledTimes(2);
    expect(Zotero.DB.queryAsync).toHaveBeenLastCalledWith(
        "DROP TABLE IF EXISTS tmpDuplicates_TEST",
    );
});
it("returns complete field comparisons only for inspect", async () => {
    expect((await find()).groups[0].members[0].fields).not.toHaveProperty(
        "abstractNote",
    );
    const result = await handleDuplicatesRequest({
        event: "duplicates_request",
        request_id: "i",
        mode: "inspect",
        item_ids: ["u-ITEM0001", "u-ITEM0002"],
    });
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
    const result = await handleDuplicatesRequest({
        event: "duplicates_request",
        request_id: "i",
        mode: "inspect",
        item_ids: ["u-ITEM0001", "u-ITEM0002"],
    });
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
