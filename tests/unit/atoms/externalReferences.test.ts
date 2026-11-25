import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";

const mocks = vi.hoisted(() => ({
  resolveItemReference: vi.fn(),
  findExistingReference: vi.fn(),
  loadFullItemDataWithAllTypes: vi.fn(),
}));

vi.mock("../../../src/utils/libraryIdentity", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/utils/libraryIdentity")
  >("../../../src/utils/libraryIdentity");
  return {
    ...actual,
    resolveItemReference: mocks.resolveItemReference,
  };
});

vi.mock("../../../react/utils/findExistingReference", () => ({
  findExistingReference: mocks.findExistingReference,
}));

vi.mock("../../../src/utils/zoteroUtils", () => ({
  loadFullItemDataWithAllTypes: mocks.loadFullItemDataWithAllTypes,
}));

vi.mock("@beaver/agent-core/platform/logger", () => ({
  logger: vi.fn(),
}));

import { checkExternalReferencesAtom } from "../../../react/atoms/externalReferences";
import { externalReferenceItemMappingAtom } from "@beaver/agent-core/citations/externalReferences";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";

describe("checkExternalReferencesAtom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).Zotero = {
      ...(globalThis as any).Zotero,
      Libraries: { userLibraryID: 7 },
      Groups: {
        getLibraryIDFromGroupID: vi.fn((groupID: number) =>
          groupID === 42 ? 12 : false,
        ),
      },
    };
    mocks.resolveItemReference.mockImplementation(async (ref: any) => ({
      status: "found",
      item: {
        libraryID: ref.library_ref === "u" ? 7 : 12,
        key: ref.zotero_key,
      },
    }));
    mocks.loadFullItemDataWithAllTypes.mockResolvedValue(undefined);
  });

  it("lets library_ref win over a stale numeric id when prioritizing personal items", async () => {
    const store = createStore();
    const ref: ExternalReference = {
      source: "openalex",
      source_id: "W123",
      title: "Portable identities",
      library_items: [
        {
          item_id: "group-copy",
          library_id: 1,
          library_ref: "g42",
          zotero_key: "GROUP123",
        },
        {
          item_id: "personal-copy",
          library_id: 99,
          library_ref: "u",
          zotero_key: "USER1234",
        },
      ],
    };

    await store.set(checkExternalReferencesAtom, [ref]);

    expect(mocks.resolveItemReference).toHaveBeenCalledTimes(1);
    expect(mocks.resolveItemReference).toHaveBeenCalledWith(
      expect.objectContaining({
        library_ref: "u",
        zotero_key: "USER1234",
      }),
    );
    expect(store.get(externalReferenceItemMappingAtom).W123).toMatchObject({
      library_id: 7,
      library_ref: "u",
      zotero_key: "USER1234",
    });
  });

  it("checks again when another source's snapshot finds a copy the first check missed", async () => {
    const store = createStore();
    mocks.findExistingReference.mockResolvedValue(null);
    const openalex: ExternalReference = { source: "openalex", source_id: "W9", title: "Work", library_items: [] };
    await store.set(checkExternalReferencesAtom, [openalex]);
    expect(store.get(externalReferenceItemMappingAtom).W9).toBeNull();

    const combined: ExternalReference = {
      ...openalex,
      source: "pubmed",
      identifiers: { pmid: "41234567" },
      library_items: [{ item_id: "", library_id: 7, library_ref: "u", zotero_key: "PMIDCOPY" }],
    };
    await store.set(checkExternalReferencesAtom, [combined]);
    expect(store.get(externalReferenceItemMappingAtom).W9).toMatchObject({ zotero_key: "PMIDCOPY" });

    // A record that still lists no copy keeps the cached answer.
    mocks.findExistingReference.mockClear();
    await store.set(checkExternalReferencesAtom, [openalex]);
    expect(mocks.findExistingReference).not.toHaveBeenCalled();
  });

  // Reopening a thread starts the search and maps its applied imports while it
  // runs; a search that finds nothing must not erase that.
  it("keeps an item recorded while the search ran when the search finds nothing", async () => {
    const store = createStore();
    let finishSearch: (value: null) => void = () => {};
    mocks.findExistingReference.mockReturnValue(new Promise((resolve) => { finishSearch = resolve; }));
    const page: ExternalReference = { source: "exa", source_id: "web-NR67MTOGP2", url: "https://www.ipcc.ch/report.pdf" };

    const checking = store.set(checkExternalReferencesAtom, [page]);
    store.set(externalReferenceItemMappingAtom, { "web-NR67MTOGP2": { library_id: 7, zotero_key: "KX5JEL2Z" } });
    finishSearch(null);
    await checking;

    expect(store.get(externalReferenceItemMappingAtom)["web-NR67MTOGP2"]).toMatchObject({ zotero_key: "KX5JEL2Z" });
  });
});
