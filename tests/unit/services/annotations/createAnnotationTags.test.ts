import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/agentDataProvider/utils", () => ({
  getAttachmentFileStatus: vi.fn(),
}));

import {
  createHighlightAnnotation,
  createNoteAnnotation,
} from "../../../../src/services/annotations/createAnnotation";
import { normalizeAnnotationTags } from "../../../../react/types/agentActions/createAnnotations";
import { CoordOrigin } from "../../../../react/types/citations";
import type { PageGeometry } from "../../../../src/beaver-extract/types";

const geometry: PageGeometry = {
  viewBox: [0, 0, 400, 600],
  width: 400,
  height: 600,
  rotation: 0,
};

// Capture every annotation item the service constructs so tests can assert on
// the tags applied and the order relative to saveTx.
let constructedItems: MockAnnotationItem[] = [];

class MockAnnotationItem {
  key = "NEWANNOTKEY";
  tags: string[] = [];
  /** Snapshot of tags taken inside saveTx — proves tags were applied first. */
  tagsAtSave: string[] | null = null;
  saveTx = vi.fn(async () => {
    this.tagsAtSave = [...this.tags];
  });

  constructor(public readonly itemType: string) {
    constructedItems.push(this);
  }

  addTag(tag: string): void {
    this.tags.push(tag);
  }
}

function mockAttachment() {
  return {
    isPDFAttachment: () => true,
    libraryID: 1,
    id: 42,
    key: "ATT123",
    getFilePathAsync: vi.fn().mockResolvedValue("/local/path/file.pdf"),
  } as unknown as Zotero.Item;
}

describe("createAnnotation tag application", () => {
  let previousZotero: any;

  beforeEach(() => {
    vi.clearAllMocks();
    constructedItems = [];
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Item: MockAnnotationItem,
      Beaver: {
        documentCache: {
          getMetadata: vi.fn().mockResolvedValue({ pages: [geometry] }),
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
  });

  it("applies highlight tags before saveTx", async () => {
    await createHighlightAnnotation(mockAttachment(), {
      pageIndex: 0,
      boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
      text: "highlighted text",
      tags: ["methods", "important"],
    });

    expect(constructedItems).toHaveLength(1);
    expect(constructedItems[0].tags).toEqual(["methods", "important"]);
    expect(constructedItems[0].tagsAtSave).toEqual(["methods", "important"]);
    expect(constructedItems[0].saveTx).toHaveBeenCalledTimes(1);
  });

  it("applies note tags before saveTx", async () => {
    await createNoteAnnotation(mockAttachment(), {
      notePosition: {
        page_index: 0,
        side: "left",
        x: 0,
        y: 100,
        coord_origin: CoordOrigin.TOPLEFT,
      },
      comment: "a note",
      tags: ["methods"],
    });

    expect(constructedItems).toHaveLength(1);
    expect(constructedItems[0].tags).toEqual(["methods"]);
    expect(constructedItems[0].tagsAtSave).toEqual(["methods"]);
  });

  it("adds no tags when none are supplied", async () => {
    await createHighlightAnnotation(mockAttachment(), {
      pageIndex: 0,
      boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
      text: "highlighted text",
    });

    expect(constructedItems[0].tags).toEqual([]);
  });

  it("ignores an empty tags array", async () => {
    await createNoteAnnotation(mockAttachment(), {
      notePosition: {
        page_index: 0,
        side: "left",
        x: 0,
        y: 100,
        coord_origin: CoordOrigin.TOPLEFT,
      },
      comment: "a note",
      tags: [],
    });

    expect(constructedItems[0].tags).toEqual([]);
  });
});

describe("normalizeAnnotationTags", () => {
  it("returns undefined for non-array input", () => {
    expect(normalizeAnnotationTags(undefined)).toBeUndefined();
    expect(normalizeAnnotationTags(null)).toBeUndefined();
    expect(normalizeAnnotationTags("methods")).toBeUndefined();
  });

  it("trims entries and drops empty/whitespace strings", () => {
    expect(normalizeAnnotationTags(["  methods  ", "", "  ", "important"]))
      .toEqual(["methods", "important"]);
  });

  it("drops non-string entries", () => {
    expect(normalizeAnnotationTags(["methods", 5, null, { x: 1 }, "important"]))
      .toEqual(["methods", "important"]);
  });

  it("returns undefined when nothing remains after filtering", () => {
    expect(normalizeAnnotationTags(["", "   "])).toBeUndefined();
    expect(normalizeAnnotationTags([])).toBeUndefined();
  });
});
