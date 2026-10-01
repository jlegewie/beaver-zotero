import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/libraryIdentity", async () => ({
  libraryRefForLibraryID: vi.fn(() => undefined),
  resolveItemReference: vi.fn(async () => ({ status: "found", item: attachment })),
  resolveLibraryRef: vi.fn((ref: any) => ref?.library_id ?? null),
  hasLibraryIdentity: (await import("@beaver/agent-core/identity/libraryRef"))
    .hasLibraryIdentity,
}));

vi.mock("../../../src/services/agentDataProvider/utils", () => ({
  checkLibraryExcluded: vi.fn(() => null),
  getAttachmentFileStatus: vi.fn(),
  getDeferredToolPreference: vi.fn(() => "always_ask"),
  validateLibraryAccess: vi.fn(() => ({
    valid: true,
    library: { name: "My Library", editable: true },
  })),
}));

vi.mock("../../../src/services/documentExtraction/attachmentResolution", () => ({
  getReadableContentKind: vi.fn(() => "pdf"),
}));

vi.mock("../../../src/utils/zoteroUtils", () => ({
  shortItemTitle: vi.fn(async () => "Title"),
}));

vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: vi.fn() }));

import {
  executeCreateHighlightAnnotationsAction,
  validateCreateHighlightAnnotationsAction,
} from "../../../src/services/agentDataProvider/actions/createHighlightAnnotations";
import { executeCreateHighlightAnnotationsAction as executeManually } from "../../../src/services/manualActions/createAnnotationsActions";
import { convertHighlightBoxesToRects } from "../../../src/services/annotations/createAnnotation";
import type { PageGeometry } from "@beaver/agent-core/extract/types";

const attachment = {
  isAttachment: () => true,
  attachmentContentType: "application/pdf",
  libraryID: 1,
  id: 42,
  key: "ATT00001",
  parentItem: null,
  loadDataType: vi.fn(),
  getDisplayTitle: () => "Paper",
  getFilePathAsync: vi.fn(async () => "/local/paper.pdf"),
} as any;

const page4: PageGeometry = { viewBox: [0, 0, 600, 800], width: 600, height: 800, rotation: 0 };
// A different viewBox offset, so rects converted with the wrong page's
// geometry would not match.
const page5: PageGeometry = { viewBox: [5, 5, 605, 805], width: 600, height: 800, rotation: 0 };

let savedItems: MockAnnotationItem[] = [];
let nextKey = 0;

class MockAnnotationItem {
  key = `ANNOT${String(nextKey++).padStart(3, "0")}`;
  annotationComment?: string;
  annotationPosition?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  annotationText?: string;
  saveTx = vi.fn(async () => {
    savedItems.push(this);
  });
  addTag = vi.fn();
}

const box = (t: number) => ({ l: 10, t, r: 300, b: t + 20 });

function location(pageIdx: number, overrides: Record<string, any> = {}) {
  return {
    page_idx: pageIdx,
    boxes: [box(pageIdx === 4 ? 740 : 20)],
    page_label: String(pageIdx + 1),
    reading_order_offset: pageIdx === 4 ? 1200 : 0,
    ...overrides,
  };
}

function actionData(pageLocations: any[]) {
  const ref = { library_id: 1, zotero_key: "ATT00001" };
  return {
    requested_ref: ref,
    resolved_ref: ref,
    items: [
      {
        index: 0,
        client_item_id: "client-0",
        title: "Key finding",
        loc_raw: "s5.30,s6.1",
        loc: { kind: "sentence", value: "5.30,6.1", raw: "s5.30,s6.1" },
        text: "The sentence that starts on page five and ends on page six.",
        color: "yellow",
        comment: "Key finding",
        page_locations: pageLocations,
      },
    ],
  };
}

const timeoutContext = () => ({
  signal: new AbortController().signal,
  startTime: Date.now(),
  timeoutSeconds: 60,
}) as any;

const request = (data: any) => ({
  request_id: "req-1",
  action_type: "create_highlight_annotations",
  action_data: data,
}) as any;

describe("two-page PDF highlights", () => {
  let previousZotero: any;

  beforeEach(() => {
    vi.clearAllMocks();
    savedItems = [];
    nextKey = 0;
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Item: MockAnnotationItem,
      Attachments: { LINK_MODE_LINKED_URL: 3 },
      DB: { inTransaction: () => false },
      Prefs: { get: vi.fn() },
      Beaver: {
        documentCache: {
          getMetadata: vi.fn(async () => ({
            pages: [null, null, null, null, page4, page5, page4],
          })),
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
  });

  it("creates one annotation with nextPageRects and reports one created entry", async () => {
    const response = await executeCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(5)])),
      timeoutContext(),
    );

    expect(response.success).toBe(true);
    expect(savedItems).toHaveLength(1);
    const saved = savedItems[0];
    expect(JSON.parse(saved.annotationPosition!)).toEqual({
      pageIndex: 4,
      rects: convertHighlightBoxesToRects([box(740)] as any, page4),
      nextPageRects: convertHighlightBoxesToRects([box(20)] as any, page5),
    });
    // No "(1/2)" part suffix: this is one annotation.
    expect(saved.annotationComment).toBe("Key finding");
    expect(saved.annotationPageLabel).toBe("5");
    expect(saved.annotationSortIndex!.startsWith("00004|001200|")).toBe(true);
    expect(saved.annotationText).toBe(
      "The sentence that starts on page five and ends on page six.",
    );

    expect(response.result_data.created).toEqual([
      expect.objectContaining({
        client_item_id: "client-0",
        zotero_key: saved.key,
        page_idx: 4,
        page_label: "5",
        page_count: 2,
      }),
    ]);
    expect(response.result_data.failed).toEqual([]);
  });

  it("keeps a one-page highlight's position without nextPageRects", async () => {
    const response = await executeCreateHighlightAnnotationsAction(
      request(actionData([location(4)])),
      timeoutContext(),
    );

    expect(savedItems).toHaveLength(1);
    expect(JSON.parse(savedItems[0].annotationPosition!)).not.toHaveProperty("nextPageRects");
    expect(response.result_data.created[0]).not.toHaveProperty("page_count");
  });

  it("fails a highlight covering three pages without writing anything", async () => {
    const response = await executeCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(5), location(6)])),
      timeoutContext(),
    );

    expect(savedItems).toHaveLength(0);
    expect(response.result_data.created).toEqual([]);
    expect(response.result_data.failed).toEqual([
      expect.objectContaining({
        client_item_id: "client-0",
        error_code: "highlight_spans_too_many_pages",
      }),
    ]);
  });

  it("fails a highlight on two pages that are not consecutive", async () => {
    const response = await executeCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(6)])),
      timeoutContext(),
    );

    expect(savedItems).toHaveLength(0);
    expect(response.result_data.failed[0].error_code).toBe("highlight_pages_not_consecutive");
  });

  it("fails a two-page highlight whose continuation has no usable boxes", async () => {
    const response = await executeCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(5, { boxes: [] })])),
      timeoutContext(),
    );

    expect(savedItems).toHaveLength(0);
    expect(response.result_data.created).toEqual([]);
    expect(response.result_data.failed).toEqual([
      expect.objectContaining({ client_item_id: "client-0", error_code: "apply_failed" }),
    ]);
  });

  it("rejects a three-page highlight at validation, before the approval card", async () => {
    const response = await validateCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(5), location(6)])),
    );

    expect(response.valid).toBe(false);
    expect(response.error_code).toBe("highlight_spans_too_many_pages");
    expect(response.error).toMatch(/at most two consecutive pages/);
  });

  it("accepts a two-page highlight at validation", async () => {
    const response = await validateCreateHighlightAnnotationsAction(
      request(actionData([location(4), location(5)])),
    );

    expect(response.valid).toBe(true);
  });

  it("rejects a mislabelled attachment whose file is not a PDF at validation", async () => {
    attachment.attachmentContentType = "application/octet-stream";
    attachment.attachmentFilename = "paper.pdf";
    Object.assign((globalThis as any).Zotero, {
      File: { getSample: vi.fn(async () => "PK\u0003\u0004") },
      MIME: { sniffForMIMEType: vi.fn(() => false) },
    });
    try {
      const response = await validateCreateHighlightAnnotationsAction(
        request(actionData([location(4)])),
      );

      expect(response.valid).toBe(false);
      expect(response.error_code).toBe("invalid_attachment");
      expect(response.error).toContain("application/octet-stream");
    } finally {
      attachment.attachmentContentType = "application/pdf";
      delete attachment.attachmentFilename;
    }
  });

  it("creates one annotation from the manual apply path too", async () => {
    const result = await executeManually({
      proposed_data: actionData([location(4), location(5)]),
    } as any);

    expect(savedItems).toHaveLength(1);
    expect(JSON.parse(savedItems[0].annotationPosition!).nextPageRects).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].page_count).toBe(2);
  });
});
