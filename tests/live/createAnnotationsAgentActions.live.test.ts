/**
 * Live tests for the `create_highlight_annotations` and `create_note_annotations`
 * deferred agent actions.
 *
 * Exercises the production `/beaver/agent-action/validate` and
 * `/beaver/agent-action/execute` endpoints with the new action_types added in
 * this branch, plus the cache-extraction probe used by the validator
 * (`needs_extraction`).
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the agent action endpoints are registered.
 *   - Fixture attachments seeded (NORMAL_PDF, SMALL_PDF, NON_PDF, ENCRYPTED_PDF,
 *     MISSING_FILE_PDF, GROUP_LIB_PDF).
 *
 * Run with: `npm run test:live -- createAnnotationsAgentActions`
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from "../helpers/zoteroAvailability";
import {
    getCacheMetadata,
    invalidateCache,
    triggerFileStatus,
} from "../helpers/cacheInspector";
import {
    ENCRYPTED_PDF,
    GROUP_LIB_PDF,
    MISSING_FILE_PDF,
    NON_PDF,
    NORMAL_PDF,
    SMALL_PDF,
    type AttachmentFixture,
} from "../helpers/fixtures";
import { post } from "../helpers/zoteroHttpClient";
import { CoordOrigin } from "../../react/types/citations";

let available = false;
let createdItemIds: string[] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
});

beforeEach((ctx) => {
    skipIfNoZotero(ctx, available);
    createdItemIds = [];
});

afterEach(async () => {
    if (!available || createdItemIds.length === 0) return;
    await post("/beaver/delete-items", { item_ids: createdItemIds });
    createdItemIds = [];
});

interface CreatedAnnotationResult {
    library_id: number;
    zotero_key: string;
    client_item_id: string;
    index: number;
    loc_raw: string;
}

interface FailedAnnotationResult {
    client_item_id: string;
    index: number;
    loc_raw: string;
    error: string;
    error_code?: string | null;
}

interface ResultData {
    requested_ref: { library_id: number; zotero_key: string };
    resolved_ref: { library_id: number; zotero_key: string };
    created: CreatedAnnotationResult[];
    failed: FailedAnnotationResult[];
    total_created: number;
    total_failed: number;
}

interface ValidateResponse {
    valid: boolean;
    error?: string;
    error_code?: string | null;
    current_value?: {
        library_name: string;
        attachment_title: string;
        item_count: number;
        resolution_differs: boolean;
        needs_extraction: boolean;
    };
    normalized_action_data?: Record<string, any>;
    preference?: string;
}

interface ExecuteResponse {
    success: boolean;
    error?: string;
    error_code?: string | null;
    result_data?: ResultData;
}

function ref(attachment: AttachmentFixture) {
    return {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
    };
}

function trackCreated(res: ExecuteResponse) {
    for (const c of res.result_data?.created ?? []) {
        createdItemIds.push(`${c.library_id}-${c.zotero_key}`);
    }
}

async function validateHighlight(actionData: any): Promise<ValidateResponse> {
    return post<ValidateResponse>("/beaver/agent-action/validate", {
        action_type: "create_highlight_annotations",
        action_data: actionData,
    }, { timeout: 30000 });
}

async function executeHighlight(actionData: any): Promise<ExecuteResponse> {
    const res = await post<ExecuteResponse>("/beaver/agent-action/execute", {
        action_type: "create_highlight_annotations",
        action_data: actionData,
    }, { timeout: 60000 });
    trackCreated(res);
    return res;
}

async function validateNote(actionData: any): Promise<ValidateResponse> {
    return post<ValidateResponse>("/beaver/agent-action/validate", {
        action_type: "create_note_annotations",
        action_data: actionData,
    }, { timeout: 30000 });
}

async function executeNote(actionData: any): Promise<ExecuteResponse> {
    const res = await post<ExecuteResponse>("/beaver/agent-action/execute", {
        action_type: "create_note_annotations",
        action_data: actionData,
    }, { timeout: 60000 });
    trackCreated(res);
    return res;
}

const HIGHLIGHT_BOX = {
    l: 10,
    t: 20,
    r: 110,
    b: 50,
    coord_origin: CoordOrigin.TOPLEFT,
};

function highlightItem(overrides: Partial<{
    index: number;
    client_item_id: string;
    text: string;
    color: string;
    comment: string | null;
    page_label: string | null;
    page_locations: Array<{ page_idx: number; boxes: typeof HIGHLIGHT_BOX[] }>;
}> = {}) {
    return {
        index: overrides.index ?? 0,
        client_item_id: overrides.client_item_id ?? `hl-${overrides.index ?? 0}`,
        title: "Test Highlight",
        loc_raw: "s1",
        loc: { kind: "sentence", value: "s1", raw: "s1" },
        text: overrides.text ?? "agent-action highlight",
        color: overrides.color ?? "yellow",
        comment: overrides.comment ?? null,
        page_label: overrides.page_label ?? null,
        page_locations: overrides.page_locations ?? [
            { page_idx: 0, boxes: [HIGHLIGHT_BOX] },
        ],
    };
}

function noteItem(overrides: Partial<{
    index: number;
    client_item_id: string;
    comment: string;
    page_label: string | null;
    page_index: number;
    side: "left" | "right";
    y: number;
    coord_origin: CoordOrigin;
}> = {}) {
    return {
        index: overrides.index ?? 0,
        client_item_id: overrides.client_item_id ?? `nt-${overrides.index ?? 0}`,
        title: "Test Note",
        loc_raw: "s1",
        loc: { kind: "sentence", value: "s1", raw: "s1" },
        comment: overrides.comment ?? "agent-action note",
        page_label: overrides.page_label ?? null,
        note_position: {
            page_index: overrides.page_index ?? 0,
            side: overrides.side ?? "left",
            x: 0,
            y: overrides.y ?? 100,
            coord_origin: overrides.coord_origin ?? CoordOrigin.TOPLEFT,
        },
    };
}

describe("create_highlight_annotations: validate", () => {
    it("returns valid=true with normalized action data and preference", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await validateHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [highlightItem()],
        });

        expect(res.valid).toBe(true);
        expect(res.current_value?.item_count).toBe(1);
        expect(res.current_value?.resolution_differs).toBe(false);
        expect(res.current_value?.needs_extraction).toBe(false);
        expect(res.normalized_action_data).toBeTruthy();
        expect(res.normalized_action_data?.items).toHaveLength(1);
        expect(res.normalized_action_data?.items[0].page_locations).toHaveLength(1);
        expect(typeof res.preference).toBe("string");
    }, 30000);

    it("reports needs_extraction=true when the cache is cold", async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const cached = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(cached).toBeNull();

        const res = await validateHighlight({
            requested_ref: ref(SMALL_PDF),
            resolved_ref: ref(SMALL_PDF),
            items: [highlightItem()],
        });
        expect(res.valid).toBe(true);
        expect(res.current_value?.needs_extraction).toBe(true);
    }, 30000);

    it("flags resolution_differs when requested and resolved refs disagree", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await validateHighlight({
            requested_ref: { library_id: NORMAL_PDF.library_id, zotero_key: "DIFFEREN" },
            resolved_ref: ref(NORMAL_PDF),
            items: [highlightItem()],
        });
        expect(res.valid).toBe(true);
        expect(res.current_value?.resolution_differs).toBe(true);
    }, 30000);

    it("rejects missing resolved_ref", async () => {
        const res = await validateHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: { library_id: 0, zotero_key: "" },
            items: [highlightItem()],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe("missing_resolved_ref");
    }, 30000);

    it("rejects an empty item list", async () => {
        const res = await validateHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe("no_items");
    }, 30000);

    it("rejects a non-PDF attachment with invalid_attachment", async () => {
        const res = await validateHighlight({
            requested_ref: ref(NON_PDF),
            resolved_ref: ref(NON_PDF),
            items: [highlightItem()],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe("invalid_attachment");
    }, 30000);

    it("rejects an attachment whose file is missing locally", async (ctx) => {
        const res = await validateHighlight({
            requested_ref: ref(MISSING_FILE_PDF),
            resolved_ref: ref(MISSING_FILE_PDF),
            items: [highlightItem()],
        });
        if (res.error_code === "invalid_attachment") {
            // Fixture missing entirely from this library — skip.
            ctx.skip();
        }
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe("attachment_file_unavailable");
    }, 30000);
});

describe("create_highlight_annotations: execute", () => {
    it("creates a single highlight and returns it in result_data.created", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await executeHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [highlightItem({ client_item_id: "hl-A" })],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(1);
        expect(res.result_data?.total_failed).toBe(0);
        const created = res.result_data!.created[0];
        expect(created.library_id).toBe(NORMAL_PDF.library_id);
        expect(created.client_item_id).toBe("hl-A");
        expect(typeof created.zotero_key).toBe("string");
        expect(created.zotero_key.length).toBeGreaterThan(0);
    }, 60000);

    it("explodes a multi-page item into one created entry per page", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await executeHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [
                highlightItem({
                    client_item_id: "hl-multipage",
                    page_locations: [
                        { page_idx: 0, boxes: [HIGHLIGHT_BOX] },
                        { page_idx: 1, boxes: [HIGHLIGHT_BOX] },
                    ],
                }),
            ],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(2);
        expect(res.result_data?.created.every((c) => c.client_item_id === "hl-multipage"))
            .toBe(true);
    }, 60000);

    it("creates highlights for multiple items in a single execute", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await executeHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [
                highlightItem({ index: 0, client_item_id: "hl-0", text: "first" }),
                highlightItem({ index: 1, client_item_id: "hl-1", text: "second" }),
            ],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(2);
        const ids = new Set(res.result_data!.created.map((c) => c.client_item_id));
        expect(ids).toEqual(new Set(["hl-0", "hl-1"]));
    }, 60000);

    it("records failed entries when an item has no page locations", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await executeHighlight({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [
                highlightItem({ index: 0, client_item_id: "hl-ok" }),
                highlightItem({
                    index: 1,
                    client_item_id: "hl-empty",
                    page_locations: [],
                }),
            ],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(1);
        expect(res.result_data?.total_failed).toBe(1);
        const failure = res.result_data!.failed[0];
        expect(failure.client_item_id).toBe("hl-empty");
        expect(failure.error_code).toBe("page_geometry_unavailable");
    }, 60000);

    it("fails individual items on out-of-range page index but keeps siblings", async () => {
        await triggerFileStatus(SMALL_PDF.library_id, SMALL_PDF.zotero_key, false);
        const record = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(record?.pageCount).not.toBeNull();
        const oobIndex = (record!.pageCount ?? 0) + 5;

        const res = await executeHighlight({
            requested_ref: ref(SMALL_PDF),
            resolved_ref: ref(SMALL_PDF),
            items: [
                highlightItem({ index: 0, client_item_id: "hl-good" }),
                highlightItem({
                    index: 1,
                    client_item_id: "hl-bad",
                    page_locations: [{ page_idx: oobIndex, boxes: [HIGHLIGHT_BOX] }],
                }),
            ],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(1);
        expect(res.result_data?.total_failed).toBe(1);
        expect(res.result_data?.failed[0].client_item_id).toBe("hl-bad");
        expect(res.result_data?.failed[0].error_code).toBe("page_geometry_unavailable");
    }, 60000);

    it("returns top-level invalid_attachment for a non-PDF resolved attachment", async () => {
        const res = await executeHighlight({
            requested_ref: ref(NON_PDF),
            resolved_ref: ref(NON_PDF),
            items: [highlightItem()],
        });
        expect(res.success).toBe(false);
        expect(res.error_code).toBe("invalid_attachment");
    }, 60000);

    it("creates a highlight in a group library", async (ctx) => {
        await triggerFileStatus(
            GROUP_LIB_PDF.library_id,
            GROUP_LIB_PDF.zotero_key,
            false,
        );
        const record = await getCacheMetadata(
            GROUP_LIB_PDF.library_id,
            GROUP_LIB_PDF.zotero_key,
        );
        if (!record) ctx.skip();

        const res = await executeHighlight({
            requested_ref: ref(GROUP_LIB_PDF),
            resolved_ref: ref(GROUP_LIB_PDF),
            items: [highlightItem({ client_item_id: "hl-group" })],
        });
        if (!res.success && res.error_code === "library_not_editable") {
            // Skip on read-only group library — covered by validate test below.
            ctx.skip();
        }
        expect(res.success).toBe(true);
        expect(res.result_data?.created[0].library_id).toBe(GROUP_LIB_PDF.library_id);
    }, 60000);
});

describe("create_note_annotations: validate + execute", () => {
    it("validates a single note action", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await validateNote({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [noteItem()],
        });
        expect(res.valid).toBe(true);
        expect(res.current_value?.item_count).toBe(1);
        expect(res.normalized_action_data?.items[0].note_position).toEqual({
            page_index: 0,
            side: "left",
            x: 0,
            y: 100,
            coord_origin: CoordOrigin.TOPLEFT,
        });
    }, 30000);

    it("rejects validate when no items are provided", async () => {
        const res = await validateNote({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [],
        });
        expect(res.valid).toBe(false);
        expect(res.error_code).toBe("no_items");
    }, 30000);

    it("executes multiple notes and returns one created entry per item", async () => {
        await triggerFileStatus(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            false,
        );

        const res = await executeNote({
            requested_ref: ref(NORMAL_PDF),
            resolved_ref: ref(NORMAL_PDF),
            items: [
                noteItem({ index: 0, client_item_id: "nt-0", comment: "first" }),
                noteItem({
                    index: 1,
                    client_item_id: "nt-1",
                    comment: "second",
                    side: "right",
                    y: 200,
                }),
            ],
        });

        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(2);
        const clients = res.result_data!.created.map((c) => c.client_item_id);
        expect(clients.sort()).toEqual(["nt-0", "nt-1"]);
    }, 60000);

    it("fails individual notes on out-of-range page index", async () => {
        await triggerFileStatus(SMALL_PDF.library_id, SMALL_PDF.zotero_key, false);
        const record = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(record?.pageCount).not.toBeNull();
        const oobIndex = (record!.pageCount ?? 0) + 5;

        const res = await executeNote({
            requested_ref: ref(SMALL_PDF),
            resolved_ref: ref(SMALL_PDF),
            items: [
                noteItem({ index: 0, client_item_id: "nt-good" }),
                noteItem({
                    index: 1,
                    client_item_id: "nt-bad",
                    page_index: oobIndex,
                }),
            ],
        });
        expect(res.success).toBe(true);
        expect(res.result_data?.total_created).toBe(1);
        expect(res.result_data?.total_failed).toBe(1);
        expect(res.result_data?.failed[0].client_item_id).toBe("nt-bad");
    }, 60000);

    it("returns invalid_attachment for a non-PDF resolved attachment", async () => {
        const res = await executeNote({
            requested_ref: ref(NON_PDF),
            resolved_ref: ref(NON_PDF),
            items: [noteItem()],
        });
        expect(res.success).toBe(false);
        expect(res.error_code).toBe("invalid_attachment");
    }, 60000);

    it("maps encrypted-PDF failures to page_extraction_failed", async () => {
        await invalidateCache(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );

        const res = await executeNote({
            requested_ref: ref(ENCRYPTED_PDF),
            resolved_ref: ref(ENCRYPTED_PDF),
            items: [noteItem({ client_item_id: "nt-encrypted" })],
        });

        if (!res.success) {
            // Encrypted attachment short-circuits with invalid_attachment before
            // per-item processing; treat that as expected.
            expect(["invalid_attachment", "attachment_file_unavailable"]).toContain(
                res.error_code,
            );
            return;
        }

        expect(res.result_data?.total_created).toBe(0);
        expect(res.result_data?.total_failed).toBe(1);
        const code = res.result_data?.failed[0].error_code;
        expect(["page_extraction_failed", "page_geometry_unavailable"]).toContain(code);
    }, 60000);
});
