import { describe, expect, it } from "vitest";

import { detectRegions } from "../../../src/beaver-extract/node/api";
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "../../../src/beaver-extract/regions/features";

/**
 * A one-page PDF with body prose, a vector chart (frame, axes, curve, tick
 * labels) above its caption, and a raster photo above its caption. Built in
 * code so the fixture needs no binary file.
 */
function syntheticFigurePdf(): Uint8Array {
    const text = (x: number, y: number, size: number, s: string) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
    const prose = "Region detection needs a page with ordinary body text around the figures it finds.";
    const ops: string[] = [];
    for (let i = 0; i < 6; i++) ops.push(text(72, 740 - i * 12, 10, prose));
    // Chart: frame, axes, a curve, tick labels, axis title.
    ops.push("0.5 w 110 470 m 110 640 l 400 640 l 400 470 l h S");
    ops.push("1 w 110 470 m 400 470 l S 110 470 m 110 640 l S");
    ops.push("1 0 0 RG 1.2 w 110 480 m 170 600 230 520 290 610 c 330 630 370 560 400 590 c S 0 0 0 RG");
    for (let i = 0; i <= 5; i++) ops.push(text(104 + i * 58, 458, 7, String(i * 20)));
    for (let i = 0; i <= 4; i++) ops.push(text(92, 468 + i * 42, 7, String(i * 0.25)));
    ops.push(text(220, 446, 8, "Time in minutes"));
    ops.push(text(72, 426, 9, "Figure 1. A synthetic chart with a frame, axes and one curve."));
    // Photo: an 8x8 image drawn at 290 x 180 pt.
    ops.push("q 290 0 0 180 72 200 cm /Im1 Do Q");
    ops.push(text(72, 184, 9, "Figure 2. A synthetic photo."));
    for (let i = 0; i < 4; i++) ops.push(text(72, 150 - i * 12, 10, prose));
    const content = ops.join("\n");

    const pixels = Array.from({ length: 8 * 8 * 3 }, (_, i) => ((i * 37) % 251).toString(16).padStart(2, "0")).join("");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
            "/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// Pins the feature implementation: the shipped weights were trained on these
// exact feature semantics. A change here needs a REGION_FEATURE_VERSION bump,
// a feature re-export and retraining in the research repo.
describe("region features on a synthetic page", () => {
    it("finds the chart and the photo and pins their features", async () => {
        const result = await detectRegions({ pdfData: syntheticFigurePdf(), pageIndices: [0] });
        const page = result.pages[0];
        expect(page.error).toBeUndefined();
        expect(page.scanned).toBe(false);

        const pictures = page.candidates.filter((c) => c.label === "picture");
        expect(pictures).toHaveLength(2);

        const named = page.candidates.map((c) => ({
            bbox: c.bbox.map(Math.round),
            label: c.label,
            features: Object.fromEntries(REGION_FEATURES.map((f, i) => [f, round(c.features[i])])),
        }));
        expect({ featureVersion: REGION_FEATURE_VERSION, candidates: named }).toMatchSnapshot();
    });
});
