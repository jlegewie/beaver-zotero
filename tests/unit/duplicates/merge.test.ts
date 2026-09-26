import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ excluded: false, bodyRan: false }));
vi.mock("../../../src/services/agentDataProvider/utils", () => ({
    checkLibraryExcluded: () =>
        state.excluded ? { message: "Excluded library" } : null,
    getDeferredToolPreference: () => "always_ask",
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    modelObjectId: (_: number, key: string) => `u-${key}`,
    libraryRefForLibraryID: () => "u",
    parseItemReference: (id: string) =>
        typeof id === "string" && id.startsWith("u-")
            ? { zotero_key: id.slice(2), library_ref: "u" }
            : null,
    resolveLibraryRef: () => 1,
}));
import {
    applyMerge,
    undoMergeItemsAction,
    validateMergeItemsAction,
} from "../../../src/services/duplicates/merge";
let items: any[];
const clone = (v: any) => JSON.parse(JSON.stringify(v));
function makeItem(id: number, key: string, json: any) {
    return {
        id,
        key,
        libraryID: 1,
        itemTypeID: 1,
        itemType: "journalArticle",
        dateAdded: "2024-01-01",
        json,
        get deleted() {
            return !!this.json.deleted;
        },
        set deleted(v: boolean) {
            this.json.deleted = v;
        },
        isRegularItem: () => true,
        isNote: () => false,
        isAttachment: () => false,
        isAnnotation: () => false,
        isFileAttachment: () => false,
        getField(field: string) {
            return this.json[field] ?? "";
        },
        dirty: false,
        setField(field: string, value: any) {
            this.dirty = true;
            this.json[field] = value;
        },
        getCreators() {
            return this.json.creators ?? [];
        },
        setCreators(v: any) {
            this.json.creators = v;
        },
        getAttachments: () => [],
        getNotes: () => [],
        loadAllData: vi.fn(async () => {}),
        reload: vi.fn(async function (this: any) {
            this.dirty = false;
        }),
        erase: vi.fn(async () => {}),
        toJSON() {
            return clone(this.json);
        },
        fromJSON(v: any) {
            this.json = clone(v);
        },
        save: vi.fn(async () => {}),
    };
}
async function proposal() {
    return (
        await validateMergeItemsAction({
            request_id: "validate",
            action_data: {
                master_item_id: "u-AAAA1111",
                other_item_ids: ["u-BBBB2222"],
            },
        } as any)
    ).normalized_action_data as any;
}
beforeEach(() => {
    state.excluded = false;
    state.bodyRan = false;
    items = [
        makeItem(1, "AAAA1111", {
            itemType: "journalArticle",
            title: "Paper",
            abstractNote: "",
            tags: [],
            collections: [],
            relations: {},
            deleted: false,
        }),
        makeItem(2, "BBBB2222", {
            itemType: "journalArticle",
            title: "Paper",
            abstractNote: "Full abstract",
            tags: [{ tag: "test" }],
            collections: [],
            relations: {},
            deleted: false,
        }),
    ];
    vi.stubGlobal("Zotero", {
        Libraries: { get: () => ({ editable: true }) },
        Relations: { getByObject: async () => [] },
        URI: { getItemURI: (i: any) => `uri:${i.key}` },
        ItemFields: { getID: () => 1, isValidForType: () => true },
        Items: {
            loadDataTypes: async () => {},
            getAsync: async (ids: number[]) =>
                items.filter((i) => ids.includes(i.id)),
            getByLibraryAndKeyAsync: async (_: number, key: string) =>
                items.find((i) => i.key === key),
            merge: vi.fn((master: any, others: any[]) =>
                Zotero.DB.executeTransaction(async () => {
                    state.bodyRan = true;
                    master.json.tags = [{ tag: "test" }];
                    master.json.relations = { replaces: others[0].key };
                    for (const i of others) i.deleted = true;
                }),
            ),
        },
        DB: {
            waitForTransaction: async () => {},
            valueQueryAsync: async () => Math.max(...items.map((i) => i.id)),
            executeTransaction: async (fn: any) => {
                const before = items.map((i) => clone(i.json));
                try {
                    return await fn();
                } catch (e) {
                    items.splice(before.length);
                    items.forEach((i, n) => (i.json = before[n]));
                    throw e;
                }
            },
        },
    });
});
describe("native merge action", () => {
    it("delegates merging to Zotero and restores the changed state on undo", async () => {
        const data = await proposal();
        data.field_sources = { abstractNote: "u-BBBB2222" };
        const before = items.map((i) => clone(i.json));
        const result = await applyMerge(data);
        expect(Zotero.Items.merge).toHaveBeenCalledOnce();
        expect(items[0].json.abstractNote).toBe("Full abstract");
        expect(items[1].deleted).toBe(true);
        await undoMergeItemsAction({ result_data: result } as any);
        expect(items.map((i) => i.json)).toEqual(before);
    });
    it("rejects an edit made after proposal without invoking merge", async () => {
        const data = await proposal();
        items[1].json.title = "Changed";
        await expect(applyMerge(data)).rejects.toThrow("changed since");
        expect(state.bodyRan).toBe(false);
    });
    it("preserves unrelated later edits during undo", async () => {
        const result = await applyMerge(await proposal());
        items[0].json.title = "Later title";
        await undoMergeItemsAction({ result_data: result } as any);
        expect(items[0].json.title).toBe("Later title");
        expect(items[1].deleted).toBe(false);
    });
    it("refuses conflicting undo atomically", async () => {
        const result = await applyMerge(await proposal());
        items[0].json.tags.push({ tag: "later" });
        await expect(
            undoMergeItemsAction({ result_data: result } as any),
        ).rejects.toThrow("changed after");
        expect(items[1].deleted).toBe(true);
    });
    it("rechecks library exclusions before executing", async () => {
        const data = await proposal();
        state.excluded = true;
        await expect(applyMerge(data)).rejects.toThrow("Excluded");
        expect(Zotero.Items.merge).not.toHaveBeenCalled();
    });
    it("rolls back native failures", async () => {
        const data = await proposal();
        const before = items.map((i) => clone(i.json));
        vi.mocked(Zotero.Items.merge).mockImplementation(async () =>
            Zotero.DB.executeTransaction(async () => {
                items[0].json.tags = ["partial"];
                throw Error("native failure");
            }),
        );
        await expect(applyMerge(data)).rejects.toThrow("native failure");
        expect(items.map((i) => i.json)).toEqual(before);
    });
    it("does not open an outer transaction around the native merge", async () => {
        const native = vi.mocked(Zotero.Items.merge);
        const transaction = vi.spyOn(Zotero.DB, "executeTransaction");
        await applyMerge(await proposal());
        expect(native).toHaveBeenCalledOnce();
        expect(transaction).toHaveBeenCalledOnce();
        expect(Zotero.DB.executeTransaction).toBe(transaction);
    });
    it("does not accept the same record twice", async () => {
        await expect(
            validateMergeItemsAction({
                request_id: "x",
                action_data: {
                    master_item_id: "u-AAAA1111",
                    other_item_ids: ["u-AAAA1111"],
                },
            } as any),
        ).rejects.toThrow("distinct");
    });
});

it("opening a PDF does not invalidate the proposal or undo its reader state", async () => {
    items[0].json.lastRead = "before";
    const data = await proposal();
    items[0].json.lastRead = "reviewed";
    const result = await applyMerge(data);
    items[0].json.lastRead = "after";
    await undoMergeItemsAction({ result_data: result } as any);
    expect(items[0].json.lastRead).toBe("after");
});
it("rolls back when collecting post-merge snapshots fails", async () => {
    const data = await proposal();
    const before = items.map((i) => clone(i.json));
    items[0].loadAllData.mockImplementation(async () => {
        if (state.bodyRan) throw Error("snapshot failed");
    });
    await expect(applyMerge(data)).rejects.toThrow("snapshot failed");
    expect(items.map((i) => i.json)).toEqual(before);
    expect(items[0].reload).toHaveBeenCalledWith(undefined, true);
});
it("rolls back if cancellation arrives during the native merge", async () => {
    const data = await proposal();
    const before = items.map((i) => clone(i.json));
    const controller = new AbortController();
    vi.mocked(Zotero.Items.merge).mockImplementation(() =>
        Zotero.DB.executeTransaction(async () => {
            items[1].deleted = true;
            controller.abort();
        }),
    );
    await expect(
        applyMerge(data, {
            signal: controller.signal,
            startTime: Date.now(),
            timeoutSeconds: 120,
        }),
    ).rejects.toThrow("timed out");
    expect(items.map((i) => i.json)).toEqual(before);
});
it("clears cached dirty metadata after rolling back source choices", async () => {
    const data = await proposal();
    data.field_sources = { abstractNote: "u-BBBB2222" };
    vi.mocked(Zotero.Items.merge).mockImplementation(() =>
        Zotero.DB.executeTransaction(async () => {
            throw Error("native failed");
        }),
    );
    await expect(applyMerge(data)).rejects.toThrow("native failed");
    expect(items[0].json.abstractNote).toBe("");
    expect(items[0].dirty).toBe(false);
});
it("never erases an object solely because the before snapshot is missing", async () => {
    await expect(
        undoMergeItemsAction({
            result_data: {
                changes: [
                    {
                        item_id: "u-AAAA1111",
                        before: null,
                        after: items[0].json,
                    },
                ],
            },
        } as any),
    ).rejects.toThrow("does not establish");
    expect(items[0].erase).not.toHaveBeenCalled();
});
it("retains the undo result when Zotero reports an error after committing", async () => {
    const data = await proposal();
    const execute = Zotero.DB.executeTransaction;
    Zotero.DB.executeTransaction = async (fn: any) => {
        await execute(fn);
        throw Object.assign(Error("commit observer failed"), {
            committed: true,
        });
    };
    const result = await applyMerge(data);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(items[1].deleted).toBe(true);
});
it("rejects a newly discovered pre-existing object instead of recording it as created", async () => {
    const unrelated = makeItem(3, "CCCC3333", {
        itemType: "journalArticle",
        title: "Unrelated",
    });
    items.push(unrelated);
    const data = await proposal();
    Zotero.Relations.getByObject = async () =>
        state.bodyRan ? [{ subject: unrelated }] : [];
    await expect(applyMerge(data)).rejects.toThrow(
        "outside its reviewed inventory",
    );
    expect(items[1].deleted).toBe(false);
    expect(unrelated.erase).not.toHaveBeenCalled();
});
it("permits new native notes past the preflight cap and explicitly records their creation", async () => {
    for (let id = 3; id <= 2000; id++) {
        const note = makeItem(id, `N${String(id).padStart(7, "0")}`, {
            itemType: "note",
            note: "Note",
            parentItem: items[0].key,
        });
        Object.assign(note, {
            isRegularItem: () => false,
            isNote: () => true,
            parentID: 1,
        });
        items.push(note);
    }
    items[0].getNotes = () => items.filter((i) => i.isNote()).map((i) => i.id);
    const data = await proposal();
    vi.mocked(Zotero.Items.merge).mockImplementation(() =>
        Zotero.DB.executeTransaction(async () => {
            const note = makeItem(2001, "NEWN0001", {
                itemType: "note",
                note: "Embedded note",
                parentItem: items[0].key,
            });
            Object.assign(note, {
                isRegularItem: () => false,
                isNote: () => true,
                parentID: 1,
            });
            items.push(note);
            items[1].deleted = true;
        }),
    );
    const result = await applyMerge(data);
    expect(
        result.changes.find((c) => c.item_id === "u-NEWN0001"),
    ).toMatchObject({ before: null, created_by_merge: true });
});
it("restores Zotero's transaction entry before native async work begins", async () => {
    const data = await proposal();
    const original = Zotero.DB.executeTransaction;
    vi.mocked(Zotero.Items.merge).mockImplementation(() =>
        Zotero.DB.executeTransaction(async () => {
            expect(Zotero.DB.executeTransaction).toBe(original);
            await Promise.resolve();
            expect(Zotero.DB.executeTransaction).toBe(original);
            throw Error("native rejection");
        }),
    );
    await expect(applyMerge(data)).rejects.toThrow("native rejection");
    expect(Zotero.DB.executeTransaction).toBe(original);
});

it("writes nothing when the native merge enters its transaction asynchronously", async () => {
    // The wrapper can only extend a transaction the native merge opens
    // synchronously. A build that yields first would otherwise merge outside
    // the wrapper: unreviewed, with no undo record, and irreversible.
    const data = await proposal();
    const before = items.map((i) => clone(i.json));
    const original = Zotero.DB.executeTransaction;
    vi.mocked(Zotero.Items.merge).mockImplementation(
        async (master: any, others: any[]) => {
            await Promise.resolve();
            return Zotero.DB.executeTransaction(async () => {
                state.bodyRan = true;
                for (const i of others) i.deleted = true;
            });
        },
    );
    await expect(applyMerge(data)).rejects.toThrow("synchronously");
    expect(state.bodyRan).toBe(false);
    expect(items.map((i) => i.json)).toEqual(before);
    expect(Zotero.DB.executeTransaction).toBe(original);
});
