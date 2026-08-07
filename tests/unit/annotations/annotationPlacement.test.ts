import { beforeEach, describe, expect, it, vi } from "vitest";

const getReadableContentKind = vi.fn(() => "pdf");
vi.mock("../../../src/services/documentExtraction/attachmentResolution", () => ({
    getReadableContentKind: (...args: any[]) =>
        (getReadableContentKind as any)(...args),
}));

vi.mock("../../../src/utils/libraryIdentity", () => ({
    resolveLibraryRef: (ref: any) => ref?.library_id ?? null,
    modelObjectId: (libraryId: number, key: string) => `${libraryId}-${key}`,
}));

const PAGE_GEOMETRY = {
    viewBox: [0, 0, 600, 800] as const,
    width: 600,
    height: 800,
    rotation: 0,
};
const getPageGeometryForAttachment = vi.fn(async () => PAGE_GEOMETRY);
const prepareEpubAnnotationTarget = vi.fn(async () => ({
    position: { type: "FragmentSelector", value: "epubcfi(/6/4!/4/2)" },
    sortIndex: "00003|00000042",
    text: "destination text",
}));
const prepareSnapshotAnnotationTarget = vi.fn(async () => ({
    position: { type: "CssSelector", value: "#anchor" },
    sortIndex: "0000042",
    text: "destination text",
}));

vi.mock("../../../src/services/annotations/createAnnotation", async () => {
    const actual = await vi.importActual<any>(
        "../../../src/services/annotations/createAnnotation",
    );
    return {
        ...actual,
        getPageGeometryForAttachment: (...args: any[]) =>
            (getPageGeometryForAttachment as any)(...args),
        prepareEpubAnnotationTarget: (...args: any[]) =>
            (prepareEpubAnnotationTarget as any)(...args),
        prepareSnapshotAnnotationTarget: (...args: any[]) =>
            (prepareSnapshotAnnotationTarget as any)(...args),
    };
});

import { prepareRelocation } from "../../../src/services/agentDataProvider/actions/annotationPlacement";

const attachment = { id: 100, key: "ATT00001", libraryID: 1 } as any;

/** A resolved PDF destination carrying both annotation-type shapes. */
function pdfRelocation(overrides: Record<string, any> = {}) {
    return {
        loc_raw: "s12",
        content_kind: "pdf",
        attachment_ref: { library_id: 1, zotero_key: "ATT00001" },
        page_locations: [
            {
                page_idx: 4,
                boxes: [{ l: 10, t: 20, r: 300, b: 40 }],
                page_label: "5",
                reading_order_offset: 42,
            },
        ],
        note_position: { page_index: 4, x: 15, y: 30, side: "left" },
        text: "destination text",
        page_label: "5",
        reading_order_offset: 42,
        ...overrides,
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    getReadableContentKind.mockReturnValue("pdf");
    getPageGeometryForAttachment.mockResolvedValue(PAGE_GEOMETRY);
    (globalThis as any).Zotero = { debug: vi.fn() };
});

describe("prepareRelocation", () => {
    it("places a highlight over the destination's boxes", async () => {
        const placement = await prepareRelocation(
            attachment,
            "highlight",
            pdfRelocation(),
        );

        expect(placement.text).toBe("destination text");
        expect(placement.pageLabel).toBe("5");
        expect(JSON.parse(placement.position).pageIndex).toBe(4);
        expect(JSON.parse(placement.position).rects).toHaveLength(1);
    });

    it("places a note at the destination's margin anchor", async () => {
        const placement = await prepareRelocation(
            attachment,
            "note",
            pdfRelocation(),
        );

        // A note is an icon in the margin, so it carries no annotationText —
        // Zotero rejects that field on anything but a highlight.
        expect(placement.text).toBeUndefined();
        expect(JSON.parse(placement.position).pageIndex).toBe(4);
    });

    it("refuses to move a highlight to a whole page", async () => {
        // A page locator resolves for a note only, so the highlight shape is
        // absent — the same split the create tools enforce.
        await expect(
            prepareRelocation(
                attachment,
                "highlight",
                pdfRelocation({ page_locations: null, text: null }),
            ),
        ).rejects.toThrow(/whole page/);
    });

    it("refuses to apply only the first page of a multi-page highlight", async () => {
        await expect(
            prepareRelocation(
                attachment,
                "highlight",
                pdfRelocation({
                    page_locations: [
                        pdfRelocation().page_locations[0],
                        { ...pdfRelocation().page_locations[0], page_idx: 5 },
                    ],
                }),
            ),
        ).rejects.toThrow(/spans multiple pages/);
        expect(getPageGeometryForAttachment).not.toHaveBeenCalled();
    });

    it("refuses a PDF highlight destination with no extracted text", async () => {
        await expect(
            prepareRelocation(
                attachment,
                "highlight",
                pdfRelocation({ text: null }),
            ),
        ).rejects.toThrow(/no text to highlight/);
        expect(getPageGeometryForAttachment).not.toHaveBeenCalled();
    });

    it("still moves a note when only the page is named", async () => {
        const placement = await prepareRelocation(
            attachment,
            "note",
            pdfRelocation({ page_locations: null, text: null }),
        );

        expect(placement.position).toContain('"pageIndex":4');
    });

    it("rejects a destination on another attachment", async () => {
        // An annotation cannot move between documents, and the coordinates
        // would come from the wrong page frame.
        await expect(
            prepareRelocation(
                attachment,
                "highlight",
                pdfRelocation({
                    attachment_ref: { library_id: 1, zotero_key: "OTHER123" },
                }),
            ),
        ).rejects.toThrow(/cannot move to a different document/);
    });

    it("rejects a destination resolved against a different document kind", async () => {
        getReadableContentKind.mockReturnValue("epub");

        await expect(
            prepareRelocation(attachment, "highlight", pdfRelocation()),
        ).rejects.toThrow(/not pdf/);
    });

    it("anchors an EPUB note to its block, and a highlight to the run", async () => {
        getReadableContentKind.mockReturnValue("epub");
        const relocation = {
            loc_raw: "s12",
            content_kind: "epub",
            attachment_ref: { library_id: 1, zotero_key: "ATT00001" },
            text: "destination text",
            section_href: "chapter1.xhtml",
            section_ordinal: 2,
            anchor_id: "p12",
            page_label: "7",
        } as any;

        await prepareRelocation(attachment, "note", relocation);
        expect(prepareEpubAnnotationTarget).toHaveBeenCalledWith(
            attachment,
            expect.objectContaining({ anchorToBlock: true }),
        );

        prepareEpubAnnotationTarget.mockClear();
        const placement = await prepareRelocation(
            attachment,
            "highlight",
            relocation,
        );
        expect(prepareEpubAnnotationTarget).toHaveBeenCalledWith(
            attachment,
            expect.not.objectContaining({ anchorToBlock: true }),
        );
        expect(placement.text).toBe("destination text");
        expect(placement.pageLabel).toBe("7");
    });

    it("refuses to move a highlight to a destination with no text", async () => {
        getReadableContentKind.mockReturnValue("snapshot");

        await expect(
            prepareRelocation(attachment, "highlight", {
                loc_raw: "s12",
                content_kind: "snapshot",
                attachment_ref: { library_id: 1, zotero_key: "ATT00001" },
                anchor_id: "p12",
                text: null,
            } as any),
        ).rejects.toThrow(/no text to highlight/);
    });

    it("resolves everything before the caller opens a transaction", async () => {
        // Placing a move can read the attachment and run a PDF page analysis;
        // doing that under Zotero's global write lock stalls every other write.
        await prepareRelocation(attachment, "highlight", pdfRelocation());

        expect(getPageGeometryForAttachment).toHaveBeenCalledWith(attachment, 4);
    });
});
