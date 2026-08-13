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
        rename: vi.fn().mockResolvedValue(undefined),
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

  it("reports a completed undo as reverted", async () => {
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: ["7-ITEMKEY"] },
    } as any);

    expect(outcome).toBe("reverted");
  });

  it("reports a merge undo as partial while the target tag remains", async () => {
    // Undoing a merge re-adds the source tag but leaves the target tag on
    // those items, so the value the action wrote is still there. It is as far
    // as the undo can go, which is not the same as a clean revert.
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { is_merge: true, affected_item_ids: ["7-ITEMKEY"] },
    } as any);

    expect(item.addTag).toHaveBeenCalledWith("reviewed");
    expect(outcome).toBe("partial");
  });

  it("cannot confirm a delete undo that reached none of its items through a device-local id", async () => {
    // Without a library_ref the rowid is this device's; finding none of the
    // snapshot items in it is no proof they are not tagless somewhere else.
    (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(null);

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 12,
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: ["12-GONEKEY"] },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("accepts a delete undo whose items are gone from the personal library", async () => {
    // library_id 1 is the personal library, numbered the same on every device,
    // so a miss really does mean the items are gone and their tag is moot.
    (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(null);

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 1,
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: ["1-GONEKEY"] },
    } as any);

    expect(outcome).toBe("reverted");
  });

  it("reports an empty snapshot as reverted, since the apply requires one", async () => {
    // executeManageTagsAction refuses to write without a snapshot, so an empty
    // one means the tag was on no items and the delete took nothing off any.
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: [] },
    } as any);

    expect(outcome).toBe("reverted");
  });

  it("refuses to call a delete undone when an item could not be looked up", async () => {
    (Zotero.Items.getByLibraryAndKeyAsync as any).mockRejectedValueOnce(new Error('db is busy'));

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: ["7-ITEMKEY"] },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("refuses to remove a tag it could not snapshot", async () => {
    (Zotero.Tags.getTagItems as any).mockRejectedValueOnce(new Error('db is busy'));

    await expect(executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
    } as any)).rejects.toThrow(/db is busy/);

    expect(Zotero.Tags.removeFromLibrary).not.toHaveBeenCalled();
  });

  it("calls a rename a merge only when the target tag is in the same library", async () => {
    // getID is database-global: the target may exist in another library while
    // this rename is a plain, fully reversible one here.
    (Zotero.Tags.getID as any).mockReturnValue(55);
    (Zotero.Tags.getTagItems as any).mockResolvedValue([]);

    const result = await executeManageTagsAction({
      proposed_data: {
        library_id: 7,
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
    } as any);

    expect(result).toMatchObject({ is_merge: false });
  });

  it("cannot confirm an undo whose target library is not on this device", async () => {
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g99",
        action: "delete",
        name: "reviewed",
      },
      result_data: { affected_item_ids: ["g99-ITEMKEY"] },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("renames a plain rename back and reports it reverted", async () => {
    (Zotero.Tags.getTagItems as any).mockResolvedValue([101]);

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { library_ref: "g42", is_merge: false },
    } as any);

    expect(Zotero.Tags.rename).toHaveBeenCalledWith(12, "read", "reviewed");
    expect(outcome).toBe("reverted");
  });

  it("cannot confirm a rename undo through a device-local library id", async () => {
    // Tag names collide across libraries, so finding 'read' in whatever
    // library this device numbers 12 is no evidence it is the right one.
    (Zotero.Tags.getTagItems as any).mockResolvedValue([101]);

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 12,
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { library_id: 12, is_merge: false },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("cannot confirm a rename undo when the tag lookup fails", async () => {
    (Zotero.Tags.getTagItems as any).mockRejectedValueOnce(new Error('db is busy'));

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { library_ref: "g42", is_merge: false },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("cannot confirm a merge undo that reached none of its items through a device-local id", async () => {
    (Zotero.Items.getByLibraryAndKeyAsync as any).mockResolvedValue(null);

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_id: 12,
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { library_id: 12, is_merge: true, affected_item_ids: ["12-GONEKEY"] },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("cannot confirm an undo whose tag color could not be restored", async () => {
    (Zotero.Tags.setColor as any).mockRejectedValueOnce(new Error('locked'));

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "delete",
        name: "reviewed",
      },
      result_data: {
        library_ref: "g42",
        affected_item_ids: ["g42-ITEMKEY"],
        old_color: { color: "#ff0000", position: 0 },
      },
    } as any);

    expect(item.addTag).toHaveBeenCalledWith("reviewed");
    expect(outcome).toBe("unverifiable");
  });

  it("cannot confirm a merge undo whose tag color could not be restored", async () => {
    (Zotero.Tags.setColor as any).mockRejectedValueOnce(new Error('locked'));

    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: {
        library_ref: "g42",
        is_merge: true,
        affected_item_ids: ["g42-ITEMKEY"],
        old_color: { color: "#ff0000", position: 0 },
      },
    } as any);

    expect(outcome).toBe("unverifiable");
  });

  it("calls a rename a merge when the target is a colored tag with no items", async () => {
    // Tag colors live in the library's settings, not on items, so a colored
    // target is present here — and rename overwrites its color with the
    // source's, which a plain rename-back does not put right.
    (Zotero.Tags.getColor as any).mockImplementation((_lib: number, tagName: string) =>
      tagName === "read" ? { color: "#ff0000", position: 0 } : null,
    );
    // The source's snapshot, then nothing for the target: its color is the only
    // thing that can make it count as present.
    (Zotero.Tags.getTagItems as any)
      .mockResolvedValueOnce([101])
      .mockResolvedValue([]);

    const result = await executeManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
    } as any);

    expect(result).toMatchObject({ is_merge: true });
  });

  it("reports a merge undo as partial when it moved a color off no items", async () => {
    // No membership moved, but the rename carried the source's color to the
    // target and overwrote the target's own, which is recorded nowhere.
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: {
        library_ref: "g42",
        is_merge: true,
        affected_item_ids: [],
        old_color: { color: "#ff0000", position: 0 },
      },
    } as any);

    expect(outcome).toBe("partial");
  });

  it("reports a colorless empty merge as reverted", async () => {
    const outcome = await undoManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
      result_data: { library_ref: "g42", is_merge: true, affected_item_ids: [] },
    } as any);

    expect(outcome).toBe("reverted");
  });

  it("records a rename as a merge when it cannot tell", async () => {
    // The snapshot lookup succeeds; the one deciding whether the target tag is
    // already here fails. Assuming a merge sends undo down the branch that
    // re-tags from the snapshot rather than renaming back a tag that may never
    // have been merged.
    (Zotero.Tags.getTagItems as any)
      .mockResolvedValueOnce([101])
      .mockRejectedValueOnce(new Error('db is busy'));

    const result = await executeManageTagsAction({
      proposed_data: {
        library_ref: "g42",
        action: "rename",
        name: "reviewed",
        new_name: "read",
      },
    } as any);

    expect(result).toMatchObject({ is_merge: true });
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
