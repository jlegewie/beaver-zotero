import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/zoteroSerializers", () => ({
    safeStub: (f: () => unknown) => f(),
    serializeAttachmentStub: () => ({}),
    serializeItemStub: () => ({}),
}));
vi.mock("../../../src/utils/libraryIdentity", () => ({
    libraryRefForLibraryID: (id: number) => (id === 7 ? "g6073928" : "u"),
}));
import {
    toValidatedMessageAttachment,
    toMessageAttachment,
} from "../../../react/types/attachments/converters";

const provider = vi.fn();
let itemTitle = "Validated title";
const item = {
    id: 4,
    libraryID: 1,
    key: "ABCDEFGH",
    attachmentContentType: "text/html",
    attachmentLinkMode: 1,
    isAttachment: () => true,
    isTopLevelItem: () => true,
    isRegularItem: () => false,
    getField: (field: string) =>
        field === "url" ? "beaver://table/example" : itemTitle,
};

beforeEach(() => {
    vi.clearAllMocks();
    itemTitle = "Validated title";
    item.libraryID = 1;
    vi.stubGlobal("Zotero", {
        Beaver: {
            data: { env: "development" },
            libraryOperations: { run: provider },
        },
        Attachments: { LINK_MODE_IMPORTED_URL: 1 },
        Items: { loadDataTypes: vi.fn().mockResolvedValue(undefined) },
        Utilities: { randomString: () => "request-id" },
    });
    provider.mockResolvedValue({
        ok: true,
        items: [
            {
                key: "u-ABCDEFGH",
                kind: "table",
                unavailable: false,
                title: "Validated title",
            },
        ],
    });
});

describe("submitted table attachments", () => {
    it("validates an explicitly selected untagged table and sends only its compact reference", async () => {
        expect(await toValidatedMessageAttachment(item as any)).toEqual({
            type: "table",
            reference: {
                kind: "table",
                key: "u-ABCDEFGH",
                title: "Validated title",
            },
        });
        expect(provider).toHaveBeenCalledWith("artifact_request", [
            {
                event: "artifact_request",
                request_id: "request-id",
                op: "list",
                keys: ["u-ABCDEFGH"],
            },
        ]);
        expect(toMessageAttachment(item as any)).toBeNull();
    });
    it("takes a fresh observation on each submission without rewriting an earlier message", async () => {
        const first = await toValidatedMessageAttachment(item as any);
        // The provider still returns the title embedded in the document.
        itemTitle = "Renamed";
        const second = await toValidatedMessageAttachment(item as any);
        expect(first).toHaveProperty("reference.title", "Validated title");
        expect(second).toHaveProperty("reference.title", "Renamed");
        expect(provider).toHaveBeenCalledTimes(2);
    });
    it("uses the validated document title when the local item title is empty", async () => {
        itemTitle = "";
        expect(await toValidatedMessageAttachment(item as any)).toHaveProperty(
            "reference.title",
            "Validated title",
        );
    });
    it.each(["library_excluded", "file_missing", "not_found", "invalid_spec"])(
        "does not submit cached metadata when the provider refuses %s",
        async (code) => {
            provider.mockResolvedValue({
                ok: true,
                items: [
                    { key: "u-ABCDEFGH", unavailable: true, error_code: code },
                ],
            });
            await expect(
                toValidatedMessageAttachment(item as any),
            ).rejects.toThrow(code);
        },
    );
    it("shows provider absence and does not silently send the snapshot as a source", async () => {
        (Zotero as any).Beaver.libraryOperations = undefined;
        await expect(toValidatedMessageAttachment(item as any)).rejects.toThrow(
            "provider unavailable",
        );
    });
    it("does not activate table attachments in production", async () => {
        (Zotero as any).Beaver.data.env = "production";
        await expect(toValidatedMessageAttachment(item as any)).rejects.toThrow(
            "not enabled",
        );
        expect(provider).not.toHaveBeenCalled();
    });
});

it("submits a group table using its portable group ID after provider validation", async () => {
    item.libraryID = 7;
    provider.mockResolvedValue({
        ok: true,
        items: [
            {
                key: "g6073928-ABCDEFGH",
                kind: "table",
                unavailable: false,
                title: "Group table",
            },
        ],
    });
    expect(await toValidatedMessageAttachment(item as any)).toMatchObject({
        type: "table",
        reference: { kind: "table", key: "g6073928-ABCDEFGH" },
    });
    expect(provider).toHaveBeenCalledWith("artifact_request", [
        expect.objectContaining({
            op: "list",
            keys: ["g6073928-ABCDEFGH"],
        }),
    ]);
});
