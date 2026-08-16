import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/agentDataProvider/utils", () => ({
  getAttachmentFileStatus: vi.fn(),
}));

import { createHighlightAnnotation } from "../../../../src/services/annotations/createAnnotation";
import {
  BEAVER_ANNOTATION_AUTHOR,
  BEAVER_CITATION_ANNOTATION_AUTHOR,
  getBeaverAnnotationAuthorName,
  isBeaverAuthoredAnnotation,
} from "../../../../src/constants/annotations";
import {
  markBeaverAnnotationWrite,
  markBeaverAnnotationWriteByKey,
  wasWrittenByBeaver,
} from "../../../../src/services/annotations/beaverAnnotationRegistry";
import { CoordOrigin } from "@beaver/agent-core/types/citations";
import type { PageGeometry } from "@beaver/agent-core/extract/types";

const geometry: PageGeometry = {
  viewBox: [0, 0, 400, 600],
  width: 400,
  height: 600,
  rotation: 0,
};

const PREF_KEY = "extensions.zotero.beaver.annotationAuthorName";

/** Fields whose assignment makes Zotero mark an item's primary data loaded. */
const ANNOTATION_FIELDS = [
  "parentID",
  "annotationType",
  "annotationComment",
  "annotationColor",
  "annotationText",
  "annotationPageLabel",
  "annotationSortIndex",
  "annotationPosition",
  "annotationAuthorName",
];

let constructedItems: any[] = [];
/** Registry answer captured from inside saveTx — the notifier runs there. */
let registeredAtSave: boolean | null = null;

/** Key Zotero generates for the annotation while saving it. */
const SAVED_KEY = "SAVEDKEY1";

/**
 * Stands in for a new `Zotero.Item("annotation")`. Setting any field marks
 * primary data loaded; Zotero then refuses an identifier change, so `key` /
 * `libraryID` assigned after the first field throws. Saving generates the key.
 */
class MockAnnotationItem {
  saveTx = vi.fn(async () => {
    this.assignKeyOnSave();
    registeredAtSave = wasWrittenByBeaver(this as unknown as Zotero.Item);
  });
  save = vi.fn(async () => this.assignKeyOnSave());
  /** Set by the save, bypassing the identifier guard as Zotero's save does. */
  private assignKeyOnSave: () => void;

  constructor(public readonly itemType: string) {
    constructedItems.push(this);
    const values: Record<string, unknown> = { libraryID: 1, key: "" };
    let loaded = false;

    for (const field of ANNOTATION_FIELDS) {
      Object.defineProperty(this, field, {
        get: () => values[field],
        set: (value: unknown) => {
          loaded = true;
          values[field] = value;
        },
        configurable: true,
      });
    }
    for (const identifier of ["key", "libraryID"]) {
      Object.defineProperty(this, identifier, {
        get: () => values[identifier],
        set: (value: unknown) => {
          if (loaded) {
            throw new Error(`Cannot change ${identifier} after object is already loaded`);
          }
          values[identifier] = value;
        },
        configurable: true,
      });
    }
    this.assignKeyOnSave = () => {
      if (!values.key) values.key = SAVED_KEY;
    };
  }

  addTag(): void {}
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

function createHighlight() {
  return createHighlightAnnotation(mockAttachment(), {
    pageIndex: 0,
    boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
    text: "highlighted text",
  });
}

describe("Beaver annotation authorship", () => {
  let previousZotero: any;
  let prefs: Record<string, unknown>;
  let currentUserName: string;

  beforeEach(() => {
    vi.clearAllMocks();
    constructedItems = [];
    registeredAtSave = null;
    prefs = {};
    currentUserName = "";
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Item: MockAnnotationItem,
      DB: { inTransaction: () => false },
      Prefs: { get: (key: string) => prefs[key] },
      Users: { getCurrentName: () => currentUserName },
      Beaver: {
        documentCache: {
          getMetadata: vi.fn().mockResolvedValue({ pages: [geometry] }),
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).Zotero = previousZotero;
  });

  describe("author name", () => {
    it("falls back to the default when the preference is unset", async () => {
      await createHighlight();
      expect(constructedItems[0].annotationAuthorName).toBe(BEAVER_ANNOTATION_AUTHOR);
    });

    it("stamps the configured author name", async () => {
      prefs[PREF_KEY] = "  Research Assistant  ";
      await createHighlight();
      expect(constructedItems[0].annotationAuthorName).toBe("Research Assistant");
    });

    it("leaves the author empty when the preference is cleared", async () => {
      prefs[PREF_KEY] = "";
      await createHighlight();
      expect(constructedItems[0].annotationAuthorName).toBe("");
      expect(getBeaverAnnotationAuthorName()).toBe("");
    });
  });

  describe("write registry", () => {
    it("records the annotation before saving it", async () => {
      prefs[PREF_KEY] = "";
      await createHighlight();
      // Observers run inside saveTx; a record made afterwards is too late.
      expect(registeredAtSave).toBe(true);
    });

    it("leaves the annotation's identifiers to Zotero", async () => {
      // Zotero refuses an identifier change once a field has been set.
      const reference = await createHighlight();
      expect(constructedItems[0].saveTx).toHaveBeenCalledTimes(1);
      expect(reference.zotero_key).toBe(SAVED_KEY);
    });

    it("does not claim annotations Beaver never wrote", () => {
      const beaverItem = new MockAnnotationItem("annotation") as unknown as Zotero.Item;
      const userItem = new MockAnnotationItem("annotation") as unknown as Zotero.Item;
      markBeaverAnnotationWrite(beaverItem);
      expect(wasWrittenByBeaver(beaverItem)).toBe(true);
      expect(wasWrittenByBeaver(userItem)).toBe(false);
    });

    it("matches a reader write by library and key", () => {
      markBeaverAnnotationWriteByKey(1, "BEAVERKEY");
      const item = new MockAnnotationItem("annotation") as unknown as Zotero.Item;
      (item as unknown as { key: string }).key = "BEAVERKEY";
      expect(wasWrittenByBeaver(item)).toBe(true);

      const otherLibraryItem = new MockAnnotationItem("annotation") as any;
      otherLibraryItem.key = "BEAVERKEY";
      otherLibraryItem.libraryID = 2;
      expect(wasWrittenByBeaver(otherLibraryItem)).toBe(false);
    });

    it("stops matching a reader write once the retention window passes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
      markBeaverAnnotationWriteByKey(1, "BEAVERKEY");
      const item = new MockAnnotationItem("annotation") as any;
      item.key = "BEAVERKEY";

      vi.setSystemTime(new Date("2026-08-16T12:04:00Z"));
      expect(wasWrittenByBeaver(item)).toBe(true);
      vi.setSystemTime(new Date("2026-08-16T12:06:00Z"));
      expect(wasWrittenByBeaver(item)).toBe(false);
    });

    it("evicts the oldest reader writes once the cap is reached", () => {
      markBeaverAnnotationWriteByKey(1, "OLDESTKEY");
      for (let i = 0; i < 500; i++) {
        markBeaverAnnotationWriteByKey(1, `KEY${i}`);
      }
      const oldest = new MockAnnotationItem("annotation") as any;
      oldest.key = "OLDESTKEY";
      const newest = new MockAnnotationItem("annotation") as any;
      newest.key = "KEY499";

      expect(wasWrittenByBeaver(oldest)).toBe(false);
      expect(wasWrittenByBeaver(newest)).toBe(true);
    });
  });

  describe("isBeaverAuthoredAnnotation", () => {
    it("matches the built-in names even after the author is renamed", () => {
      prefs[PREF_KEY] = "";
      expect(isBeaverAuthoredAnnotation(BEAVER_ANNOTATION_AUTHOR)).toBe(true);
      expect(isBeaverAuthoredAnnotation(BEAVER_CITATION_ANNOTATION_AUTHOR)).toBe(true);
    });

    it("matches the configured author name", () => {
      prefs[PREF_KEY] = "Research Assistant";
      expect(isBeaverAuthoredAnnotation("Research Assistant")).toBe(true);
    });

    it("ignores annotations with no author", () => {
      expect(isBeaverAuthoredAnnotation("")).toBe(false);
      expect(isBeaverAuthoredAnnotation(null)).toBe(false);
      expect(isBeaverAuthoredAnnotation(undefined)).toBe(false);
    });

    it("does not claim the user's own name when they configure it as the author", () => {
      // Matching that name would drop the user's own annotations from auto-attach.
      prefs[PREF_KEY] = "Ada Lovelace";
      currentUserName = "Ada Lovelace";
      expect(isBeaverAuthoredAnnotation("Ada Lovelace")).toBe(false);
    });
  });
});
