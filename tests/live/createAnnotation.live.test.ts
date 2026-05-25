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
  MISSING_FILE_PDF,
  NORMAL_PDF,
  NO_TEXT_PDF,
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
    expect(annotation.annotationPosition).toEqual({
      pageIndex: 0,
      rects: [[12 + viewBoxX, 100 + viewBoxY, 30 + viewBoxX, 118 + viewBoxY]],
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
});
