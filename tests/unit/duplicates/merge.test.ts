import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ excluded: false, bodyRan: false }));
const deferredCommits = vi.hoisted(() => ({ wait: vi.fn(async () => true) }));
vi.mock("../../../src/services/committedTransaction", () => ({
    waitForDeferredCommits: deferredCommits.wait,
}));
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
/** Native merge that moves a related-item relation and records the replaced item. */
function mergeWithRelatedItem() {
    vi.mocked(Zotero.Items.merge).mockImplementation((master: any, others: any[]) =>
        Zotero.DB.executeTransaction(async () => {
            master.json.tags = [{ tag: "test" }];
            master.json.relations = {
                "dc:relation": ["uri:CCCC3333"],
                "dc:replaces": [`uri:${others[0].key}`],
            };
            for (const i of others) i.deleted = true;
        }),
    );
}
beforeEach(() => {
    state.excluded = false;
    state.bodyRan = false;
    deferredCommits.wait.mockReset();
    deferredCommits.wait.mockResolvedValue(true);
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
        Relations: {
            getByObject: async () => [],
            // Items whose relations hold `predicate object`, as Zotero's index answers.
            getByPredicateAndObject: async (_: string, predicate: string, object: string) =>
                items.filter((i) => [i.json.relations?.[predicate] ?? []].flat().includes(object)),
        },
        URI: {
            getItemURI: (i: any) => `uri:${i.key}`,
            getURIItem: async (uri: string) => items.find((i) => `uri:${i.key}` === uri) ?? false,
        },
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
                    master.json.relations = { "dc:replaces": [`uri:${others[0].key}`] };
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
    it("completes without writing when the merge was already reverted outside Beaver", async () => {
        const before = items.map((i) => clone(i.json));
        const result = await applyMerge(await proposal());
        items.forEach((i, n) => (i.json = clone(before[n])));
        await undoMergeItemsAction({ result_data: result } as any);
        expect(items.map((i) => i.json)).toEqual(before);
        for (const item of items) expect(item.save).not.toHaveBeenCalled();
    });
    it("restores the rest after the user restored the duplicate from the trash", async () => {
        mergeWithRelatedItem();
        const before = items.map((i) => clone(i.json));
        const result = await applyMerge(await proposal());
        // Zotero drops the master's merge-tracking relation on restore.
        items[1].deleted = false;
        delete items[0].json.relations["dc:replaces"];
        await undoMergeItemsAction({ result_data: result } as any);
        expect(items.map((i) => i.json)).toEqual(before);
        expect(items[0].save).toHaveBeenCalledOnce();
        expect(items[1].save).not.toHaveBeenCalled();
    });
    it("refuses a relation added after the merge", async () => {
        mergeWithRelatedItem();
        const result = await applyMerge(await proposal());
        items[0].json.relations["dc:relation"].push("uri:LATER");
        await expect(
            undoMergeItemsAction({ result_data: result } as any),
        ).rejects.toThrow("relations changed after");
        expect(items[1].deleted).toBe(true);
    });
    it("refuses undo when the restored duplicate was since merged into another item", async () => {
        const result = await applyMerge(await proposal());
        // Restoring B drops A's tracking; B is then merged into C.
        delete items[0].json.relations["dc:replaces"];
        items.push(
            makeItem(3, "CCCC3333", {
                itemType: "journalArticle",
                title: "Paper",
                relations: { "dc:replaces": ["uri:BBBB2222"] },
                deleted: false,
            }),
        );
        await expect(
            undoMergeItemsAction({ result_data: result } as any),
        ).rejects.toThrow("merged into another item afterwards");
        expect(items[1].deleted).toBe(true);
        expect(items[2].json.relations).toEqual({ "dc:replaces": ["uri:BBBB2222"] });
        for (const item of items) expect(item.save).not.toHaveBeenCalled();
    });
    it("refuses undo when the merge tracking is gone but the duplicate is still in the trash", async () => {
        const result = await applyMerge(await proposal());
        delete items[0].json.relations["dc:replaces"];
        await expect(
            undoMergeItemsAction({ result_data: result } as any),
        ).rejects.toThrow("changed after the merge");
        expect(items[1].deleted).toBe(true);
    });
    describe("merge tracking inherited from an earlier merge", () => {
        // D was merged into B earlier; merging B into A moves "B replaces D" to A.
        beforeEach(() => {
            items[1].json.relations = { "dc:replaces": ["uri:DDDD4444"] };
            items.push(
                makeItem(4, "DDDD4444", {
                    itemType: "journalArticle",
                    title: "Paper",
                    relations: {},
                    deleted: true,
                }),
            );
            vi.mocked(Zotero.Items.merge).mockImplementation((master: any, others: any[]) =>
                Zotero.DB.executeTransaction(async () => {
                    master.json.relations = {
                        "dc:replaces": ["uri:DDDD4444", `uri:${others[0].key}`],
                    };
                    others[0].json.relations = {};
                    for (const i of others) i.deleted = true;
                }),
            );
        });
        it("hands the inherited tracking back to the restored duplicate", async () => {
            const result = await applyMerge(await proposal());
            await undoMergeItemsAction({ result_data: result } as any);
            expect(items[0].json.relations).toEqual({});
            expect(items[1].json.relations).toEqual({ "dc:replaces": ["uri:DDDD4444"] });
            expect(items[1].deleted).toBe(false);
        });
        it("refuses undo after the inherited duplicate was restored from the trash", async () => {
            const result = await applyMerge(await proposal());
            // Zotero's undelete drops every tracking relation that points at D.
            items[2].deleted = false;
            items[0].json.relations = { "dc:replaces": ["uri:BBBB2222"] };
            await expect(
                undoMergeItemsAction({ result_data: result } as any),
            ).rejects.toThrow("relations changed after");
            expect(items[1].json.relations).toEqual({});
        });
        it("refuses undo when both duplicates were restored, so the master looks unmerged", async () => {
            const result = await applyMerge(await proposal());
            items[2].deleted = false;
            items[1].deleted = false;
            items[0].json.relations = {};
            await expect(
                undoMergeItemsAction({ result_data: result } as any),
            ).rejects.toThrow("restored or merged again afterwards");
            expect(items[1].json.relations).toEqual({});
        });
        it("refuses undo after the inherited duplicate was merged into another item", async () => {
            const result = await applyMerge(await proposal());
            items[0].json.relations = { "dc:replaces": ["uri:BBBB2222"] };
            items.push(
                makeItem(5, "EEEE5555", {
                    itemType: "journalArticle",
                    title: "Paper",
                    relations: { "dc:replaces": ["uri:DDDD4444"] },
                    deleted: false,
                }),
            );
            await expect(
                undoMergeItemsAction({ result_data: result } as any),
            ).rejects.toThrow("changed after");
            expect(items.find((i) => i.key === "EEEE5555").json.relations).toEqual({
                "dc:replaces": ["uri:DDDD4444"],
            });
        });
    });
    describe("a related-item link the merge rewrote", () => {
        beforeEach(() => {
            // The item linked to the duplicate; the merge points the link at the master.
            items[0].json.relations = { "dc:relation": ["uri:DUPLICATE"] };
            vi.mocked(Zotero.Items.merge).mockImplementation((master: any, others: any[]) =>
                Zotero.DB.executeTransaction(async () => {
                    master.json.relations = {
                        "dc:relation": ["uri:MASTER"],
                        "dc:replaces": [`uri:${others[0].key}`],
                    };
                    for (const i of others) i.deleted = true;
                }),
            );
        });
        it("refuses undo when the user removed the link after the merge", async () => {
            const result = await applyMerge(await proposal());
            delete items[0].json.relations["dc:relation"];
            await expect(
                undoMergeItemsAction({ result_data: result } as any),
            ).rejects.toThrow("relations changed after");
            expect(items[0].json.relations).toEqual({ "dc:replaces": ["uri:BBBB2222"] });
            expect(items[1].deleted).toBe(true);
        });
        it("refuses undo when the link was removed and the duplicate restored from the trash", async () => {
            const result = await applyMerge(await proposal());
            items[0].json.relations = {};
            items[1].deleted = false;
            await expect(
                undoMergeItemsAction({ result_data: result } as any),
            ).rejects.toThrow("relations changed after");
            expect(items[0].json.relations).toEqual({});
        });
        it("restores the link when only the merge-tracking relation was dropped", async () => {
            const result = await applyMerge(await proposal());
            items[1].deleted = false;
            delete items[0].json.relations["dc:replaces"];
            await undoMergeItemsAction({ result_data: result } as any);
            expect(items[0].json.relations).toEqual({ "dc:relation": ["uri:DUPLICATE"] });
        });
    });
    it("still refuses a field that holds neither the merged nor the original value", async () => {
        const result = await applyMerge(await proposal());
        items[0].json.tags = [{ tag: "later" }];
        items[1].deleted = false;
        await expect(
            undoMergeItemsAction({ result_data: result } as any),
        ).rejects.toThrow("changed after");
        expect(items[0].json.tags).toEqual([{ tag: "later" }]);
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
    it("starts the native merge only after earlier deferred commits have settled", async () => {
        let release!: (settled: boolean) => void;
        deferredCommits.wait.mockReturnValue(new Promise<boolean>((resolve) => { release = resolve; }));
        const pending = applyMerge(await proposal());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(deferredCommits.wait).toHaveBeenCalledOnce();
        expect(Zotero.Items.merge).not.toHaveBeenCalled();
        release(true);
        await pending;
        expect(Zotero.Items.merge).toHaveBeenCalledOnce();
    });
    it("still merges when earlier deferred commits outlast the wait", async () => {
        deferredCommits.wait.mockResolvedValue(false);
        await applyMerge(await proposal());
        expect(Zotero.Items.merge).toHaveBeenCalledOnce();
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
