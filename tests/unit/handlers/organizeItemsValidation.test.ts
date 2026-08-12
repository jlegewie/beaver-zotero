import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fixture state the faked collection resolver reads. Library 200 is local but
// excluded from Beaver, so nothing may resolve there.
const harness = vi.hoisted(() => ({
  collections: [] as any[],
  libraryRefs: { 1: "u", 100: "g12345", 200: "g67890" } as Record<number, string>,
  libraryNames: { 1: "My Library", 100: "Group", 200: "Secret Group" } as Record<number, string>,
  searchableLibraryIds: [1, 100] as number[],
}));

vi.mock("../../../react/store", () => ({
  // Personal library (1) + a local group library (100) are searchable.
  store: { get: vi.fn(() => [1, 100]) },
}));

vi.mock("../../../react/atoms/profile", () => ({
  searchableLibraryIdsAtom: Symbol("searchableLibraryIdsAtom"),
}));

vi.mock("../../../src/services/agentDataProvider/utils", async () => {
  const { createCollectionResolverFake } = await import("../../helpers/collectionResolverFake");
  const fake = createCollectionResolverFake(harness);
  return {
    getDeferredToolPreference: vi.fn(() => "always_ask"),
    excludedLibraryMessage: vi.fn((libraryId: number) => `Library ${libraryId} is excluded from Beaver.`),
    resolveSingleCollection: vi.fn(fake.resolveSingleCollection),
    resolveCollectionForWrite: vi.fn(fake.resolveCollectionForWrite),
  };
});

import { validateOrganizeItemsAction, executeOrganizeItemsAction } from "../../../src/services/agentDataProvider/actions/organizeItems";
import { store } from "../../../react/store";
import type { WSAgentActionValidateRequest } from "@beaver/agent-core/protocol/agentProtocol";

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
    harness.collections = [
      { id: 1, key: "CLLKEY23", libraryID: 1, name: "Reading" },
      { id: 2, key: "CLLKEY24", libraryID: 100, name: "Group Reading" },
    ];
    harness.searchableLibraryIds = [1, 100];
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
        collections: { add: ["CLLKEY23"], remove: [] },
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
    // Library 200 exists locally but is not searchable (user excluded it).
    harness.collections.push({ id: 3, key: "EXCLKEY2", libraryID: 200, name: "Excluded" });

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: null,
        collections: { add: ["EXCLKEY2"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    // The excluded library's match must read as "not found" — confirming the
    // collection exists there (or naming the library) would leak it.
    expect(res.error_code).toBe("collection_not_found");
    expect(res.error).not.toContain("Secret Group");
    expect(res.error).not.toContain("200");
  });

  it("reports a nonexistent item and a nonexistent collection key together in one error", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
      key === "GOODITEM" ? makeItem("regular", libId, key) : false,
    );
    zotero.Libraries.getAll = vi.fn(() => [{ libraryID: 1, name: "My Library" }]);

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-GOODITEM", "1-MISSING01"],
        tags: null,
        collections: { add: ["BADCOLL2"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("multiple_item_errors");
    expect(res.error).toContain("1-MISSING01");
    expect(res.error).toContain("BADCOLL2");
    // The frontend never had to be asked twice — both problems in one shot.
    expect(res.error).not.toContain("GOODITEM");
  });

  it("preserves the library-exclusion error code even when mixed with a different failure", async () => {
    const zotero = (globalThis as any).Zotero;
    // Library 100 is normally searchable per the module-level store mock —
    // exclude it for this test only so "100-EXCLKEY1" hits library_not_searchable.
    (store.get as any).mockReturnValueOnce([1]);
    zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
      key === "MISSING01" ? false : makeItem("regular", libId, key),
    );

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["100-EXCLKEY1", "1-MISSING01"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(false);
    // Must NOT collapse to the generic 'multiple_item_errors' bucket — the
    // access-control classification has to survive mixing with an unrelated
    // failure (here, a not-found item).
    expect(res.error_code).toBe("library_not_searchable");
    expect(res.error).toContain("100-EXCLKEY1");
    expect(res.error).toContain("1-MISSING01");
  });

  it("rejects a collection name even when it resolves cleanly in the item library", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: null,
        collections: { add: ["Reading"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error).toContain("u-CLLKEY23");
    expect(res.error).toContain("list_collections");
  });

  it("accepts a scoped collection identifier and normalizes it to a bare key", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: null,
        collections: { add: ["u-CLLKEY23"], remove: [] },
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.normalized_action_data).toEqual({
      item_ids: ["u-REGULARKEY"],
      collections: { add: ["CLLKEY23"], remove: [] },
      library_id: 1,
      library_ref: "u",
    });
  });

  it("still reports a collection that lives in another searchable library", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: null,
        // CLLKEY24 is in the group library, the items are in the personal one.
        collections: { add: ["CLLKEY24"], remove: [] },
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("collection_in_different_library");
    expect(res.error).toContain("CLLKEY24");
    expect(res.error).toContain("library-scoped");
  });

  it("flags an item key pasted into add_to_collections, bare or scoped", async () => {
    const bare = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ITEMKEY2"],
        tags: null,
        collections: { add: ["ITEMKEY2"], remove: [] },
      }),
    );
    expect(bare.valid).toBe(false);
    expect(bare.error).toContain("also appear in item_ids");

    const scoped = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ITEMKEY2"],
        tags: null,
        collections: { add: ["u-ITEMKEY2"], remove: [] },
      }),
    );
    expect(scoped.valid).toBe(false);
    expect(scoped.error).toContain("also appear in item_ids");
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

  it("reports every nonexistent item id in one error instead of only the first", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (libId: number, key: string) =>
      key === "GOODKEY1" ? makeItem("regular", libId, key) : false,
    );

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-GOODKEY1", "1-MISSING01", "1-MISSING02"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("item_not_found");
    expect(res.error).toContain("1-MISSING01");
    expect(res.error).toContain("1-MISSING02");
    expect(res.error).not.toContain("GOODKEY1");
  });

  it("uses a generic error_code when the batch has mixed failure reasons", async () => {
    const zotero = (globalThis as any).Zotero;
    zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => false);

    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-MISSING01", "5abc-BADFORMAT"],
        tags: { add: ["x"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("multiple_item_errors");
    expect(res.error).toContain("1-MISSING01");
    expect(res.error).toContain("5abc-BADFORMAT");
  });

  // An off-contract collection entry must still produce the batch diagnostic:
  // parsing it as an item reference throws, which would replace every
  // per-reference message with a bare TypeError.
  it.each([
    ["a number", 12345, "12345"],
    ["a boolean", true, "true"],
    ["an object", { key: "ABCD1234" }, "ABCD1234"],
    ["null", null, "null"],
  ])(
    "reports %s collection reference by name without losing the batch diagnostic",
    async (_label, value, expectedInMessage) => {
      const res = await validateOrganizeItemsAction(
        buildRequest({
          item_ids: ["1-GOODKEY1"],
          collections: { add: [value] },
        }),
      );

      expect(res.valid).toBe(false);
      expect(res.error_code).not.toBe("validation_failed");
      expect(res.error).not.toContain("TypeError");
      expect(res.error).toContain("list_collections");
      // The offending entry must name itself, or the model is told a collection
      // is missing without being told which one to fix.
      expect(res.error).toContain(expectedInMessage);
    },
  );

  it("names an empty-string collection reference in the batch report", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: ["1-GOODKEY1"], collections: { add: [""] } }),
    );

    expect(res.valid).toBe(false);
    expect(res.error).toContain('""');
  });

  // An off-contract container must be rejected outright. Reading undefined
  // leaves off it would report success for a change that was never applied;
  // iterating a bare string walks it character by character, writing one tag or
  // collection per letter.
  it.each([
    ['collections.add', { collections: { add: "ABCD1234" } }],
    ['collections.remove', { collections: { remove: "ABCD1234" } }],
    ['tags.add', { tags: { add: "urgent" } }],
    ['tags.remove', { tags: { remove: "urgent" } }],
  ])("rejects a non-array %s container", async (field, actionData) => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: ["1-GOODKEY1"], ...actionData }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).toContain(`"${field}"`);
    expect(res.error).not.toMatch(/A, B, C, D/);
    expect(res.error).not.toMatch(/u, r, g, e/);
  });

  // An empty list is the wrong shape but unambiguously means "no changes here",
  // so it must not fail a request whose other group carries real changes.
  it.each([
    ['tags', { tags: [], collections: { add: ["CLLKEY23"] } }],
    ['collections', { collections: [], tags: { add: ["x"] } }],
  ])("treats an empty %s list as no changes rather than malformed", async (_field, actionData) => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: ["1-GOODKEY1"], ...actionData }),
    );

    expect(res.valid).toBe(true);
  });

  it.each([
    ['collections', { collections: ["ABCD1234"], tags: { add: ["x"] } }],
    ['collections', { collections: "ABCD1234", tags: { add: ["x"] } }],
    ['tags', { tags: ["x"], collections: { add: ["CLLKEY23"] } }],
    ['tags', { tags: "x", collections: { add: ["CLLKEY23"] } }],
  ])("rejects a %s container that is not an add/remove object", async (field, actionData) => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: ["1-GOODKEY1"], ...actionData }),
    );

    // Silently dropping it would report success for a change never applied.
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).toContain(`"${field}"`);
  });

  // Tag entries have no downstream validator: Zotero coerces a number into the
  // literal tag "123", which undo's strict comparison can then never match.
  // Collection entries are deliberately left to the resolver so they are
  // reported alongside the batch's other reference problems.
  it.each([
    ['tags.add', { tags: { add: ["ok", 123] } }],
    ['tags.remove', { tags: { remove: [null] } }],
  ])("rejects a non-string entry in %s", async (field, actionData) => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: ["1-GOODKEY1"], ...actionData }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).toContain(`Every entry in "${field}"`);
  });

  // The batch diagnostic below parses every item id, so an off-contract one has
  // to be rejected before it reaches the parser rather than throwing there.
  it.each([
    ['a number entry', [12345]],
    ['a null entry', [null]],
    ['a bare string instead of a list', "1-GOODKEY1"],
  ])("rejects %s in item_ids with a typed error", async (_label, item_ids) => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids, tags: { add: ["x"] } }),
    );

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).not.toContain("TypeError");
    expect(res.error).toContain("item_ids");
  });

  // The batch contract is to report every bad id in one round trip, so each one
  // has to be named rather than only the rule being restated.
  it("names every off-contract item_ids entry in one error", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: [12345, null, "1-GOODKEY1"], tags: { add: ["x"] } }),
    );

    expect(res.valid).toBe(false);
    expect(res.error).toContain("12345");
    expect(res.error).toContain("null");
    expect(res.error).not.toContain("GOODKEY1");
  });

  // The payload is checked before it is destructured, so a null one reports a
  // typed error instead of throwing out of the destructuring.
  it.each([
    ["null", null],
    ["a number", 42],
    ["a list", ["1-GOODKEY1"]],
  ])("rejects %s action_data with a typed error", async (_label, actionData) => {
    const res = await validateOrganizeItemsAction({
      type: "agent_action_validate_request",
      request_id: "req-1",
      action_type: "organize_items",
      action_data: actionData,
    } as any);

    expect(res.valid).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).not.toContain("TypeError");
    expect(res.error).toContain("Action data must be an object");
  });

  // Shape is checked before entries are counted: a bare string has a `length`,
  // so counting first would report "too many items" for a type error.
  it("reports a long bare-string item_ids as a shape error, not too_many_items", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({ item_ids: "A".repeat(130), tags: { add: ["x"] } }),
    );

    expect(res.error_code).toBe("invalid_request");
    expect(res.error).toContain('"item_ids" must be a list');
  });
});

describe("executeOrganizeItemsAction input guards", () => {
  const buildExecuteRequest = (actionData: any): any => ({
    type: "agent_action_execute_request",
    request_id: "req-1",
    action_type: "organize_items",
    action_data: actionData,
  });
  const ctx: any = { signal: new AbortController().signal, timeoutSeconds: 30, startTime: Date.now() };

  // The execute path is reachable without validate, and it has no batch
  // reference report — anything it cannot apply is skipped, so a malformed
  // payload has to be rejected here or it reports success for a change that
  // never happened.
  it.each([
    ["null action_data", null, "Action data must be an object"],
    ["a non-array collections.add", { item_ids: ["1-GOODKEY1"], collections: { add: "ABCD1234" } }, '"collections.add" must be a list'],
    ["a non-array tags.add", { item_ids: ["1-GOODKEY1"], tags: { add: "urgent" } }, '"tags.add" must be a list'],
    ["a non-string collection entry", { item_ids: ["1-GOODKEY1"], collections: { add: [true] } }, 'Every entry in "collections.add"'],
    ["a non-string tag entry", { item_ids: ["1-GOODKEY1"], tags: { add: [42] } }, 'Every entry in "tags.add"'],
    ["a non-string item id", { item_ids: [12345], tags: { add: ["x"] } }, 'Every entry in "item_ids"'],
  ])("rejects %s", async (_label, actionData, expected) => {
    const res = await executeOrganizeItemsAction(buildExecuteRequest(actionData), ctx);

    expect(res.success).toBe(false);
    expect(res.error_code).toBe("invalid_request");
    expect(res.error).toContain(expected as string);
    expect(res.error).not.toContain("TypeError");
  });

  it("reports missing item_ids as no_items rather than throwing", async () => {
    const res = await executeOrganizeItemsAction(
      buildExecuteRequest({ tags: { add: ["x"] } }),
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.error_code).toBe("no_items");
    expect(res.error).not.toContain("TypeError");
  });
});
