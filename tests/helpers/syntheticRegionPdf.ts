/** Synthetic one-page PDFs for region detection, built in code so fixtures need no binary file. */

const text = (x: number, y: number, size: number, s: string) => `BT /F1 ${size} Tf ${x} ${y} Td (${s}) Tj ET`;
const PROSE = "Region detection needs a page with ordinary body text around the figures it finds.";

/**
 * A page with body prose, a vector chart (frame, axes, curve, tick labels)
 * above its caption, and a raster photo above its caption. `rotate` sets the
 * page's `/Rotate`.
 */
export function syntheticFigurePdf(rotate = 0): Uint8Array {
    const ops: string[] = [];
    for (let i = 0; i < 6; i++) ops.push(text(72, 740 - i * 12, 10, PROSE));
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
    for (let i = 0; i < 4; i++) ops.push(text(72, 150 - i * 12, 10, PROSE));
    return buildPdf(ops.join("\n"), true, rotate);
}

/**
 * A two-column page with a full-width ruled table halfway down. Each column's
 * prose is distinguishable: the left column's lines read "Left upper n" /
 * "Left lower n", the right column's "Right upper n" / "Right lower n".
 * `upsideDown` draws the whole page rotated 180 degrees. `sparse` keeps only
 * three short lines of the left column above and below the table, so the
 * table holds most of the page's text.
 */
export function syntheticSpanningTablePdf(upsideDown = false, sparse = false): Uint8Array {
    const ops: string[] = [];
    const column = (x: number, side: string, half: string, top: number, count: number) => {
        if (sparse && side === "Right") return;
        for (let i = 0; i < (sparse ? 3 : count); i++) {
            const body = sparse ? "short." : "prose that fills the column width here.";
            ops.push(text(x, top - i * 12, 10, `${side} ${half} ${i}: ${body}`));
        }
    };
    column(72, "Left", "upper", 720, 16);
    column(322, "Right", "upper", 720, 16);
    ops.push(text(72, 512, 9, "Table 1. A synthetic table spanning both columns."));
    // Booktabs-style rules and a header row plus five numeric rows in six columns.
    ops.push("0.8 w 72 502 m 540 502 l S 0.4 w 72 484 m 540 484 l S 0.8 w 72 400 m 540 400 l S");
    const cols = [72, 170, 245, 320, 395, 470];
    ["Variable", "Model 1", "Model 2", "Model 3", "Model 4", "Model 5"].forEach((h, k) => ops.push(text(cols[k], 490, 9, h)));
    for (let r = 0; r < 5; r++) {
        ops.push(text(cols[0], 470 - r * 14, 9, `Covariate ${r + 1}`));
        for (let k = 1; k < cols.length; k++) ops.push(text(cols[k], 470 - r * 14, 9, ((r + 1) * 0.137 * k).toFixed(3)));
    }
    column(72, "Left", "lower", 380, 14);
    column(322, "Right", "lower", 380, 14);
    if (upsideDown) ops.unshift("q -1 0 0 -1 612 792 cm"), ops.push("Q");
    return buildPdf(ops.join("\n"), false);
}

function buildPdf(content: string, withImage: boolean, rotate = 0): Uint8Array {
    const pixels = Array.from({ length: 8 * 8 * 3 }, (_, i) => ((i * 37) % 251).toString(16).padStart(2, "0")).join("");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotate ? ` /Rotate ${rotate}` : ""} /Contents 4 0 R ` +
            `/Resources << /Font << /F1 5 0 R >>${withImage ? " /XObject << /Im1 6 0 R >>" : ""} >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    if (withImage) {
        objects.push(
            `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
                `/Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
        );
    }
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
