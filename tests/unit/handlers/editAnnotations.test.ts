import { beforeEach, describe, expect, it, vi } from "vitest";

const items = new Map<string, any>();

vi.mock("../../../src/utils/libraryIdentity", () => ({
    parseItemReference: (id: string) => {
        const match = /^1-(.+)$/.exec(id);
        return match ? { library_id: 1, zotero_key: match[1] } : null;
    },
    resolveLibraryRef: () => 1,
    resolveItemReference: async (ref: any) => {
        const item = items.get(ref.zotero_key);
        return item ? { status: "found", item } : { status: "not_found" };
    },
    // Production returns the device-portable form, not the numeric id.
    modelObjectId: (_libraryId: number, key: string) => `u-${key}`,
    libraryRefForLibraryID: () => "u",
}));

let deferredPreference = "always_apply";
let deletionGrantedForRun = false;
const preferenceLookups: string[] = [];
vi.mock("../../../src/services/agentDataProvider/utils", () => ({
    checkLibraryExcluded: () => null,
    // Mirrors the real group resolution: delete_annotations sits in its own
    // group with no persisted preference, so it resolves to always_ask unless
    // a per-run grant raises it.
    getDeferredToolPreference: (toolName: string) => {
        preferenceLookups.push(toolName);
        if (toolName === "delete_annotations")
            return deletionGrantedForRun ? "always_apply" : "always_ask";
        return deferredPreference;
    },
}));

/** The placement a successfully prepared move writes onto the annotation. */
const MOVED_PLACEMENT = {
    text: "moved text",
    pageLabel: "12",
    sortIndex: "00011|000200|00050",
    position: '{"pageIndex":11,"rects":[[10,20,30,40]]}',
};

const prepareRelocation = vi.fn(
    async (_attachment: any, _annotationType: string, relocation: any) => {
        if (relocation.loc_raw === "s999")
            throw new Error(`Locator '${relocation.loc_raw}' was not found`);
        return MOVED_PLACEMENT;
    },
);
vi.mock(
    "../../../src/services/agentDataProvider/actions/annotationPlacement",
    () => ({
        prepareRelocation: (...args: any[]) =>
            (prepareRelocation as any)(...args),
    }),
);

const unsetTrashedAnnotationsInOpenReaders = vi.fn();
const refreshMovedAnnotationsInOpenReaders = vi.fn(async () => {});
vi.mock("../../../src/services/annotations/readerSync", () => ({
    unsetTrashedAnnotationsInOpenReaders: (...args: any[]) =>
        (unsetTrashedAnnotationsInOpenReaders as any)(...args),
    refreshMovedAnnotationsInOpenReaders: (...args: any[]) =>
        (refreshMovedAnnotationsInOpenReaders as any)(...args),
}));

/** A resolved move destination, as the backend now sends it. */
const relocation = (loc = "s12") => ({
    loc_raw: loc,
    content_kind: "pdf",
    attachment_ref: { library_id: 1, zotero_key: "ATT00001" },
    note_position: { page_index: 11, x: 15, y: 30, side: "left" },
    page_locations: [
        {
            page_idx: 11,
            boxes: [{ l: 10, t: 20, r: 30, b: 40 }],
            page_label: "12",
        },
    ],
    text: "moved text",
    page_label: "12",
});

import {
    executeEditAnnotationsAction,
    validateEditAnnotationsAction,
} from "../../../src/services/agentDataProvider/actions/editAnnotations";

/**
 * A Zotero.DB stub that enforces the real transaction contract:
 * `saveTx()` opens its own transaction and deadlocks (TimeoutError) when one
 * is already open, while `save()` requires an open one. Without this the
 * nesting bug is invisible to tests.
 */
function makeDB() {
    let inTransaction = false;
    return {
        inTransaction: () => inTransaction,
        valueQueryAsync: vi.fn(async () => false),
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
    };
}

function annotation(key: string, save = vi.fn(async () => {})) {
    let tags: Array<{ tag: string; type?: number }> = [{ tag: `old-${key}` }];
    return {
        id: key === "AAA" ? 1 : 2,
        key,
        libraryID: 1,
        parentID: 100,
        deleted: false,
        annotationColor: "#ffd400",
        annotationComment: `comment-${key}`,
        annotationType: "highlight",
        annotationText: `text-${key}`,
        annotationPageLabel: `page-${key}`,
        annotationSortIndex: `sort-${key}`,
        annotationPosition: `position-${key}`,
        isAnnotation: () => true,
        loadDataType: vi.fn(async () => {}),
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
        save,
        // Mirrors Zotero: saveTx() opens its own transaction, so calling it
        // inside one is the deadlock this stub exists to surface.
        saveTx: vi.fn(async () => {
            if ((globalThis as any).Zotero.DB.inTransaction())
                throw new Error(
                    "TimeoutError: saveTx inside an open transaction",
                );
        }),
    };
}

function validate(actionData: Record<string, any>) {
    return validateEditAnnotationsAction({
        event: "agent_action_validate",
        request_id: "v1",
        action_type: "edit_annotations",
        action_data: actionData,
    } as any);
}

function execute(actionData: Record<string, any>, signal?: AbortSignal) {
    return executeEditAnnotationsAction(
        {
            event: "agent_action_execute",
            request_id: "e1",
            action_type: "edit_annotations",
            action_data: actionData,
        } as any,
        {
            signal: signal ?? new AbortController().signal,
            timeoutSeconds: 25,
            startTime: Date.now(),
        },
    );
}

function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
}

const refs = (...keys: string[]) =>
    keys.map((zotero_key) => ({ library_id: 1, zotero_key }));

const ref = (key: string) => ({
    library_id: 1,
    zotero_key: key,
    library_ref: "u",
});

/** A snapshot as validation stores it on the proposal. */
const preview = (key: string, overrides: Record<string, any> = {}) => ({
    annotation_id: `u-${key}`,
    ...ref(key),
    color: "#ffd400",
    comment: `comment-${key}`,
    tags: [`old-${key}`],
    ...overrides,
});

beforeEach(() => {
    prepareRelocation.mockClear();
    unsetTrashedAnnotationsInOpenReaders.mockClear();
    refreshMovedAnnotationsInOpenReaders.mockClear();
    deferredPreference = "always_apply";
    deletionGrantedForRun = false;
    items.clear();
    items.set("AAA", annotation("AAA"));
    items.set("BBB", annotation("BBB"));
    const attachment = {
        id: 100,
        key: "ATT00001",
        parentID: 200,
        deleted: false,
        isAttachment: () => true,
    };
    const parent = { id: 200, deleted: false };
    (globalThis as any).Zotero = {
        debug: vi.fn(),
        Libraries: { get: () => ({ name: "My Library", editable: true }) },
        Items: {
            getAsync: vi.fn(async (id: number) =>
                id === 100 ? attachment : parent,
            ),
        },
        DB: makeDB(),
    };
});

describe("edit_annotations validation", () => {
    it("normalizes each group and snapshots every target", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA", "BBB"),
                    changes: {
                        color: "blue",
                        add_tags: [" topic ", "topic", ""],
                    },
                },
            ],
        });

        expect(response.valid).toBe(true);
        expect(response.normalized_action_data).toMatchObject({
            operation: "edit",
            edits: [
                {
                    annotation_refs: [ref("AAA"), ref("BBB")],
                    changes: { color: "blue", add_tags: ["topic"] },
                },
            ],
            skipped: [],
        });
        expect(response.current_value.annotations).toHaveLength(2);
        expect(response.current_value.annotations[0]).toMatchObject({
            annotation_id: "u-AAA",
            color: "#ffd400",
            comment: "comment-AAA",
            tags: ["old-AAA"],
        });
        // No automatic tags here, so the field stays off the snapshot.
        expect(response.current_value.annotations[0]).not.toHaveProperty(
            "automatic_tags",
        );
    });

    it("records which tags were automatic on the snapshot", async () => {
        // `tags` is names only, so undo restores from it — without the types
        // it would file every automatic tag back as a manual one.
        items.get("AAA").setTags([{ tag: "auto", type: 1 }, { tag: "manual" }]);

        const response = await validate({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "blue" } },
            ],
        });

        expect(response.current_value.annotations[0]).toMatchObject({
            tags: ["auto", "manual"],
            automatic_tags: ["auto"],
        });
    });

    /**
     * The approval card and the history entry render annotations by content,
     * and result data is cleared when an action resolves — so the display half
     * of each snapshot rides on the proposal, which is persisted.
     */
    it("persists a display snapshot of every target on the proposal", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { color: "blue" },
                },
            ],
        });

        const previews = (response.normalized_action_data as any)
            .annotation_previews;
        expect(previews).toEqual([
            {
                annotation_id: "u-AAA",
                library_id: 1,
                library_ref: "u",
                zotero_key: "AAA",
                annotation_type: "highlight",
                color: "#ffd400",
                comment: "comment-AAA",
                tags: ["old-AAA"],
                page_label: "page-AAA",
                text: "text-AAA",
            },
        ]);
    });

    /**
     * The proposal is replayed verbatim on execute and on re-apply, so the
     * handler has to accept back the field validation put there.
     */
    it("accepts its own previews when the proposal is replayed", async () => {
        const validated = await validate({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "blue" } },
            ],
        });

        const response = await execute(
            validated.normalized_action_data as Record<string, any>,
        );

        expect(response.success).toBe(true);
    });

    it("keeps distinct payloads per group", async () => {
        const response = await validate({
            edits: [
                { annotation_refs: refs("AAA"), changes: { comment: "first" } },
                {
                    annotation_refs: refs("BBB"),
                    changes: { comment: "second" },
                },
            ],
        });

        expect(response.valid).toBe(true);
        const edits = (response.normalized_action_data as any).edits;
        expect(edits[0].changes.comment).toBe("first");
        expect(edits[1].changes.comment).toBe("second");
    });

    it.each([
        [{ edits: [] }, "no_annotations"],
        [
            {
                edits: [
                    {
                        annotation_refs: refs("AAA"),
                        changes: { color: "pink" },
                    },
                ],
            },
            "invalid_color",
        ],
        [
            {
                edits: [
                    {
                        annotation_refs: refs("AAA"),
                        changes: { text: "forbidden" },
                    },
                ],
            },
            "field_restricted",
        ],
        [
            { edits: [{ annotation_refs: refs("AAA"), changes: {} }] },
            "no_changes",
        ],
        [
            {
                edits: [
                    {
                        annotation_refs: refs("AAA"),
                        changes: { set_tags: ["a"] },
                    },
                ],
            },
            "field_restricted",
        ],
        [
            {
                edits: [
                    {
                        annotation_refs: refs("AAA", "BBB"),
                        relocation: relocation(),
                    },
                ],
            },
            "invalid_relocation",
        ],
        [
            {
                edits: [
                    { annotation_refs: refs("AAA"), changes: { color: "red" } },
                    {
                        annotation_refs: refs("AAA"),
                        changes: { color: "blue" },
                    },
                ],
            },
            "duplicate_annotation",
        ],
        [
            {
                operation: "edit",
                annotation_refs: refs("AAA"),
                edits: [
                    { annotation_refs: refs("AAA"), changes: { color: "red" } },
                ],
            },
            "field_restricted",
        ],
    ])("rejects an invalid or unsafe payload", async (actionData, code) => {
        const response = await validate(actionData as any);
        expect(response.valid).toBe(false);
        expect(response.error_code).toBe(code);
    });

    it("skips an unresolvable target and keeps the rest", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA", "MISSING"),
                    changes: { color: "red" },
                },
            ],
        });

        expect(response.valid).toBe(true);
        const data = response.normalized_action_data as any;
        expect(data.edits[0].annotation_refs).toEqual([ref("AAA")]);
        expect(data.skipped).toEqual([
            { annotation_id: "1-MISSING", reason: "annotation was not found" },
        ]);
    });

    it("preserves skips already recorded by backend locator validation", async () => {
        const response = await validate({
            skipped: [
                { annotation_id: "1-OLDMISS", reason: "locator was not found" },
            ],
            edits: [
                {
                    annotation_refs: refs("AAA", "MISSING"),
                    changes: { color: "red" },
                },
            ],
        });

        expect(response.valid).toBe(true);
        expect((response.normalized_action_data as any).skipped).toEqual([
            { annotation_id: "1-OLDMISS", reason: "locator was not found" },
            { annotation_id: "1-MISSING", reason: "annotation was not found" },
        ]);
    });

    it("bounds aggregate relocation preparation", async () => {
        prepareRelocation.mockImplementationOnce(
            () => new Promise(() => undefined),
        );

        const response = await validateEditAnnotationsAction(
            {
                event: "agent_action_validate",
                request_id: "deadline-test",
                action_type: "edit_annotations",
                action_data: {
                    operation: "edit",
                    edits: [
                        {
                            annotation_refs: refs("AAA"),
                            relocation: relocation(),
                        },
                    ],
                },
            } as any,
            5,
        );

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe("relocation_validation_failed");
        expect(response.error).toContain("timed out");
    });

    it("drops only the group whose locator fails", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    relocation: relocation("s999"),
                },
                { annotation_refs: refs("BBB"), changes: { color: "red" } },
            ],
        });

        expect(response.valid).toBe(true);
        const data = response.normalized_action_data as any;
        expect(data.edits).toHaveLength(1);
        expect(data.edits[0].annotation_refs).toEqual([ref("BBB")]);
        expect(data.skipped[0].annotation_id).toBe("1-AAA");
        expect(data.skipped[0].reason).toContain("s999");
    });

    it("rejects a destination resolved against another attachment", async () => {
        // An annotation cannot move between documents, and the coordinates
        // would come from the wrong page frame.
        prepareRelocation.mockImplementationOnce(async () => {
            throw new Error("is not on attachment u-OTHER123");
        });

        const response = await validate({
            edits: [{ annotation_refs: refs("AAA"), relocation: relocation() }],
        });

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe("relocation_validation_failed");
        expect(response.error).toContain("u-OTHER123");
    });

    it("fails only when nothing survives", async () => {
        const response = await validate({
            edits: [
                { annotation_refs: refs("MISSING"), changes: { color: "red" } },
            ],
        });

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe("annotation_validation_failed");
        expect(response.error).toContain("1-MISSING");
    });

    it("reports a relocation failure with its own error code", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    relocation: relocation("s999"),
                },
            ],
        });

        expect(response.valid).toBe(false);
        expect(response.error_code).toBe("relocation_validation_failed");
    });
});

describe("edit_annotations approval policy", () => {
    it("honors the user preference for non-destructive edits", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { color: "red", add_tags: ["topic"] },
                },
            ],
        });

        expect(response.preference).toBe("always_apply");
    });

    it("honors the user preference when a removal leaves tags standing", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { remove_tags: ["not-on-this-annotation"] },
                },
            ],
        });

        expect(response.preference).toBe("always_apply");
    });

    it.each([
        ["a move", { relocation: relocation() }],
        ["overwriting an existing comment", { changes: { comment: "new" } }],
        [
            "replacing an existing tag set",
            { changes: { remove_tags: ["old-AAA"], add_tags: ["only"] } },
        ],
    ])("always asks before %s", async (_label, group) => {
        const response = await validate({
            edits: [{ annotation_refs: refs("AAA"), ...group }],
        });

        expect(response.preference).toBe("always_ask");
    });

    it("still asks when a destructive group follows a dropped one", async () => {
        // `groupIndex` is assigned against the ORIGINAL edits array; the
        // surviving list is compacted. Evaluating the guard against the
        // compacted list shifts group 1 into slot 0 and silently finds no
        // members, waving a comment overwrite straight through.
        const response = await validate({
            edits: [
                { annotation_refs: refs("MISSING"), changes: { color: "red" } },
                { annotation_refs: refs("AAA"), changes: { comment: "new" } },
            ],
        });

        expect(response.valid).toBe(true);
        expect(response.preference).toBe("always_ask");
    });

    it("does not ask for a destructive group whose targets all vanished", async () => {
        const response = await validate({
            edits: [
                {
                    annotation_refs: refs("MISSING"),
                    changes: { comment: "new" },
                },
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
            ],
        });

        expect(response.valid).toBe(true);
        expect(response.preference).toBe("always_apply");
    });

    it("respects continue_without_applying even for a delete", async () => {
        // That mode never applies anything on its own, so overriding it with a
        // card interrupts a user who asked not to be interrupted.
        deferredPreference = "continue_without_applying";

        const response = await validate({
            operation: "delete",
            annotation_refs: refs("AAA"),
        });

        expect(response.preference).toBe("continue_without_applying");
    });

    it("always asks before a delete", async () => {
        const response = await validate({
            operation: "delete",
            annotation_refs: refs("AAA"),
        });

        expect(response.preference).toBe("always_ask");
    });

    it("reads a delete's preference from the deletion group", async () => {
        // Both tools share one action type, so the operation has to pick the
        // group. Reading edit_annotations here would let an "always apply
        // annotation edits" preference carry deletions with it.
        preferenceLookups.length = 0;
        await validate({ operation: "delete", annotation_refs: refs("AAA") });
        expect(preferenceLookups[0]).toBe("delete_annotations");
        expect(preferenceLookups).not.toContain("edit_annotations");

        preferenceLookups.length = 0;
        await validate({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
            ],
        });
        expect(preferenceLookups).toEqual(["edit_annotations"]);
    });

    it("lets a per-run deletion grant apply without a card", async () => {
        // The deletion group has no persisted preference, so always_apply can
        // only come from a grant the user gave for deletions in this run.
        deletionGrantedForRun = true;

        const response = await validate({
            operation: "delete",
            annotation_refs: refs("AAA"),
        });

        expect(response.preference).toBe("always_apply");
    });
});

describe("edit_annotations execution", () => {
    it("applies each group's own payload", async () => {
        const response = await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
                { annotation_refs: refs("BBB"), changes: { comment: "" } },
            ],
        });

        expect(response.success).toBe(true);
        expect(response.result_data?.operation).toBe("edit");
        expect(response.result_data?.applied_refs).toHaveLength(2);
        expect(items.get("AAA").annotationColor).toBe("#ff6666");
        expect(items.get("AAA").annotationComment).toBe("comment-AAA");
        expect(items.get("BBB").annotationComment).toBe("");
        expect(items.get("BBB").annotationColor).toBe("#ffd400");
    });

    it("reports targets dropped when execution re-resolves the batch", async () => {
        // The approval card listed both, but one is gone by the time the user
        // approves. The result has to say so: only applied_refs shrinks
        // otherwise, and the proposal still names the full set.
        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA", "GONE"),
                    changes: { color: "red" },
                },
            ],
            skipped: [{ annotation_id: "1-EARLIER", reason: "was not found" }],
        });

        expect(response.success).toBe(true);
        expect(response.result_data?.applied_refs).toEqual([ref("AAA")]);
        // Validation-time skips travel alongside the new one, so the card shows
        // every target the change never reached.
        expect(response.result_data?.skipped).toEqual([
            { annotation_id: "1-EARLIER", reason: "was not found" },
            { annotation_id: "1-GONE", reason: expect.any(String) },
        ]);
    });

    it("omits the skip list when every target was applied", async () => {
        const response = await execute({
            edits: [{ annotation_refs: refs("AAA"), changes: { color: "red" } }],
        });

        expect(response.result_data).not.toHaveProperty("skipped");
    });

    it("adds and removes tags without discarding the rest", async () => {
        await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { add_tags: ["new-tag"], remove_tags: ["absent"] },
                },
            ],
        });

        expect(items.get("AAA").getTags()).toEqual([
            { tag: "old-AAA" },
            { tag: "new-tag" },
        ]);
    });

    it("replaces a tag set through remove_tags plus add_tags", async () => {
        await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { remove_tags: ["old-AAA"], add_tags: ["only"] },
                },
            ],
        });

        expect(items.get("AAA").getTags()).toEqual([{ tag: "only" }]);
    });

    it("refuses an edit that turned destructive since it was proposed", async () => {
        // Validation saw no comment, so the edit could be auto-applied without
        // a card; the user has written one since. Overwriting it now would
        // skip the approval the guard promises.
        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { comment: "model comment" },
                },
            ],
            annotation_previews: [preview("AAA", { comment: "" })],
        });

        expect(response.success).toBe(false);
        expect(response.error_code).toBe("annotation_state_changed");
        expect(items.get("AAA").annotationComment).toBe("comment-AAA");
        expect(items.get("AAA").save).not.toHaveBeenCalled();
    });

    it("refuses when one target in an approved group turns destructive", async () => {
        // AAA already had a comment at validation, so the group was approved
        // on its account. BBB had none and has gained one since — content the
        // user wrote that nobody has approved overwriting, and that a
        // group-level check would let AAA's approval absorb.
        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA", "BBB"),
                    changes: { comment: "model comment" },
                },
            ],
            annotation_previews: [
                preview("AAA"),
                preview("BBB", { comment: "" }),
            ],
        });

        expect(response.success).toBe(false);
        expect(response.error_code).toBe("annotation_state_changed");
        expect(items.get("AAA").annotationComment).toBe("comment-AAA");
        expect(items.get("BBB").annotationComment).toBe("comment-BBB");
    });

    it("refuses an edit that turned destructive while the batch was prepared", async () => {
        // The snapshot is taken as each annotation resolves, and preparing the
        // moves that follow can take seconds. A comment written in THAT window
        // is invisible to a guard reading the resolve-time snapshot.
        const drifting = items.get("AAA");
        drifting.annotationComment = "";
        prepareRelocation.mockImplementationOnce(async () => {
            drifting.annotationComment = "user comment";
            return MOVED_PLACEMENT;
        });

        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { comment: "model comment" },
                },
                { annotation_refs: refs("BBB"), relocation: relocation() },
            ],
            annotation_previews: [
                preview("AAA", { comment: "" }),
                preview("BBB"),
            ],
        });

        expect(response.success).toBe(false);
        expect(response.error_code).toBe("annotation_state_changed");
        expect(drifting.annotationComment).toBe("user comment");
        // The whole batch is rolled back, including the move in the other
        // group that was not the one that drifted.
        expect(items.get("BBB").annotationPosition).toBe("position-BBB");
    });

    it("snapshots the state the write actually overwrites", async () => {
        // Undo restores from these snapshots, so they have to describe the
        // annotation as the write found it, not as resolution first saw it.
        const drifting = items.get("AAA");
        prepareRelocation.mockImplementationOnce(async () => {
            drifting.annotationComment = "written while preparing";
            drifting.setTags([{ tag: "auto", type: 1 }]);
            return MOVED_PLACEMENT;
        });

        const response = await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
                { annotation_refs: refs("BBB"), relocation: relocation() },
            ],
        });

        expect(response.success).toBe(true);
        expect(response.result_data?.before[0]).toMatchObject({
            annotation_id: "u-AAA",
            comment: "written while preparing",
            tags: ["auto"],
            automatic_tags: ["auto"],
        });
    });

    it("applies an edit that was already destructive when proposed", async () => {
        // The comment was there at validation, so the card was raised and the
        // user approved it. Re-running the guard must not refuse that.
        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { comment: "model comment" },
                },
            ],
            annotation_previews: [preview("AAA")],
        });

        expect(response.success).toBe(true);
        expect(items.get("AAA").annotationComment).toBe("model comment");
    });

    it("refuses when the tags that would have survived are gone", async () => {
        // Validation saw two tags, so removing one left the other standing.
        // Only one is left now, and removing it wipes the annotation's tags.
        items.get("AAA").setTags([{ tag: "old-AAA" }]);

        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { remove_tags: ["old-AAA"] },
                },
            ],
            annotation_previews: [
                preview("AAA", { tags: ["old-AAA", "keeper"] }),
            ],
        });

        expect(response.success).toBe(false);
        expect(response.error_code).toBe("annotation_state_changed");
        expect(items.get("AAA").getTags()).toEqual([{ tag: "old-AAA" }]);
    });

    it("keeps a retained tag automatic while other tags change", async () => {
        // setTags() files a tag passed as a bare name as manual, so a patch
        // that names other tags must carry the retained ones back with their
        // types or it silently rewrites the annotation's tag metadata.
        items
            .get("AAA")
            .setTags([{ tag: "auto", type: 1 }, { tag: "old-AAA" }]);

        await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: {
                        add_tags: ["new-tag"],
                        remove_tags: ["old-AAA"],
                    },
                },
            ],
        });

        expect(items.get("AAA").getTags()).toEqual([
            { tag: "auto", type: 1 },
            { tag: "new-tag" },
        ]);
    });

    it("restores tag types when a save fails", async () => {
        items.get("AAA").setTags([{ tag: "auto", type: 1 }]);
        items.set(
            "BBB",
            annotation(
                "BBB",
                vi.fn(async () => {
                    throw new Error("save failed");
                }),
            ),
        );

        await execute({
            edits: [
                {
                    annotation_refs: refs("AAA", "BBB"),
                    changes: { add_tags: ["new-tag"] },
                },
            ],
        });

        expect(items.get("AAA").getTags()).toEqual([{ tag: "auto", type: 1 }]);
    });

    it("restores every in-memory annotation when one save fails", async () => {
        items.set(
            "BBB",
            annotation(
                "BBB",
                vi.fn(async () => {
                    throw new Error("save failed");
                }),
            ),
        );
        const response = await execute({
            edits: [
                {
                    annotation_refs: refs("AAA", "BBB"),
                    changes: {
                        color: "green",
                        comment: "new",
                        add_tags: ["new-tag"],
                    },
                },
            ],
        });

        expect(response.success).toBe(false);
        expect(response.error_code).toBe("transaction_failed");
        for (const key of ["AAA", "BBB"]) {
            expect(items.get(key).annotationColor).toBe("#ffd400");
            expect(items.get(key).annotationComment).toBe(`comment-${key}`);
            expect(items.get(key).getTags()).toEqual([{ tag: `old-${key}` }]);
        }
    });

    it("soft-deletes every target atomically for a delete", async () => {
        const response = await execute({
            operation: "delete",
            annotation_refs: refs("AAA", "BBB"),
        });

        expect(response.success).toBe(true);
        expect(response.result_data?.operation).toBe("delete");
        expect(items.get("AAA").deleted).toBe(true);
        expect(items.get("BBB").deleted).toBe(true);
    });

    it("moves an annotation in place, keeping its identity", async () => {
        const response = await execute({
            edits: [{ annotation_refs: refs("AAA"), relocation: relocation() }],
        });
        const moved = items.get("AAA");

        expect(response.success).toBe(true);
        // The annotation is rewritten, never replaced: it keeps its key (so
        // citations pointing at it still resolve) and stays out of the trash.
        expect(moved.deleted).toBe(false);
        expect(moved.annotationPosition).toBe(MOVED_PLACEMENT.position);
        expect(moved.annotationSortIndex).toBe(MOVED_PLACEMENT.sortIndex);
        expect(moved.annotationText).toBe(MOVED_PLACEMENT.text);
        expect(moved.annotationPageLabel).toBe(MOVED_PLACEMENT.pageLabel);
        expect(response.result_data?.applied_refs).toEqual([ref("AAA")]);
        expect(refreshMovedAnnotationsInOpenReaders).toHaveBeenCalledWith([
            { attachmentID: 100, item: moved },
        ]);
    });

    it("reports a deadline that fired while preparing a move as a timeout", async () => {
        // Preparation turns the abort into a skip, so without a check of its
        // own the empty partition would surface as a resolution failure and the
        // caller would lose its timeout diagnostics.
        await expect(
            execute(
                { edits: [{ annotation_refs: refs("AAA"), relocation: relocation() }] },
                abortedSignal(),
            ),
        ).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("records both ends of a move so it can be undone", async () => {
        const response = await execute({
            edits: [{ annotation_refs: refs("AAA"), relocation: relocation() }],
        });

        // A move overwrites position in place, so the result is the only
        // record of where the annotation came from.
        expect(response.result_data?.before[0]).toMatchObject({
            annotation_type: "highlight",
            text: "text-AAA",
            page_label: "page-AAA",
            sort_index: "sort-AAA",
            position: "position-AAA",
            moved_to: {
                text: MOVED_PLACEMENT.text,
                page_label: MOVED_PLACEMENT.pageLabel,
                sort_index: MOVED_PLACEMENT.sortIndex,
                position: MOVED_PLACEMENT.position,
            },
        });
    });

    it("leaves placement out of the snapshot when nothing moved", async () => {
        const response = await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
            ],
        });

        const snapshot = response.result_data?.before[0] as any;
        expect(snapshot.position).toBeUndefined();
        expect(snapshot.moved_to).toBeUndefined();
    });

    it("applies a patch and a move to the same annotation", async () => {
        await execute({
            edits: [
                {
                    annotation_refs: refs("AAA"),
                    changes: { color: "green", add_tags: ["moved"] },
                    relocation: relocation(),
                },
            ],
        });
        const moved = items.get("AAA");

        expect(moved.annotationColor).toBe("#5fb236");
        expect(moved.getTags().map((tag: any) => tag.tag)).toEqual([
            "old-AAA",
            "moved",
        ]);
        expect(moved.annotationPosition).toBe(MOVED_PLACEMENT.position);
    });

    it("never calls saveTx() inside the transaction", async () => {
        // saveTx() opens its own transaction; nested inside an open one Zotero
        // waits on a promise that cannot settle and throws after 30s. Every
        // write in the batch must join the caller's transaction via save().
        const response = await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
                { annotation_refs: refs("BBB"), relocation: relocation() },
            ],
        });

        expect(response.success).toBe(true);
        expect(items.get("AAA").saveTx).not.toHaveBeenCalled();
        expect(items.get("BBB").saveTx).not.toHaveBeenCalled();
        expect(items.get("AAA").save).toHaveBeenCalled();
    });

    it("prepares every move before opening the transaction", async () => {
        // Preparing a move can read the attachment and run a PDF page
        // analysis. Doing that inside the transaction would hold Zotero's
        // global write lock for the duration and stall every other write.
        prepareRelocation.mockImplementationOnce(async () => {
            expect((globalThis as any).Zotero.DB.inTransaction()).toBe(false);
            return MOVED_PLACEMENT;
        });

        const response = await execute({
            edits: [{ annotation_refs: refs("AAA"), relocation: relocation() }],
        });

        expect(response.success).toBe(true);
        expect(prepareRelocation).toHaveBeenCalled();
    });

    it("mixes a move and an in-place edit in one transaction", async () => {
        const response = await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
                { annotation_refs: refs("BBB"), relocation: relocation() },
            ],
        });

        expect(response.success).toBe(true);
        expect(response.result_data?.applied_refs).toEqual([
            ref("AAA"),
            ref("BBB"),
        ]);
        expect(response.result_data?.before).toHaveLength(2);
        expect(items.get("AAA").deleted).toBe(false);
        expect(items.get("BBB").deleted).toBe(false);
        expect(items.get("BBB").annotationPosition).toBe(
            MOVED_PLACEMENT.position,
        );
    });

    it("clears trashed annotations from an open reader", async () => {
        // Zotero's reader ignores annotation trash events, so a deleted
        // annotation stays rendered until the tab is reopened.
        await execute({ operation: "delete", annotation_refs: refs("AAA") });

        expect(unsetTrashedAnnotationsInOpenReaders).toHaveBeenCalledWith([
            { attachmentID: 100, key: "AAA" },
        ]);
    });

    it("does not touch the reader for a metadata-only edit", async () => {
        await execute({
            edits: [
                { annotation_refs: refs("AAA"), changes: { color: "red" } },
            ],
        });

        expect(unsetTrashedAnnotationsInOpenReaders).not.toHaveBeenCalled();
        expect(refreshMovedAnnotationsInOpenReaders).toHaveBeenCalledWith([]);
    });
});
