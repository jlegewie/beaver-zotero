import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/agentDataProvider/utils", () => ({
    checkLibraryExcluded: vi.fn(),
}));

import { checkLibraryExcluded } from "../../../src/services/agentDataProvider/utils";
import {
    handleTestCollectionCreateHttpRequest,
    handleTestCollectionDeleteHttpRequest,
} from "../../../react/hooks/httpHandlers/testCollectionHandlers";

describe("test collection handlers", () => {
    const excludedMessage = "This library is excluded from Beaver.";

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(checkLibraryExcluded).mockReturnValue({
            message: excludedMessage,
        });

        Zotero.Libraries.userLibraryID = 1;
        Zotero.Collection = vi.fn() as any;
        Zotero.Collections = { getByLibraryAndKey: vi.fn() } as any;
        Zotero.Items = { getByLibraryAndKeyAsync: vi.fn() } as any;
    });

    it("rejects an excluded library before creating or reading items", async () => {
        const response = await handleTestCollectionCreateHttpRequest({
            library_id: 42,
            name: "Test Collection",
            item_keys: ["ITEMKEY"],
        });

        expect(response).toEqual({
            ok: false,
            error: excludedMessage,
            error_code: "library_excluded",
        });
        expect(checkLibraryExcluded).toHaveBeenCalledWith(42);
        expect(Zotero.Collection).not.toHaveBeenCalled();
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it("rejects an excluded library before looking up or deleting collections", async () => {
        const response = await handleTestCollectionDeleteHttpRequest({
            library_id: 42,
            collection_keys: ["COLLKEY"],
        });

        expect(response).toEqual({
            ok: false,
            error: excludedMessage,
            error_code: "library_excluded",
        });
        expect(checkLibraryExcluded).toHaveBeenCalledWith(42);
        expect(Zotero.Collections.getByLibraryAndKey).not.toHaveBeenCalled();
    });
});
