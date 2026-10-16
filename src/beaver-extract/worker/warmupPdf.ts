/**
 * The document the `__warmup` op extracts: a generated article laid out like
 * the papers Beaver reads (a title block, two columns of body text with
 * section headings, figures with captions, page numbers), so a structured
 * extraction runs every stage of the pipeline. Pages differ in their text and
 * layout, so cross-page analysis does not treat body text as repeated
 * headers or footers.
 *
 * Built from text at runtime instead of shipping a binary: the fonts are the
 * standard Type 1 fonts every PDF reader provides, so the file needs no
 * embedded font and stays a few kilobytes of ASCII per page.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const COLUMN_GAP = 18;
const COLUMN_WIDTH = (PAGE_WIDTH - 2 * MARGIN - COLUMN_GAP) / 2;
const COLUMN_BOTTOM = MARGIN + 30;
const BODY_SIZE = 10;
const LEADING = 12;
const FIGURE_HEIGHT = 90;

const TITLE = "Neighborhood Change and Residential Mobility in Metropolitan Areas";
const AUTHORS = "A. Researcher and B. Scholar";
const ABSTRACT =
    "Abstract. This study examines how neighborhood change shapes the residential "
    + "decisions of households. Using longitudinal survey data, we show that rising "
    + "housing costs predict moves to more distant suburbs, while improvements in "
    + "local amenities reduce the probability of leaving. The results suggest that "
    + "mobility responds to both economic pressure and perceived quality of place.";

const SECTION_HEADINGS = [
    "1. Introduction",
    "2. Related Work",
    "3. Data and Measures",
    "4. Results",
    "5. Robustness Checks",
    "6. Discussion",
];

const BODY_PARAGRAPHS = [
    "Residential mobility is one of the central processes through which cities change. "
    + "When households move, they reshape the composition of the places they leave and "
    + "the places they enter. Prior research has documented large differences in moving "
    + "rates across income groups, but less is known about how changes in the "
    + "neighborhood itself influence these decisions over time.",
    "We address this question with a panel of households observed over ten years. The "
    + "data record each move together with detailed information about housing costs, "
    + "school quality, and public services. This design allows us to compare the same "
    + "household before and after its neighborhood changed, which reduces the influence "
    + "of stable differences between families.",
    "Our analysis proceeds in three steps. First, we describe how neighborhoods changed "
    + "during the study period. Second, we estimate how these changes relate to the "
    + "timing of moves. Third, we examine where movers relocate and whether their new "
    + "neighborhoods differ from the ones they left. Each step uses the same sample and "
    + "the same definitions of neighborhood boundaries.",
    "The findings have implications for housing policy. If rising costs push households "
    + "toward distant suburbs, then policies that stabilize rents may also slow the "
    + "spatial spread of metropolitan areas. If amenities keep residents in place, "
    + "investments in parks, libraries, and transit may have effects that extend well "
    + "beyond their immediate users.",
    "Earlier studies relied mostly on cross-sectional comparisons. They found that "
    + "residents of poorer areas move more often, yet they could not separate the effect "
    + "of a neighborhood from the characteristics of the people who choose to live "
    + "there. Panel data make it possible to follow the same people as their "
    + "surroundings change around them.",
    "Housing costs are measured as the median rent of the census tract in each year, "
    + "adjusted for inflation. Amenities combine the number of parks, libraries, and "
    + "transit stops within one kilometer of the residence. Both measures are "
    + "standardized so that their effects can be compared directly.",
    "A one standard deviation increase in median rent raises the annual probability of "
    + "moving by about four percentage points. The effect is larger for renters than for "
    + "owners and larger for households with children. Improvements in amenities have the "
    + "opposite sign, although the estimates are less precise.",
    "These results hold when we restrict the sample to households that did not change "
    + "their size, when we exclude the largest metropolitan areas, and when we measure "
    + "neighborhoods with smaller boundaries. They also hold when moves within the same "
    + "tract are counted as staying in place.",
];

const CAPTIONS = [
    "Figure 1. Share of households that moved within five years, by change in median "
    + "rent of the origin neighborhood.",
    "Figure 2. Distance of moves by household type. Bars show the mean distance in "
    + "kilometers for each group.",
    "Figure 3. Change in local amenities and the annual probability of moving, by "
    + "tenure and household size.",
];

/** Escape a string for a PDF literal string. */
function pdfString(text: string): string {
    return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * Break `text` into lines of at most `maxChars` characters at word
 * boundaries. Character counts stand in for glyph widths: the fonts are
 * proportional, and the limits below leave room for wide lines.
 */
function wrap(text: string, maxChars: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line && line.length + 1 + word.length > maxChars) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** A text block: lines at `leading` spacing from the baseline (`x`, `y`). */
function textBlock(font: string, size: number, x: number, y: number, leading: number, lines: string[]): string {
    const ops = [`BT /${font} ${size} Tf ${leading} TL ${x} ${y} Td`];
    lines.forEach((line, index) => {
        ops.push(index === 0 ? `${pdfString(line)} Tj` : `T* ${pdfString(line)} Tj`);
    });
    ops.push("ET");
    return ops.join("\n");
}

/** A small bar chart whose top-left corner is (`x`, `top`), with its caption below. */
function figure(x: number, top: number, index: number): string {
    const bottom = top - FIGURE_HEIGHT;
    const parts = [`0.5 w ${x} ${bottom} m ${x} ${top} l S`, `${x} ${bottom} m ${x + COLUMN_WIDTH} ${bottom} l S`];
    for (let bar = 0; bar < 5; bar++) {
        const share = 0.3 + 0.12 * ((bar + index) % 5);
        parts.push(`0.6 g ${x + 15 + bar * 40} ${bottom} 22 ${(FIGURE_HEIGHT - 10) * share} re f 0 g`);
    }
    parts.push(textBlock("F1", 8.5, x, bottom - 14, 10, wrap(CAPTIONS[index % CAPTIONS.length], 56)));
    return parts.join("\n");
}

/**
 * Page `pageIndex`'s content stream. The first page opens with the title
 * block; every page has two columns of body text that start at a different
 * paragraph, and every other page ends its right column with a figure.
 */
function pageContent(pageIndex: number): string {
    const parts: string[] = [];
    let y = PAGE_HEIGHT - MARGIN;

    if (pageIndex === 0) {
        parts.push(textBlock("F2", 16, MARGIN, y, 19, wrap(TITLE, 60)));
        y -= 2 * 19 + 4;
        parts.push(textBlock("F1", 11, MARGIN, y, 13, [AUTHORS]));
        y -= 26;
        const abstractLines = wrap(ABSTRACT, 96);
        parts.push(textBlock("F1", 9.5, MARGIN, y, 11.5, abstractLines));
        y -= abstractLines.length * 11.5 + 18;
    }

    const columnTop = y;
    const columns = [MARGIN, MARGIN + COLUMN_WIDTH + COLUMN_GAP];
    const hasFigure = pageIndex % 2 === 0;
    // The right column stops above the figure and its caption.
    const bottoms = [COLUMN_BOTTOM, hasFigure ? COLUMN_BOTTOM + FIGURE_HEIGHT + 50 : COLUMN_BOTTOM];
    let column = 0;
    y = columnTop;

    parts.push(textBlock("F2", 11, columns[0], y, 13, [SECTION_HEADINGS[pageIndex % SECTION_HEADINGS.length]]));
    y -= 13 + 6;
    // Paragraphs flow down the left column, then the right one, until both are full.
    for (let p = 0; column < columns.length; p++) {
        const lines = wrap(BODY_PARAGRAPHS[(pageIndex * 3 + p) % BODY_PARAGRAPHS.length], 46);
        let start = 0;
        while (start < lines.length && column < columns.length) {
            const room = Math.floor((y - bottoms[column]) / LEADING);
            if (room <= 0) {
                column += 1;
                y = columnTop;
                continue;
            }
            const chunk = lines.slice(start, start + room);
            parts.push(textBlock("F1", BODY_SIZE, columns[column], y, LEADING, chunk));
            y -= chunk.length * LEADING;
            start += chunk.length;
        }
        y -= 6;
    }

    if (hasFigure) parts.push(figure(columns[1], bottoms[1] - 10, pageIndex / 2));
    parts.push(textBlock("F1", 9, PAGE_WIDTH / 2 - 3, MARGIN / 2, 11, [String(pageIndex + 1)]));
    return parts.join("\n");
}

/** Build the warm-up document's bytes: `pageCount` pages (at least one). */
export function buildWarmupPdf(pageCount: number): Uint8Array {
    const pages = Math.max(1, Math.floor(pageCount));
    // Objects 1-4: catalog, page tree, fonts; then a page and its content stream per page.
    const pageRef = (index: number) => 5 + 2 * index;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${pageRef(i)} 0 R`).join(" ")}] /Count ${pages} >>`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>",
    ];
    for (let i = 0; i < pages; i++) {
        const content = pageContent(i);
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
                + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`,
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        );
    }
    // Every character is ASCII, so string offsets are byte offsets.
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}
