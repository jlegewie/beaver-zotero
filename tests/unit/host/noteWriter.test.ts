import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getZoteroTargetContext: vi.fn(),
  getZoteroTargetContextSync: vi.fn(),
  getCurrentLibrary: vi.fn(),
  isLibraryEditable: vi.fn(),
  selectItem: vi.fn(),
  selectItemById: vi.fn(),
}));

vi.mock("../../../src/utils/zoteroUtils", () => ({
  getZoteroTargetContext: mocks.getZoteroTargetContext,
  getZoteroTargetContextSync: mocks.getZoteroTargetContextSync,
  getCurrentLibrary: mocks.getCurrentLibrary,
  isLibraryEditable: mocks.isLibraryEditable,
}));

vi.mock("../../../react/utils/selectItem", () => ({
  selectItem: mocks.selectItem,
  selectItemById: mocks.selectItemById,
}));

vi.mock("../../../react/utils/noteActions", () => ({
  generateNoteTitle: vi.fn(() => ""),
  getBeaverNoteFooterHTML: vi.fn(() => ""),
  wrapWithSchemaVersion: vi.fn((html: string) => html),
}));

vi.mock("../../../react/atoms/threads", () => ({
  currentThreadIdAtom: Symbol("currentThreadIdAtom"),
}));

vi.mock("../../../react/store", () => ({
  store: { get: vi.fn(() => null) },
}));

import { zoteroNoteWriter } from "../../../react/host/zotero/noteWriter";

describe("zoteroNoteWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    class MockNote {
      libraryID = 0;
      key = "NOTE1234";
      parentKey: string | false = false;

      setNote = vi.fn();
      saveTx = vi.fn().mockResolvedValue(undefined);
    }

    (globalThis as any).Zotero = {
      ...(globalThis as any).Zotero,
      Item: MockNote,
      Libraries: { userLibraryID: 1 },
      Groups: {
        getGroupIDFromLibraryID: vi.fn((libraryID: number) =>
          libraryID === 7 ? 42 : false,
        ),
      },
      DB: {
        executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
      },
      getActiveZoteroPane: vi.fn(() => ({
        getSelectedCollection: vi.fn(() => null),
      })),
      getMainWindow: vi.fn(() => ({
        Zotero_Tabs: { selectedType: "reader" },
      })),
    };

    mocks.getZoteroTargetContextSync.mockReturnValue({
      targetLibraryId: 7,
      parentReference: null,
    });
    mocks.isLibraryEditable.mockReturnValue(true);
  });

  it("returns a portable library_ref for a manually saved group note", async () => {
    const result = await zoteroNoteWriter.saveNote({
      contentHtml: "<p>Saved response</p>",
      asChild: false,
      format: { kind: "streaming-note" },
    });

    expect(result).toEqual({
      library_id: 7,
      library_ref: "g42",
      zotero_key: "NOTE1234",
    });
  });
});

// Bind this suite's single-window fixture as the originating renderer.
vi.mock('../../../react/runtime/windowRuntime', async () => {
    const { singleWindowRuntimeMock } = await import('../../helpers/singleWindowRuntime');
    return singleWindowRuntimeMock();
});
