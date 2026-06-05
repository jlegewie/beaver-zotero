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

import { stampBeaverProvenanceExtra } from "../../../react/utils/addItemActions";

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
