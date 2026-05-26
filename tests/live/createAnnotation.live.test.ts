import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  isZoteroAvailable,
  skipIfNoZotero,
} from "../helpers/zoteroAvailability";
import {
  getCacheMetadata,
  invalidateCache,
  resolveItem,
  triggerFileStatus,
} from "../helpers/cacheInspector";
import {
  ENCRYPTED_PDF,
  GROUP_LIB_PDF,
  MISSING_FILE_PDF,
  NON_PDF,
  NORMAL_PDF,
  NO_TEXT_PDF,
  SMALL_PDF,
  type AttachmentFixture,
} from "../helpers/fixtures";
import { post } from "../helpers/zoteroHttpClient";
import { CoordOrigin } from "../../react/types/citations";

let available = false;
let createdItemIds: string[] = [];

beforeAll(async () => {
  available = await isZoteroAvailable();
});

beforeEach((ctx) => {
  skipIfNoZotero(ctx, available);
  createdItemIds = [];
});

afterEach(async () => {
  if (!available || createdItemIds.length === 0) return;
  await post("/beaver/delete-items", { item_ids: createdItemIds });
  createdItemIds = [];
});

interface AnnotationCreateResponse {
  ok: boolean;
  reference?: { library_id: number; zotero_key: string };
  annotation?: {
    item_id: number;
    library_id: number;
    zotero_key: string;
    parent_id: number;
    annotationType: string;
    annotationText: string;
    annotationComment: string;
    annotationColor: string;
    annotationPageLabel: string;
    annotationSortIndex: string;
    annotationAuthorName: string;
    annotationPosition: { pageIndex: number; rects: number[][] };
  };
  geometry?: {
    viewBox: [number, number, number, number];
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
  } | null;
  reader_visible?: boolean | null;
  code?: string;
  reason?: string;
  message?: string;
  error?: string;
}

const highlightBox = {
  l: 10,
  t: 20,
  r: 110,
  b: 50,
  coord_origin: CoordOrigin.TOPLEFT,
};

function annotationId(ref: { library_id: number; zotero_key: string }): string {
  return `${ref.library_id}-${ref.zotero_key}`;
}

async function createAnnotation(
  attachment: AttachmentFixture,
  body: Record<string, unknown>,
): Promise<AnnotationCreateResponse> {
  const res = await post<AnnotationCreateResponse>(
    "/beaver/test/annotation-create",
    {
      library_id: attachment.library_id,
      zotero_key: attachment.zotero_key,
      ...body,
    },
    { timeout: 30000 },
  );
  if (res.reference) createdItemIds.push(annotationId(res.reference));
  return res;
}

function expectSuccessfulCreate(res: AnnotationCreateResponse) {
  expect(res.ok).toBe(true);
  expect(res.reference).toBeTruthy();
  expect(res.annotation).toBeTruthy();
  expect(res.geometry).toBeTruthy();
  return {
    reference: res.reference!,
    annotation: res.annotation!,
    geometry: res.geometry!,
  };
}

function expectedHighlightRect(
  geometry: NonNullable<AnnotationCreateResponse["geometry"]>,
) {
  const [viewBoxX, viewBoxY] = geometry.viewBox;
  expect(geometry.rotation).toBe(0);
  return [
    highlightBox.l + viewBoxX,
    geometry.height - highlightBox.b + viewBoxY,
    highlightBox.r + viewBoxX,
    geometry.height - highlightBox.t + viewBoxY,
  ];
}

describe("headless annotation creation primitives", () => {
  it("creates a cache-hit highlight annotation item", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );
    const parent = await resolveItem(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "headless highlight",
        color: "yellow",
        comment: "created by live test",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);

    expect(annotation.parent_id).toBe(parent.item_id);
    expect(annotation.annotationType).toBe("highlight");
    expect(annotation.annotationText).toBe("headless highlight");
    expect(annotation.annotationComment).toBe("created by live test");
    expect(annotation.annotationAuthorName).toBe("Beaver");
    expect(annotation.annotationSortIndex).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
    expect(annotation.annotationPosition).toEqual({
      pageIndex: 0,
      rects: [expectedHighlightRect(geometry)],
    });
  }, 30000);

  it("creates a cache-hit note annotation item", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );
    const parent = await resolveItem(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "note",
      input: {
        notePosition: {
          page_index: 0,
          side: "left",
          x: 0,
          y: 100,
          coord_origin: CoordOrigin.TOPLEFT,
        },
        comment: "headless note",
        color: "blue",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);
    const [viewBoxX, viewBoxY] = geometry.viewBox;

    expect(geometry.rotation).toBe(0);
    expect(annotation.parent_id).toBe(parent.item_id);
    expect(annotation.annotationType).toBe("note");
    expect(annotation.annotationComment).toBe("headless note");
    expect(annotation.annotationAuthorName).toBe("Beaver");
    expect(annotation.annotationSortIndex).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
    // y=100 in top-left coords centers the 18×18 note at y=100 → yTop=91, yBottom=109.
    // The display-frame bbox is then flipped into Zotero user space:
    //   bottom = height - 109,  top = height - 91.
    expect(annotation.annotationPosition).toEqual({
      pageIndex: 0,
      rects: [[
        12 + viewBoxX,
        geometry.height - 109 + viewBoxY,
        30 + viewBoxX,
        geometry.height - 91 + viewBoxY,
      ]],
    });
  }, 30000);

  it("refreshes metadata on a cache-miss highlight", async () => {
    await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
    expect(
      await getCacheMetadata(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key),
    ).toBeNull();

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "cache miss highlight",
      },
    });
    const { annotation } = expectSuccessfulCreate(res);

    expect(annotation.annotationType).toBe("highlight");
    expect(
      await getCacheMetadata(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key),
    ).not.toBeNull();
  }, 30000);

  it("uses no-text-layer cached geometry when available", async (ctx) => {
    await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);

    const res = await createAnnotation(NO_TEXT_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "ocr geometry highlight",
      },
    });

    if (!res.ok) {
      const record = await getCacheMetadata(
        NO_TEXT_PDF.library_id,
        NO_TEXT_PDF.zotero_key,
      );
      if (record?.errorCode === "no_text_layer") {
        ctx.skip();
      }
    }

    const { annotation } = expectSuccessfulCreate(res);
    expect(annotation.annotationType).toBe("highlight");
  }, 30000);

  it("reports missing geometry when the attachment file is unavailable", async (ctx) => {
    const res = await createAnnotation(MISSING_FILE_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "missing file highlight",
      },
    });

    if (res.error === "not_found") ctx.skip();
    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_page_geometry");
    expect(res.reason).toBe("unavailable");
  }, 30000);

  it("rejects remote pseudo-path attachments in v1", async () => {
    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      force_file_path: "remote:h:test-synced-hash",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "remote highlight",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_page_geometry");
    expect(res.reason).toBe("unavailable");
    expect(res.message).toContain("remote attachment not supported in v1");
  }, 30000);

  it("appears in an open reader through Zotero notifier refresh", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      open_reader: true,
      check_reader: true,
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "reader refresh highlight",
      },
    });

    expectSuccessfulCreate(res);
    expect(res.reader_visible).toBe(true);
  }, 30000);

  it("creates a multi-box highlight whose rects share the page index sort prefix", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const boxes = [
      { l: 10, t: 20, r: 110, b: 40, coord_origin: CoordOrigin.TOPLEFT },
      { l: 12, t: 60, r: 120, b: 80, coord_origin: CoordOrigin.TOPLEFT },
    ];
    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes,
        text: "multi box highlight",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);

    expect(annotation.annotationPosition.rects).toHaveLength(2);
    // Sort index is derived from the *first* rect — pageIndex 0, so prefix is "00000".
    expect(annotation.annotationSortIndex.startsWith("00000|")).toBe(true);

    const [viewBoxX, viewBoxY] = geometry.viewBox;
    expect(annotation.annotationPosition.rects[0]).toEqual([
      boxes[0].l + viewBoxX,
      geometry.height - boxes[0].b + viewBoxY,
      boxes[0].r + viewBoxX,
      geometry.height - boxes[0].t + viewBoxY,
    ]);
  }, 30000);

  it("honors bottom-left coord origin on highlight bboxes", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const bottomLeftBox = {
      l: 10,
      t: 50,
      r: 110,
      b: 20,
      coord_origin: CoordOrigin.BOTTOMLEFT,
    };
    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [bottomLeftBox],
        text: "bottom-left highlight",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);
    const [viewBoxX, viewBoxY] = geometry.viewBox;

    // Bottom-left edges land in Zotero user space without the height flip.
    expect(annotation.annotationPosition.rects).toEqual([
      [
        bottomLeftBox.l + viewBoxX,
        bottomLeftBox.b + viewBoxY,
        bottomLeftBox.r + viewBoxX,
        bottomLeftBox.t + viewBoxY,
      ],
    ]);
  }, 30000);

  it("encodes the page index into the sort index prefix", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 3,
        boxes: [highlightBox],
        text: "page 4 highlight",
      },
    });
    const { annotation } = expectSuccessfulCreate(res);

    expect(annotation.annotationPosition.pageIndex).toBe(3);
    expect(annotation.annotationSortIndex.startsWith("00003|")).toBe(true);
    expect(annotation.annotationPageLabel).toBe("4");
  }, 30000);

  it("falls back to the default highlight color for unknown color names", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "default color highlight",
        color: "chartreuse",
      },
    });
    const { annotation } = expectSuccessfulCreate(res);
    expect(annotation.annotationColor.toLowerCase()).toBe("#ffd400");
  }, 30000);

  it("anchors a right-side note inside the page bounds", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "note",
      input: {
        notePosition: {
          page_index: 0,
          side: "right",
          x: 0,
          y: 150,
          coord_origin: CoordOrigin.TOPLEFT,
        },
        comment: "right side note",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);
    const [viewBoxX, viewBoxY] = geometry.viewBox;

    const expectedX = geometry.width - 18 - 12;
    expect(annotation.annotationPosition.rects).toEqual([
      [
        expectedX + viewBoxX,
        geometry.height - 159 + viewBoxY,
        expectedX + 18 + viewBoxX,
        geometry.height - 141 + viewBoxY,
      ],
    ]);
  }, 30000);

  it("treats a bottom-left coord origin on note position correctly", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "note",
      input: {
        notePosition: {
          page_index: 0,
          side: "left",
          x: 0,
          y: 100,
          coord_origin: CoordOrigin.BOTTOMLEFT,
        },
        comment: "bottom-left note",
      },
    });
    const { annotation, geometry } = expectSuccessfulCreate(res);
    const [viewBoxX, viewBoxY] = geometry.viewBox;

    // Bottom-left origin: y is measured up from the page bottom.
    expect(annotation.annotationPosition.rects).toEqual([
      [12 + viewBoxX, 91 + viewBoxY, 30 + viewBoxX, 109 + viewBoxY],
    ]);
  }, 30000);

  it("clamps highlights with no boxes to a 'no rects' failure", async () => {
    await triggerFileStatus(
      NORMAL_PDF.library_id,
      NORMAL_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(NORMAL_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [],
        text: "no boxes highlight",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/no rects|no boxes|produced no/i);
  }, 30000);

  it("rejects out-of-range page index against the cached page count", async () => {
    await triggerFileStatus(SMALL_PDF.library_id, SMALL_PDF.zotero_key, false);
    const record = await getCacheMetadata(
      SMALL_PDF.library_id,
      SMALL_PDF.zotero_key,
    );
    expect(record?.pageCount).not.toBeNull();
    const pageCount = record!.pageCount!;

    const res = await createAnnotation(SMALL_PDF, {
      type: "highlight",
      input: {
        pageIndex: pageCount + 5,
        boxes: [highlightBox],
        text: "out of range",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_page_geometry");
    expect(res.reason).toBe("unavailable");
  }, 30000);

  it("rejects encrypted PDFs with an extraction_failed reason", async () => {
    await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);

    const res = await createAnnotation(ENCRYPTED_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "encrypted highlight",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_page_geometry");
    // Encrypted PDFs land an errorCode in the cache; the geometry lookup
    // then surfaces extraction_failed rather than the "unavailable" reason.
    expect(["extraction_failed", "unavailable"]).toContain(res.reason);
    const record = await getCacheMetadata(
      ENCRYPTED_PDF.library_id,
      ENCRYPTED_PDF.zotero_key,
    );
    expect(record?.errorCode).toBe("encrypted");
  }, 30000);

  it("rejects non-PDF attachments at the type guard", async () => {
    const res = await createAnnotation(NON_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "non-pdf highlight",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error ?? "").toMatch(/not a PDF|isPDFAttachment|not_an_attachment/i);
  }, 30000);

  it("rejects invalid request types", async () => {
    const res = await post<AnnotationCreateResponse>(
      "/beaver/test/annotation-create",
      {
        library_id: NORMAL_PDF.library_id,
        zotero_key: NORMAL_PDF.zotero_key,
        type: "scribble",
        input: { pageIndex: 0, boxes: [highlightBox], text: "" },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("highlight or note");
  }, 30000);

  it("rejects an unknown attachment", async () => {
    const res = await post<AnnotationCreateResponse>(
      "/beaver/test/annotation-create",
      {
        library_id: 1,
        zotero_key: "DEADBEEF",
        type: "highlight",
        input: { pageIndex: 0, boxes: [highlightBox], text: "" },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
  }, 30000);

  it("creates an annotation in a group library", async (ctx) => {
    const parent = await resolveItem(
      GROUP_LIB_PDF.library_id,
      GROUP_LIB_PDF.zotero_key,
    );
    if (!parent.item_id) ctx.skip();
    await triggerFileStatus(
      GROUP_LIB_PDF.library_id,
      GROUP_LIB_PDF.zotero_key,
      false,
    );

    const res = await createAnnotation(GROUP_LIB_PDF, {
      type: "highlight",
      input: {
        pageIndex: 0,
        boxes: [highlightBox],
        text: "group library highlight",
      },
    });
    const { reference, annotation } = expectSuccessfulCreate(res);
    expect(reference.library_id).toBe(GROUP_LIB_PDF.library_id);
    expect(annotation.library_id).toBe(GROUP_LIB_PDF.library_id);
  }, 30000);
});
