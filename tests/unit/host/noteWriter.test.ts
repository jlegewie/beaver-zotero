import { installMutationInstance } from '../../helpers/mutationInstance';
vi.mock('../../../src/utils/zoteroUtils', () => ({ isLibraryEditable: mocks.isLibraryEditable }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getZoteroTargetContext: vi.fn(),
  getZoteroTargetContextSync: vi.fn(),
  getCurrentLibrary: vi.fn(),
  isLibraryEditable: vi.fn(),
  selectItem: vi.fn(),
  selectItemById: vi.fn(),
  saveTx: vi.fn(),
}));

vi.mock("../../../react/utils/zoteroTargetContext", () => ({
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
    installMutationInstance();
    (Zotero as any).Beaver.searchableLibraryIds = [1, 7];
    mocks.saveTx.mockReset().mockResolvedValue(undefined);

    class MockNote {
      libraryID = 0;
      key = "NOTE1234";
      parentKey: string | false = false;

      setNote = vi.fn();
      saveTx = mocks.saveTx;
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

  it.each([false, true])("returns the saved note when its owner starts closing before reveal (child: %s)", async asChild => {
    const win: any = { closed: false, Zotero_Tabs: { selectedType: "library" }, ZoteroPane: {} };
    vi.mocked(Zotero.getMainWindow).mockReturnValue(win);
    mocks.getZoteroTargetContextSync.mockReturnValue({
      targetLibraryId: 7,
      parentReference: asChild ? { library_id: 7, zotero_key: "PARENT01" } : null,
    });
    mocks.saveTx.mockImplementationOnce(async () => { win.__beaverRuntime = { status: "closing" }; });
    const select = asChild ? mocks.selectItem : mocks.selectItemById;
    select.mockImplementationOnce(async () => {
      expect(mocks.saveTx).toHaveBeenCalledOnce();
      expect(win.__beaverRuntime.status).toBe("closing");
      win.closed = true;
      throw new Error("destination window unavailable");
    });
    await expect(zoteroNoteWriter.saveNote({
      contentHtml: "<p>Saved response</p>", asChild, format: { kind: "streaming-note" },
    })).resolves.toMatchObject({ library_id: 7, zotero_key: "NOTE1234", library_ref: "g42" });
    expect(select).toHaveBeenCalledOnce();
    expect(mocks.saveTx).toHaveBeenCalledOnce();
  });

  it("still rejects an actual persistence failure", async () => {
    mocks.saveTx.mockRejectedValueOnce(new Error("write failed"));
    await expect(zoteroNoteWriter.saveNote({
      contentHtml: "<p>Unsaved</p>", asChild: false, format: { kind: "streaming-note" },
    })).rejects.toThrow("write failed");
    expect(mocks.selectItem).not.toHaveBeenCalled();
    expect(mocks.selectItemById).not.toHaveBeenCalled();
  });

});

// Bind this suite's single-window fixture as the originating renderer.
vi.mock('../../../react/runtime/windowRuntime', async () => {
    const { singleWindowRuntimeMock } = await import('../../helpers/singleWindowRuntime');
    return singleWindowRuntimeMock();
});
