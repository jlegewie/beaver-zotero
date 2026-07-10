import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../react/store", () => ({
  // Personal library (1) + a local group library (100) are searchable.
  store: { get: vi.fn(() => [1, 100]) },
}));

vi.mock("../../../react/atoms/profile", () => ({
  searchableLibraryIdsAtom: Symbol("searchableLibraryIdsAtom"),
}));

vi.mock("../../../src/services/agentDataProvider/utils", () => ({
  getDeferredToolPreference: vi.fn(() => "always_ask"),
}));

import { validateOrganizeItemsAction } from "../../../src/services/agentDataProvider/actions/organizeItems";
import type { WSAgentActionValidateRequest } from "../../../src/services/agentProtocol";

type ItemKind = "annotation" | "regular";

// Item echoes the (libraryID, key) it was resolved with so the handler can
// derive the portable id from item.libraryID / item.key.
function makeItem(kind: ItemKind, libraryID: number, key: string) {
  return {
    libraryID,
    key,
    isAnnotation: () => kind === "annotation",
    isRegularItem: () => kind === "regular",
    isAttachment: () => false,
    isNote: () => false,
    isTopLevelItem: () => kind === "regular",
    itemTypeID: 1,
    parentKey: kind === "annotation" ? "PARENTKEY" : undefined,
    getTags: () => [{ tag: "existing" }],
    getCollections: () => [],
  };
}

function buildRequest(actionData: Record<string, any>): WSAgentActionValidateRequest {
  return {
    type: "agent_action_validate_request",
    request_id: "req-1",
    action_type: "organize_items",
    action_data: actionData,
  } as unknown as WSAgentActionValidateRequest;
}

describe("validateOrganizeItemsAction", () => {
  let previousZotero: any;
  let itemKind: ItemKind;

  beforeEach(() => {
    vi.clearAllMocks();
    itemKind = "regular";
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Libraries: {
        get: vi.fn(() => ({ name: "My Library", editable: true })),
        userLibraryID: 1,
      },
      // Group library 100 <-> server group id 12345. Any other id is unknown.
      Groups: {
        getGroupIDFromLibraryID: vi.fn((libId: number) => (libId === 100 ? 12345 : false)),
        getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
      },
      Items: {
        getByLibraryAndKeyAsync: vi.fn(async (libId: number, key: string) => makeItem(itemKind, libId, key)),
      },
      ItemTypes: { getName: vi.fn(() => "annotation") },
      Collections: { getByLibraryAndKeyAsync: vi.fn() },
    };
  });

  afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
  });

  it("allows tag changes on an annotation and keys state by the portable id", async () => {
    itemKind = "annotation";
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ANNOTKEY"],
        tags: { add: ["methods"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.current_value).toEqual({
      "u-ANNOTKEY": { tags: ["existing"], collections: [] },
    });
    expect(res.normalized_action_data).toEqual({ item_ids: ["u-ANNOTKEY"] });
  });

  it("rejects collection changes on an annotation", async () => {
    itemKind = "annotation";
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ANNOTKEY"],
        tags: null,
        collections: { add: ["COLLKEY1"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("item_type_not_supported");
  });

  it("still allows tag changes on regular items (regression)", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: { add: ["methods"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
  });

  it("normalizes a personal-library legacy numeric id to the portable 'u-' form", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ABCD1234"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.normalized_action_data).toEqual({ item_ids: ["u-ABCD1234"] });
    expect(res.current_value).toEqual({
      "u-ABCD1234": { tags: ["existing"], collections: [] },
    });
  });

  it("normalizes a group-library legacy numeric id to the portable 'g<id>-' form", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["100-GRPKEY12"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.normalized_action_data).toEqual({ item_ids: ["g12345-GRPKEY12"] });
  });

  it("resolves a group item addressed by its portable library_ref to the right local library", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["g12345-GRPKEY12"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    // The item lookup must use the group's LOCAL libraryID (100), not the ref.
    expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(100, "GRPKEY12");
    expect(res.normalized_action_data).toEqual({ item_ids: ["g12345-GRPKEY12"] });
  });

  it("normalizes each item independently in a mixed-library tag-only batch", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-AAAA1111", "100-BBBB2222"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.normalized_action_data).toEqual({
      item_ids: ["u-AAAA1111", "g12345-BBBB2222"],
    });
  });

  it("returns library_unavailable for a portable group ref not present on this device", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["g99999-ZZZZ0000"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("library_unavailable");
  });

  it("reports a collection that only exists in a non-searchable library as not found, without naming it", async () => {
    const zotero = (globalThis as any).Zotero;
    // Library 200 exists locally but is not searchable (user excluded it).
    zotero.Libraries.getAll = vi.fn(() => [
      { libraryID: 1, name: "My Library" },
      { libraryID: 100, name: "Group" },
      { libraryID: 200, name: "Secret Group" },
    ]);
    zotero.Collections.getByLibraryAndKeyAsync = vi.fn(
      async (libId: number, key: string) =>
        libId === 200 && key === "EXCLKEY1" ? { key } : null,
    );

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: null,
        collections: { add: ["EXCLKEY1"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    // The excluded library's match must read as "not found" — confirming the
    // collection exists there (or naming the library) would leak it.
    expect(res.error_code).toBe("collection_not_found");
    expect(res.error).not.toContain("Secret Group");
    expect(res.error).not.toContain("200");
  });

  it("rejects a malformed item id", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["5abc-ABCD1234"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_item_id");
  });
});
