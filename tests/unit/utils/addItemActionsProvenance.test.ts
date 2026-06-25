import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/logger", () => ({
  logger: vi.fn(),
}));

vi.mock("../../../src/utils/zoteroUtils", () => ({
  getZoteroTargetContext: vi.fn(),
}));

vi.mock("../../../src/utils/backgroundTasks", () => ({
  scheduleBackgroundTask: vi.fn(),
  generateTaskId: vi.fn(),
  isPdfFetchInProgress: vi.fn(() => false),
  deduplicatedSync: vi.fn(),
}));

vi.mock("../../../src/utils/sync", () => ({
  ensureItemSynced: vi.fn(),
}));

vi.mock("../../../src/utils/prefs", () => ({
  getPref: vi.fn(() => false),
}));

vi.mock("../../../react/utils/attachmentResolvedEvent", () => ({
  emitAttachmentResolved: vi.fn(),
}));

vi.mock("../../../react/utils/noteActions", () => ({
  createProvenanceNote: vi.fn(),
}));

import {
  createZoteroItem,
  stampBeaverProvenanceExtra,
} from "../../../react/utils/addItemActions";

class MockItem {
  private extra: string;

  constructor(extra = "") {
    this.extra = extra;
  }

  getField = vi.fn((field: string) => (field === "extra" ? this.extra : ""));

  setField = vi.fn((field: string, value: string) => {
    if (field === "extra") {
      this.extra = value;
    }
  });
}

describe("stampBeaverProvenanceExtra", () => {
  it("adds the Beaver marker and reason without saving", () => {
    const item = new MockItem("PMID: 123");

    const changed = stampBeaverProvenanceExtra(item as any, {
      reason: "Relevant to the thread",
    });

    expect(changed).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(item.setField).toHaveBeenCalledWith(
      "extra",
      `PMID: 123\nAdded by Beaver: ${today}\nBeaver Reason: Relevant to the thread`,
    );
    expect((item as any).saveTx).toBeUndefined();
  });

  it("is idempotent when the marker is already present", () => {
    const item = new MockItem("Added by Beaver\nBeaver Reason: Existing");

    const changed = stampBeaverProvenanceExtra(item as any, {
      reason: "Existing",
    });

    expect(changed).toBe(false);
    expect(item.setField).not.toHaveBeenCalled();
  });
});

describe("createZoteroItem import target", () => {
  it("adds imports to the selected collection even when an item is selected", async () => {
    const addItem = vi.fn();
    const collection = { id: 42, libraryID: 7, addItem };
    const createdItem = {
      id: 99,
      key: "NEWITEM1",
      libraryID: 0,
      itemTypeID: 4,
      setField: vi.fn(),
      setCreators: vi.fn(),
      saveTx: vi.fn(async () => 99),
      getAttachments: vi.fn(() => []),
    };

    (globalThis as any).Zotero.getMainWindow = vi.fn(() => ({
      Zotero_Tabs: { selectedType: "library" },
    }));
    (globalThis as any).Zotero.getActiveZoteroPane = vi.fn(() => ({
      getSelectedLibraryID: vi.fn(() => 7),
      getSelectedCollection: vi.fn(() => collection),
      getSelectedItems: vi.fn(() => [{ libraryID: 7, isRegularItem: () => true }]),
    }));
    (globalThis as any).Zotero.Libraries.userLibraryID = 1;
    (globalThis as any).Zotero.Libraries.get = vi.fn(() => ({ editable: true }));
    (globalThis as any).Zotero.ItemTypes.getID = vi.fn(() => 4);
    (globalThis as any).Zotero.ItemTypes.getName = vi.fn(() => "journalArticle");
    (globalThis as any).Zotero.ItemFields.isValidForType = vi.fn(() => true);
    (globalThis as any).Zotero.Item = vi.fn(() => createdItem);
    (globalThis as any).Zotero.Collections = {
      get: vi.fn(() => collection),
    };
    (globalThis as any).Zotero.DB = {
      executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
    };

    await createZoteroItem({
      title: "Imported paper",
      publication_types: ["journal_article"],
      is_open_access: false,
    } as any);

    expect(createdItem.libraryID).toBe(7);
    expect(addItem).toHaveBeenCalledWith(99);
  });
});
