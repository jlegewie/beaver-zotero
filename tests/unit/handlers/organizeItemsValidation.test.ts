import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../react/store", () => ({
  store: { get: vi.fn(() => [1]) },
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

function mockItem(kind: ItemKind) {
  return {
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

describe("validateOrganizeItemsAction annotation tag-gate", () => {
  let previousZotero: any;
  let currentItem: ReturnType<typeof mockItem>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentItem = mockItem("annotation");
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Libraries: { get: vi.fn(() => ({ name: "My Library", editable: true })) },
      Items: { getByLibraryAndKeyAsync: vi.fn(async () => currentItem) },
      ItemTypes: { getName: vi.fn(() => "annotation") },
      Collections: { getByLibraryAndKeyAsync: vi.fn() },
    };
  });

  afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
  });

  it("allows tag changes on an annotation", async () => {
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-ANNOTKEY"],
        tags: { add: ["methods"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
    expect(res.current_value).toEqual({
      "1-ANNOTKEY": { tags: ["existing"], collections: [] },
    });
  });

  it("rejects collection changes on an annotation", async () => {
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
    currentItem = mockItem("regular");
    const res = await validateOrganizeItemsAction(
      buildRequest({
        item_ids: ["1-REGULARKEY"],
        tags: { add: ["methods"], remove: [] },
        collections: null,
      }),
    );

    expect(res.valid).toBe(true);
  });
});
