import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: vi.fn() }));
vi.mock("../../../react/utils/annotationUtils", () => ({}));
vi.mock("../../../react/utils/readerUtils", () => ({
  getCurrentReader: vi.fn(),
  getCurrentReaderAndWaitForView: vi.fn(),
}));
vi.mock("../../../react/utils/pdfUtils", () => ({
  getPageViewportInfo: vi.fn().mockResolvedValue({
    viewBox: [0, 0, 400, 600],
    width: 400,
    height: 600,
    rotation: 0,
  }),
  isPDFDocumentAvailable: () => true,
  waitForPDFDocument: vi.fn().mockResolvedValue(true),
  applyRotationToBoundingBox: (box: unknown) => box,
}));
vi.mock("../../../src/utils/zoteroUtils", () => ({ isLibraryEditable: () => true }));

import { applyAnnotation } from "../../../react/utils/annotationActions";
import { wasWrittenByBeaver } from "../../../src/services/annotations/beaverAnnotationRegistry";
import { CoordOrigin } from "@beaver/agent-core/types/citations";

const READER_LIBRARY_ID = 7;
const CREATED_KEY = "RDRKEY01";

/** Annotation item as the observer would see it after the reader's save. */
function savedAnnotation(libraryID: number, key: string) {
  return { libraryID, key } as unknown as Zotero.Item;
}

/** Annotation manager returns the annotation synchronously; only the save is deferred. */
function syncAddAnnotation(id: string, onCalled?: () => void) {
  return vi.fn().mockImplementation(() => {
    onCalled?.();
    return { id };
  });
}

function mockReader(libraryID: number, addAnnotation: any) {
  return {
    _item: { libraryID, key: "ATT123" },
    _internalReader: {
      _primaryView: { _iframeWindow: {} },
      _annotationManager: { addAnnotation },
    },
  } as any;
}

const noteAction = {
  id: "action-2",
  action_type: "note_annotation",
  proposed_data: {
    attachment_key: "ATT123",
    library_id: READER_LIBRARY_ID,
    comment: "a note",
    color: "yellow",
    note_position: {
      page_index: 0,
      side: "left",
      x: 0,
      y: 100,
      coord_origin: CoordOrigin.TOPLEFT,
    },
  },
} as any;

const highlightAction = {
  id: "action-1",
  action_type: "highlight_annotation",
  proposed_data: {
    attachment_key: "ATT123",
    library_id: READER_LIBRARY_ID,
    text: "highlighted text",
    comment: "",
    color: "yellow",
    highlight_locations: [
      {
        page_idx: 0,
        boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
      },
    ],
  },
} as any;

describe("applyAnnotation write registry", () => {
  let previousZotero: any;
  let previousComponents: any;

  beforeEach(() => {
    vi.clearAllMocks();
    previousZotero = (globalThis as any).Zotero;
    previousComponents = (globalThis as any).Components;
    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1, get: () => ({ libraryType: "group", groupID: 42 }) },
      Groups: { getLibraryIDFromGroupID: () => READER_LIBRARY_ID },
    };
    (globalThis as any).Components = { utils: { cloneInto: (value: unknown) => value } };
  });

  afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
    (globalThis as any).Components = previousComponents;
  });

  it("records the reader's annotation so it is not read back as user activity", async () => {
    const reader = mockReader(
      READER_LIBRARY_ID,
      syncAddAnnotation(CREATED_KEY),
    );

    const result = await applyAnnotation(highlightAction, reader);

    expect(result.zotero_key).toBe(CREATED_KEY);
    expect(wasWrittenByBeaver(savedAnnotation(READER_LIBRARY_ID, CREATED_KEY))).toBe(true);
  });

  it("records it under the library the reader saves into", async () => {
    const reader = mockReader(
      READER_LIBRARY_ID,
      syncAddAnnotation("OTHERKEY"),
    );
    const crossLibraryAction = {
      ...highlightAction,
      proposed_data: { ...highlightAction.proposed_data, library_id: 1 },
    };

    await applyAnnotation(crossLibraryAction, reader);

    expect(wasWrittenByBeaver(savedAnnotation(READER_LIBRARY_ID, "OTHERKEY"))).toBe(true);
    expect(wasWrittenByBeaver(savedAnnotation(1, "OTHERKEY"))).toBe(false);
  });

  it("records a note annotation the same way", async () => {
    const reader = mockReader(
      READER_LIBRARY_ID,
      syncAddAnnotation("NOTEKEY1"),
    );

    await applyAnnotation(noteAction, reader);

    expect(wasWrittenByBeaver(savedAnnotation(READER_LIBRARY_ID, "NOTEKEY1"))).toBe(true);
  });

  it("records the write without yielding after the reader returns the key", async () => {
    // addAnnotation starts the save in the same call that returns the key.
    let registeredOnFirstContinuation: boolean | null = null;
    const reader = mockReader(
      READER_LIBRARY_ID,
      syncAddAnnotation("DEFERRED1", () => {
        Promise.resolve().then(() => {
          registeredOnFirstContinuation = wasWrittenByBeaver(
            savedAnnotation(READER_LIBRARY_ID, "DEFERRED1"),
          );
        });
      }),
    );

    await applyAnnotation(highlightAction, reader);

    expect(registeredOnFirstContinuation).toBe(true);
  });

  it("leaves a user's own annotation unclaimed", async () => {
    const reader = mockReader(
      READER_LIBRARY_ID,
      syncAddAnnotation(CREATED_KEY),
    );

    await applyAnnotation(highlightAction, reader);

    expect(wasWrittenByBeaver(savedAnnotation(READER_LIBRARY_ID, "USERKEY1"))).toBe(false);
  });
});
