import { beforeEach, describe, expect, it, vi } from "vitest";

const items = new Map<string, any>();

vi.mock("../../../src/utils/libraryIdentity", () => ({
    parseItemReference: () => null,
    resolveLibraryRef: () => 1,
    resolveItemReference: async (ref: any) => {
        const item = items.get(ref.zotero_key);
        return item ? { status: "found", item } : { status: "not_found" };
    },
    // Production returns the device-portable form, not the numeric id.
    modelObjectId: (_libraryId: number, key: string) => `u-${key}`,
    libraryRefForLibraryID: () => "u",
}));

let excluded = false;
vi.mock("../../../src/services/agentDataProvider/utils", () => ({
    checkLibraryExcluded: () =>
        excluded ? { message: "Library is excluded in Beaver Preferences" } : null,
    excludedLibraryUserMessage: () => "This library is excluded.",
    getDeferredToolPreference: () => "always_ask",
}));

vi.mock(
    "../../../src/services/agentDataProvider/actions/annotationPlacement",
    () => ({ prepareRelocation: vi.fn() }),
);

import { undoEditAnnotationsAction } from "../../../react/utils/editAnnotationsActions";
import type { AgentAction } from "../../../react/agents/agentActions";

const YELLOW = "#ffd400";
const BLUE = "#2ea8e5";

/** Where a move put an annotation, and where it was before. */
const NEW_POSITION = '{"pageIndex":11,"rects":[[10,20,30,40]]}';
const OLD_POSITION = '{"pageIndex":2,"rects":[[1,2,3,4]]}';

/** Snapshot fields recording a move: both ends of it. */
const MOVE_SNAPSHOT = {
    annotation_type: "highlight",
    text: "old text",
    page_label: "3",
    sort_index: "00002|000010|00005",
    position: OLD_POSITION,
    moved_to: {
        text: "new text",
        page_label: "12",
        sort_index: "00011|000200|00050",
        position: NEW_POSITION,
    },
};

function annotation(key: string, overrides: Record<string, any> = {}) {
    let tags: Array<{ tag: string; type?: number }> = [{ tag: "old" }];
    const loaded: Record<string, boolean> = {};
    const item: any = {
        key,
        libraryID: 1,
        deleted: false,
        annotationColor: BLUE,
        annotationComment: "new comment",
        annotationText: "new text",
        annotationPageLabel: "12",
        annotationSortIndex: "00011|000200|00050",
        annotationPosition: NEW_POSITION,
        isAnnotation: () => true,
        loadDataType: vi.fn(async (dataType: string) => {
            loaded[dataType] = true;
        }),
        loadedDataTypes: loaded,
        getTags: () => tags.map((tag) => ({ ...tag })),
        // Mirrors Zotero.Tags.cleanData: a string is a manual tag, and type 0
        // is dropped, so a stored tag carries `type` only when automatic.
        setTags: (next: Array<string | { tag: string; type?: number }>) => {
            tags = next.map((tag) =>
                typeof tag === "string"
                    ? { tag }
                    : tag.type
                      ? { tag: tag.tag, type: tag.type }
                      : { tag: tag.tag },
            );
        },
        save: vi.fn(async () => {}),
        // Mirrors Zotero: saveTx() opens its own transaction, so calling it
        // inside one is the deadlock this stub exists to surface.
        saveTx: vi.fn(async () => {
            if ((globalThis as any).Zotero.DB.inTransaction())
                throw new Error("TimeoutError: saveTx inside an open transaction");
        }),
        ...overrides,
    };
    return item;
}

function snapshot(key: string, overrides: Record<string, any> = {}) {
    return {
        annotation_id: `u-${key}`,
        library_id: 1,
        zotero_key: key,
        library_ref: "u",
        color: YELLOW,
        comment: "old comment",
        tags: ["old"],
        ...overrides,
    };
}

/** An applied edit where every target received the same patch. */
function updateAction(
    changes: Record<string, any>,
    before: Record<string, any>[],
): AgentAction {
    return editAction([{ changes, before }]);
}

/** An applied edit built from one or more distinct per-group patches. */
function editAction(
    groups: Array<{ changes: Record<string, any>; before: Record<string, any>[] }>,
): AgentAction {
    const refOf = (item: Record<string, any>) => ({
        library_id: 1,
        zotero_key: item.zotero_key,
    });
    return {
        id: "action-1",
        run_id: "run-1",
        action_type: "edit_annotations",
        status: "applied",
        proposed_data: {
            operation: "edit",
            edits: groups.map((group) => ({
                annotation_refs: group.before.map(refOf),
                changes: group.changes,
            })),
        },
        result_data: {
            operation: "edit",
            applied_refs: groups.flatMap((group) => group.before.map(refOf)),
            before: groups.flatMap((group) => group.before),
        },
    } as unknown as AgentAction;
}

/** An applied in-place move of AAA. */
function relocateAction(): AgentAction {
    return {
        id: "action-1",
        run_id: "run-1",
        action_type: "edit_annotations",
        status: "applied",
        proposed_data: {
            operation: "edit",
            edits: [
                {
                    annotation_refs: [{ library_id: 1, zotero_key: "AAA" }],
                    relocation: { loc_raw: "s12", content_kind: "pdf" },
                },
            ],
        },
        result_data: {
            operation: "edit",
            applied_refs: [{ library_id: 1, zotero_key: "AAA" }],
            before: [snapshot("AAA", { deleted: false, ...MOVE_SNAPSHOT })],
        },
    } as unknown as AgentAction;
}

beforeEach(() => {
    excluded = false;
    items.clear();
    let inTransaction = false;
    (globalThis as any).Zotero = {
        debug: vi.fn(),
        DB: {
            inTransaction: () => inTransaction,
            executeTransaction: vi.fn(async (callback: () => Promise<void>) => {
                if (inTransaction)
                    throw new Error("TimeoutError: nested executeTransaction");
                inTransaction = true;
                try {
                    return await callback();
                } finally {
                    inTransaction = false;
                }
            }),
        },
    };
});

describe("undoEditAnnotationsAction", () => {
    it("loads annotation, deferred, and tag data before reading fields", async () => {
        const item = annotation("AAA");
        items.set("AAA", item);

        await undoEditAnnotationsAction(
            updateAction({ color: "blue" }, [snapshot("AAA")]),
        );

        expect(item.loadedDataTypes).toEqual({
            annotation: true,
            annotationDeferred: true,
            tags: true,
        });
    });

    it("reverts fields that still hold the applied value", async () => {
        const item = annotation("AAA");
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ color: "blue", comment: "new comment" }, [
                snapshot("AAA"),
            ]),
        );

        expect(item.annotationColor).toBe(YELLOW);
        expect(item.annotationComment).toBe("old comment");
        expect(result.fieldsReverted).toBe(2);
        expect(result.needsConfirmation).toBe(false);
        expect(item.save).toHaveBeenCalledTimes(1);
    });

    it("leaves fields the action never changed untouched", async () => {
        const item = annotation("AAA", { annotationComment: "user comment" });
        items.set("AAA", item);

        await undoEditAnnotationsAction(
            updateAction({ color: "blue" }, [snapshot("AAA")]),
        );

        expect(item.annotationColor).toBe(YELLOW);
        expect(item.annotationComment).toBe("user comment");
    });

    it("preserves fields the user changed after the edit", async () => {
        const item = annotation("AAA", {
            annotationColor: "#5fb236",
            annotationComment: "manually rewritten",
        });
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ color: "blue", comment: "new comment" }, [
                snapshot("AAA"),
            ]),
        );

        expect(item.annotationColor).toBe("#5fb236");
        expect(item.annotationComment).toBe("manually rewritten");
        expect(result.manuallyModified).toEqual(["color", "comment"]);
        expect(result.needsConfirmation).toBe(true);
        expect(result.fieldsReverted).toBe(0);
        expect(item.save).not.toHaveBeenCalled();
    });

    it("preserves a change that lands between resolution and the transaction", async () => {
        const item = annotation("AAA");
        items.set("AAA", item);
        // Resolving the batch awaits per annotation, so a manual edit can land
        // after the state was first read. Reconciling against that stale read
        // would revert the annotation on top of the user's change.
        const db = (globalThis as any).Zotero.DB;
        const executeTransaction = db.executeTransaction;
        db.executeTransaction = vi.fn(async (callback: () => Promise<void>) => {
            item.annotationColor = "#5fb236";
            return executeTransaction(callback);
        });

        const result = await undoEditAnnotationsAction(
            updateAction({ color: "blue" }, [snapshot("AAA")]),
        );

        expect(item.annotationColor).toBe("#5fb236");
        expect(result.manuallyModified).toEqual(["color"]);
        expect(result.fieldsReverted).toBe(0);
        expect(item.save).not.toHaveBeenCalled();
    });

    it("overwrites manual changes when forced", async () => {
        const item = annotation("AAA", { annotationColor: "#5fb236" });
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ color: "blue" }, [snapshot("AAA")]),
            true,
        );

        expect(item.annotationColor).toBe(YELLOW);
        expect(result.fieldsReverted).toBe(1);
        expect(result.needsConfirmation).toBe(false);
    });

    it("skips fields already back at their original value", async () => {
        const item = annotation("AAA", { annotationColor: YELLOW });
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ color: "blue" }, [snapshot("AAA")]),
        );

        expect(result.alreadyReverted).toEqual(["color"]);
        expect(result.fieldsReverted).toBe(0);
        expect(item.save).not.toHaveBeenCalled();
    });

    it("restores tags only when they still match what was applied", async () => {
        const applied = annotation("AAA");
        applied.setTags(["topic"]);
        const edited = annotation("BBB");
        edited.setTags(["user-tag"]);
        items.set("AAA", applied);
        items.set("BBB", edited);

        const result = await undoEditAnnotationsAction(
            updateAction({ remove_tags: ["old"], add_tags: ["topic"] }, [
                snapshot("AAA"),
                snapshot("BBB"),
            ]),
        );

        expect(applied.getTags()).toEqual([{ tag: "old" }]);
        expect(edited.getTags()).toEqual([{ tag: "user-tag" }]);
        expect(result.fieldsReverted).toBe(1);
        expect(result.manuallyModified).toEqual(["tags"]);
    });

    it("restores deleted annotations and skips ones already restored", async () => {
        const trashed = annotation("AAA", { deleted: true });
        const restored = annotation("BBB", { deleted: false });
        items.set("AAA", trashed);
        items.set("BBB", restored);

        const action = {
            id: "action-1",
            run_id: "run-1",
            action_type: "edit_annotations",
            status: "applied",
            proposed_data: {
                operation: "delete",
                annotation_refs: [
                    { library_id: 1, zotero_key: "AAA" },
                    { library_id: 1, zotero_key: "BBB" },
                ],
            },
            result_data: {
                operation: "delete",
                applied_refs: [
                    { library_id: 1, zotero_key: "AAA" },
                    { library_id: 1, zotero_key: "BBB" },
                ],
                before: [
                    snapshot("AAA", { deleted: false }),
                    snapshot("BBB", { deleted: false }),
                ],
            },
        } as unknown as AgentAction;

        const result = await undoEditAnnotationsAction(action);

        expect(trashed.deleted).toBe(false);
        expect(trashed.save).toHaveBeenCalledTimes(1);
        expect(restored.save).not.toHaveBeenCalled();
        expect(result.fieldsReverted).toBe(1);
    });

    it("puts a moved annotation back where it was", async () => {
        const moved = annotation("AAA");
        items.set("AAA", moved);

        const result = await undoEditAnnotationsAction(relocateAction());

        // The annotation was rewritten in place, so undo is a field revert —
        // nothing is trashed and its key never changed.
        expect(moved.deleted).toBe(false);
        expect(moved.annotationPosition).toBe(OLD_POSITION);
        expect(moved.annotationSortIndex).toBe(MOVE_SNAPSHOT.sort_index);
        expect(moved.annotationText).toBe(MOVE_SNAPSHOT.text);
        expect(moved.annotationPageLabel).toBe(MOVE_SNAPSHOT.page_label);
        expect(result.fieldsReverted).toBe(1);
    });

    it("still undoes a relocation persisted under the recreate contract", async () => {
        const original = annotation("OLD", {
            deleted: true,
            annotationColor: YELLOW,
            annotationComment: "old comment",
        });
        const replacement = annotation("NEW");
        items.set("OLD", original);
        items.set("NEW", replacement);

        const action = {
            id: "legacy-move",
            run_id: "run-1",
            action_type: "edit_annotations",
            status: "applied",
            proposed_data: {
                operation: "edit",
                edits: [{
                    annotation_refs: [{ library_id: 1, zotero_key: "OLD" }],
                    changes: { color: "blue", comment: "new comment" },
                    relocation: { locator: "s12" },
                }],
            },
            result_data: {
                operation: "edit",
                applied_refs: [{ library_id: 1, zotero_key: "NEW" }],
                before: [snapshot("OLD", { deleted: false })],
                relocated: [{
                    old_ref: { library_id: 1, zotero_key: "OLD" },
                    new_ref: { library_id: 1, zotero_key: "NEW" },
                }],
            },
        } as unknown as AgentAction;

        const result = await undoEditAnnotationsAction(action);

        expect(original.deleted).toBe(false);
        expect(replacement.deleted).toBe(true);
        expect(result.fieldsReverted).toBe(1);
    });

    it("skips a move already back at its original position", async () => {
        const moved = annotation("AAA", {
            annotationPosition: OLD_POSITION,
            annotationSortIndex: MOVE_SNAPSHOT.sort_index,
            annotationText: MOVE_SNAPSHOT.text,
            annotationPageLabel: MOVE_SNAPSHOT.page_label,
        });
        items.set("AAA", moved);

        const result = await undoEditAnnotationsAction(relocateAction());

        expect(result.alreadyReverted).toContain("position");
        expect(moved.save).not.toHaveBeenCalled();
    });

    it("reconciles each annotation against its own group's patch", async () => {
        const recolored = annotation("AAA", { annotationComment: "untouched" });
        const recommented = annotation("BBB", { annotationColor: YELLOW });
        items.set("AAA", recolored);
        items.set("BBB", recommented);

        const result = await undoEditAnnotationsAction(
            editAction([
                { changes: { color: "blue" }, before: [snapshot("AAA")] },
                {
                    changes: { comment: "new comment" },
                    before: [snapshot("BBB")],
                },
            ]),
        );

        // Only the field each group actually wrote is reverted.
        expect(recolored.annotationColor).toBe(YELLOW);
        expect(recolored.annotationComment).toBe("untouched");
        expect(recommented.annotationComment).toBe("old comment");
        expect(result.fieldsReverted).toBe(2);
    });

    it("reverts an additive tag edit against that annotation's own tags", async () => {
        const item = annotation("AAA");
        // What add_tags: ["added"] would have produced from ["old"].
        item.setTags(["old", "added"]);
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ add_tags: ["added"] }, [snapshot("AAA")]),
        );

        expect(item.getTags()).toEqual([{ tag: "old" }]);
        expect(result.fieldsReverted).toBe(1);
    });

    it("restores automatic tags as automatic", async () => {
        const item = annotation("AAA");
        // What add_tags: ["added"] would have produced from an automatic tag.
        item.setTags([{ tag: "old", type: 1 }, { tag: "added" }]);
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ add_tags: ["added"] }, [
                snapshot("AAA", { automatic_tags: ["old"] }),
            ]),
        );

        expect(item.getTags()).toEqual([{ tag: "old", type: 1 }]);
        expect(result.fieldsReverted).toBe(1);
    });

    it("leaves tags alone when the user re-filed one as manual", async () => {
        const item = annotation("AAA");
        // The action added "added" to an automatic "old". The user has since
        // made "old" a manual tag — a change to the same field, so undo must
        // not quietly file it back as automatic.
        item.setTags([{ tag: "old" }, { tag: "added" }]);
        items.set("AAA", item);

        const result = await undoEditAnnotationsAction(
            updateAction({ add_tags: ["added"] }, [
                snapshot("AAA", { automatic_tags: ["old"] }),
            ]),
        );

        expect(item.getTags()).toEqual([{ tag: "old" }, { tag: "added" }]);
        expect(result.manuallyModified).toEqual(["tags"]);
        expect(result.fieldsReverted).toBe(0);
        expect(item.save).not.toHaveBeenCalled();
    });

    it("undoes a batch where only one annotation moved", async () => {
        const edited = annotation("AAA");
        const moved = annotation("BBB");
        items.set("AAA", edited);
        items.set("BBB", moved);

        const action = {
            id: "action-1",
            run_id: "run-1",
            action_type: "edit_annotations",
            status: "applied",
            proposed_data: {
                operation: "edit",
                edits: [
                    {
                        annotation_refs: [{ library_id: 1, zotero_key: "AAA" }],
                        changes: { color: "blue" },
                    },
                    {
                        annotation_refs: [{ library_id: 1, zotero_key: "BBB" }],
                        relocation: { loc_raw: "s12", content_kind: "pdf" },
                    },
                ],
            },
            result_data: {
                operation: "edit",
                applied_refs: [
                    { library_id: 1, zotero_key: "AAA" },
                    { library_id: 1, zotero_key: "BBB" },
                ],
                before: [
                    snapshot("AAA"),
                    snapshot("BBB", { deleted: false, ...MOVE_SNAPSHOT }),
                ],
            },
        } as unknown as AgentAction;

        await undoEditAnnotationsAction(action);

        // Each annotation reverts only what its own group changed: the first
        // its color, the second its position.
        expect(edited.annotationColor).toBe(YELLOW);
        expect(edited.annotationPosition).toBe(NEW_POSITION);
        expect(moved.annotationPosition).toBe(OLD_POSITION);
    });

    it("does not discard a move the user made themselves", async () => {
        // The user dragged the annotation somewhere else after Beaver moved it.
        const moved = annotation("AAA", {
            annotationPosition: '{"pageIndex":30,"rects":[[9,9,9,9]]}',
        });
        items.set("AAA", moved);

        const result = await undoEditAnnotationsAction(relocateAction());

        expect(moved.annotationPosition).toBe(
            '{"pageIndex":30,"rects":[[9,9,9,9]]}',
        );
        expect(result.manuallyModified).toEqual(["position"]);
        expect(result.needsConfirmation).toBe(true);
    });

    it("overwrites the user's own move once they confirm", async () => {
        const moved = annotation("AAA", {
            annotationPosition: '{"pageIndex":30,"rects":[[9,9,9,9]]}',
        });
        items.set("AAA", moved);

        await undoEditAnnotationsAction(relocateAction(), true);

        expect(moved.annotationPosition).toBe(OLD_POSITION);
    });

    it("refuses to write to a library excluded since the action was applied", async () => {
        const item = annotation("AAA");
        items.set("AAA", item);
        excluded = true;

        await expect(
            undoEditAnnotationsAction(
                updateAction({ color: "blue" }, [snapshot("AAA")]),
            ),
        ).rejects.toThrow(/excluded/i);

        // Nothing may be written, and the boundary is checked before the lookup.
        expect(item.save).not.toHaveBeenCalled();
        expect(item.annotationColor).toBe(BLUE);
    });

    it("restores in-memory state when the transaction fails", async () => {
        const item = annotation("AAA");
        items.set("AAA", item);
        item.save = vi.fn(async () => {
            throw new Error("db busy");
        });

        await expect(
            undoEditAnnotationsAction(
                updateAction({ color: "blue", comment: "new comment" }, [
                    snapshot("AAA"),
                ]),
            ),
        ).rejects.toThrow("db busy");

        expect(item.annotationColor).toBe(BLUE);
        expect(item.annotationComment).toBe("new comment");
    });
});
