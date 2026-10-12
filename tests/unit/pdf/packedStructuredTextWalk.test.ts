/**
 * The packed structured-text walk (`_wasm_stext_page_pack`, one copy of the
 * page per walk) must fire exactly the callbacks, with exactly the values,
 * of the per-field getter walk it replaces. Runs the real MuPDF WASM over the
 * public fixture PDFs and walks every page both ways.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureMuPDFNode } from "../../../src/beaver-extract/node/bootstrap";
import { getCachedApi, getCachedLibMuPdf } from "../../../src/beaver-extract/worker/apiCache";
import { detailedStructuredTextOptions } from "../../../src/beaver-extract/worker/docHelpers";
import type { LibMuPdf, MuPDFApi, StructuredTextLike, StructuredTextWalker } from "../../../src/beaver-extract/worker/mupdfApi";

const SHARED = join(__dirname, "../../fixtures/pdfs/extract-public/_shared");
// A born-digital paper, and a scan (image blocks, no text layer).
const PDFS = [
    { name: "d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf", minChars: 1000, minImages: 0 },
    { name: "56f5ca419d881c56b3b8715779a9c4b1f7bd4f9b085dd20c6b8d0f1f27657a0f.pdf", minChars: 0, minImages: 1 },
];

type Event = [string, ...unknown[]];

/** Every callback with its arguments, in order. */
function record(stext: StructuredTextLike, withChars: boolean): Event[] {
    const events: Event[] = [];
    const walker: StructuredTextWalker = {
        beginTextBlock: (bbox) => events.push(["beginTextBlock", bbox]),
        endTextBlock: () => events.push(["endTextBlock"]),
        beginLine: (bbox, wmode, dir) => events.push(["beginLine", bbox, wmode, dir]),
        endLine: () => events.push(["endLine"]),
        onLineFont: (font, size) => events.push(["onLineFont", font, size]),
        onImageBlock: (bbox) => events.push(["onImageBlock", bbox]),
    };
    if (withChars) {
        walker.onCharFont = (font, size) => events.push(["onCharFont", font, size]);
        walker.onCharOrigin = (x, y) => events.push(["onCharOrigin", x, y]);
        walker.onChar = (rune, quad) => events.push(["onChar", rune, quad]);
    }
    stext.walk(walker);
    return events;
}

describe("packed structured-text walk", () => {
    let lib: LibMuPdf;
    let api: MuPDFApi;

    beforeAll(async () => {
        await ensureMuPDFNode();
        lib = getCachedLibMuPdf()!;
        api = getCachedApi()!;
    });

    it("is available in the shipped WASM build", () => {
        expect(typeof lib._wasm_stext_page_pack).toBe("function");
    });

    it("descends into structure nodes", () => {
        // `segment` nests text blocks under structure nodes, which the getter
        // walk does not descend into.
        const doc = api.Document.openDocument(new Uint8Array(readFileSync(join(SHARED, PDFS[0].name))));
        const pack = lib._wasm_stext_page_pack;
        const visible = (text: string) => text.replace(/\s+/gu, "");
        try {
            let packedChars = 0;
            let getterChars = 0;
            for (let p = 0; p < doc.countPages(); p++) {
                const page = doc.loadPage(p);
                const stext = page.toStructuredText("preserve-whitespace,segment");
                try {
                    const runes = (events: Event[]) => events.filter((e) => e[0] === "onChar").map((e) => e[1] as string);
                    const packed = runes(record(stext, true));
                    lib._wasm_stext_page_pack = undefined;
                    getterChars += runes(record(stext, true)).length;
                    lib._wasm_stext_page_pack = pack;
                    packedChars += packed.length;
                    expect(visible(packed.join(""))).toBe(visible(stext.asText()));
                } finally {
                    lib._wasm_stext_page_pack = pack;
                    stext.destroy();
                    page.destroy();
                }
            }
            expect(packedChars).toBeGreaterThan(1000);
            expect(getterChars).toBeLessThan(packedChars);
        } finally {
            doc.destroy();
        }
    });

    for (const { name, minChars, minImages } of PDFS) {
        it(`matches the getter walk on every page of ${name.slice(0, 8)}`, () => {
            const doc = api.Document.openDocument(new Uint8Array(readFileSync(join(SHARED, name))));
            const pack = lib._wasm_stext_page_pack;
            try {
                let chars = 0;
                let images = 0;
                for (let p = 0; p < doc.countPages(); p++) {
                    const page = doc.loadPage(p);
                    const stext = page.toStructuredText(detailedStructuredTextOptions(true, true));
                    try {
                        for (const withChars of [true, false]) {
                            const packed = record(stext, withChars);
                            lib._wasm_stext_page_pack = undefined;
                            const getters = record(stext, withChars);
                            lib._wasm_stext_page_pack = pack;
                            expect(packed).toEqual(getters);
                            if (!withChars) continue;
                            chars += packed.filter((e) => e[0] === "onChar").length;
                            images += packed.filter((e) => e[0] === "onImageBlock").length;
                        }
                    } finally {
                        lib._wasm_stext_page_pack = pack;
                        stext.destroy();
                        page.destroy();
                    }
                }
                expect(chars).toBeGreaterThanOrEqual(minChars);
                expect(images).toBeGreaterThanOrEqual(minImages);
            } finally {
                doc.destroy();
            }
        });
    }
});
