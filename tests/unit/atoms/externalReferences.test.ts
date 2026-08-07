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

import {
  checkExternalReferencesAtom,
  externalReferenceItemMappingAtom,
} from "../../../react/atoms/externalReferences";
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

  it("caches null when a local search confirms absence", async () => {
    mocks.findExistingReference.mockResolvedValue(null);
    const store = createStore();
    const ref: ExternalReference = {
      source: "openalex",
      source_id: "W-absent",
      title: "Missing paper",
      library_items: [],
      library_status_unknown: true,
    };

    await store.set(checkExternalReferencesAtom, [ref]);

    expect(store.get(externalReferenceItemMappingAtom)["W-absent"]).toBeNull();
  });

  it("does not cache a null absence when the local search fails", async () => {
    mocks.findExistingReference.mockRejectedValue(new Error("db locked"));
    const store = createStore();
    const ref: ExternalReference = {
      source: "openalex",
      source_id: "W-unknown",
      title: "Unchecked paper",
      library_items: [],
      library_status_unknown: true,
    };

    await store.set(checkExternalReferencesAtom, [ref]);

    expect("W-unknown" in store.get(externalReferenceItemMappingAtom)).toBe(false);
  });
});
