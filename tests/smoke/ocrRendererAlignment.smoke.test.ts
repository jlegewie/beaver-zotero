import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { extractPdf } from "../../src/beaver-extract/node/api";

it.each([90, 270])(
    "preserves sideways sentence order and source-line alignment at %i degrees",
    async (angle) => {
        const pdfData = new Uint8Array(
            await readFile(
                new URL(
                    `../fixtures/pdfs/ocr-renderer/sideways-${angle}.pdf`,
                    import.meta.url,
                ),
            ),
        );
        const r = await extractPdf({
            pdfData,
            mode: "structured",
            settings: { checkTextLayer: false },
        });
        if (r.mode !== "structured") throw new Error("expected structured");
        const sentences = r.document.pages[0].items.flatMap((i) =>
            "sentences" in i ? (i.sentences ?? []) : [],
        );
        expect(sentences.map((s) => s.text).join(" ")).toBe(
            "First second third",
        );
        const expected =
            angle === 90 ? [300, 50, 316, 300] : [284, 300, 300, 550];
        const boxes = sentences.flatMap((s) => s.bboxes);
        expect(boxes.length).toBeGreaterThan(0);
        for (const box of boxes) {
            expect(box[0]).toBeGreaterThanOrEqual(expected[0] - 2);
            expect(box[1]).toBeGreaterThanOrEqual(expected[1] - 2);
            expect(box[2]).toBeLessThanOrEqual(expected[2] + 2);
            expect(box[3]).toBeLessThanOrEqual(expected[3] + 2);
        }
    },
);
