import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/logger", () => ({
  logger: vi.fn(),
}));

import {
  executeManageTagsAction,
  undoManageTagsAction,
} from "../../../react/utils/manageTagsActions";

describe("undoManageTagsAction", () => {
  let item: {
    getTags: ReturnType<typeof vi.fn>;
    addTag: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    item = {
      getTags: vi.fn(() => []),
      addTag: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    (globalThis as any).Zotero = {
      ...(globalThis as any).Zotero,
      Libraries: {
        userLibraryID: 1,
      },
      Groups: {
        getLibraryIDFromGroupID: vi.fn((groupID: number) =>
          groupID === 42 ? 12 : null,
        ),
        getGroupIDFromLibraryID: vi.fn((libraryID: number) =>
          libraryID === 12 ? 42 : null,
        ),
      },
      Items: {
        getAsync: vi.fn(async () => [{ key: "ITEMKEY" }]),
        getByLibraryAndKeyAsync: vi.fn(
          async (libraryID: number, key: string) =>
            libraryID === 12 && key === "ITEMKEY" ? item : null,
        ),
        loadDataTypes: vi.fn().mockResolvedValue(undefined),
      },
      Tags: {
        getID: vi.fn(() => 33),
        getTagItems: vi.fn().mockResolvedValue([101]),
        getColor: vi.fn(() => null),
        removeFromLibrary: vi.fn().mockResolvedValue(undefined),
        setColor: vi.fn().mockResolvedValue(undefined),
      },
      DB: {
        executeTransaction: vi.fn(async (callback: () => Promise<void>) =>
          callback(),
        ),
      },
    };
  });

  it("uses the portable action library when a numeric snapshot prefix came from another device", async () => {
    await undoManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
      result_data: {
        // Device A stored its local group-library rowid (7). On this
        // device the same group resolves to rowid 12.
        affected_item_ids: ["7-ITEMKEY"],
      },
    } as any);

    expect(Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledWith(
      12,
      "ITEMKEY",
    );
    expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalledWith(
      7,
      "ITEMKEY",
    );
    expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith([item], ["tags"]);
    expect(item.addTag).toHaveBeenCalledWith("reviewed");
    expect(item.save).toHaveBeenCalledTimes(1);
  });

  it("writes portable item IDs into new snapshots", async () => {
    const result = await executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
    } as any);

    expect(result).toMatchObject({
      library_id: 12,
      library_ref: "g42",
      affected_item_ids: ["g42-ITEMKEY"],
    });
    expect(Zotero.Tags.getTagItems).toHaveBeenCalledWith(12, 33);
    expect(Zotero.Tags.removeFromLibrary).toHaveBeenCalledWith(12, [33]);
  });
});
