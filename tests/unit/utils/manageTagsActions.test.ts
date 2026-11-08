import { installMutationInstance } from '../../helpers/mutationInstance';
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@beaver/agent-core/platform/logger", () => ({
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

  it("treats a delete as a no-op when the tag has no items in the target library", async () => {
    (Zotero.Tags.getTagItems as any).mockResolvedValue([]);

    const result = await executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
    } as any);

    expect(result).toMatchObject({ items_affected: 0, affected_item_ids: [] });
    expect(Zotero.Tags.removeFromLibrary).not.toHaveBeenCalled();
  });

  it("refuses a delete without writing when the tag's item count changed since the proposal", async () => {
    (Zotero.Tags.getTagItems as any).mockResolvedValue([101, 102, 103]);

    await expect(executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
        baseline: { item_count: 1, is_merge: null },
      },
    } as any)).rejects.toMatchObject({
      code: "stale_proposal",
      message: expect.stringContaining("is now on 3 items, not 1"),
    });
    expect(Zotero.Tags.removeFromLibrary).not.toHaveBeenCalled();
  });

  it("deletes anyway when the user skips the check", async () => {
    (Zotero.Tags.getTagItems as any).mockResolvedValue([101, 102, 103]);

    await executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
        baseline: { item_count: 1 },
      },
    } as any, { skipStaleCheck: true });

    expect(Zotero.Tags.removeFromLibrary).toHaveBeenCalledWith(12, [33]);
  });

  it("refuses a rename that would now merge into a tag created since the proposal", async () => {
    (Zotero.Tags as any).rename = vi.fn().mockResolvedValue(undefined);
    (Zotero.Tags.getID as any).mockImplementation((name: string) => (name === "reviewed" || name === "done" ? 33 : false));

    await expect(executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "done",
        baseline: { item_count: 1, is_merge: false },
      },
    } as any)).rejects.toMatchObject({
      code: "stale_proposal",
      message: expect.stringContaining("'done' now exists"),
    });
    expect((Zotero.Tags as any).rename).not.toHaveBeenCalled();
  });

  it("applies a proposal whose tag is as the user saw it", async () => {
    (Zotero.Tags as any).rename = vi.fn().mockResolvedValue(undefined);
    (Zotero.Tags.getID as any).mockImplementation((name: string) => (name === "reviewed" ? 33 : false));

    await executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "done",
        baseline: { item_count: 1, is_merge: false },
      },
    } as any);

    expect((Zotero.Tags as any).rename).toHaveBeenCalledWith(12, "reviewed", "done");
  });
});

beforeEach(installMutationInstance);
