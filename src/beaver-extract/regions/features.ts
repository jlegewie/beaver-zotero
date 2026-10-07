/**
 * Candidate features for the region classifier.
 *
 * This is the only feature implementation: the research repo trains on vectors
 * exported by `beaver-extract regions` and ships weights back as
 * `regions/weights.ts`. Changing a feature's meaning or order requires bumping
 * `REGION_FEATURE_VERSION` (the model refuses mismatched weights) and retraining.
 */
import type { Candidate, PageCandidates } from "./candidates";
import { hgap, intersect, overlapFrac, rectArea, vgap, type Rect } from "./geometry";
import { NUMERIC_RE, isProse, type RegionLine } from "./pageSignals";
import { spansColumn } from "./textCandidates";

export const REGION_FEATURE_VERSION = 5;

export const REGION_FEATURES = [
    // geometry
    "area_frac", "w_frac", "h_frac", "aspect", "h_over_bs", "center_x", "center_y",
    // primitives
    "n_prims_log", "n_img", "img_cov", "n_marks_log", "n_glyph_log", "n_pixel_log", "n_rules_log",
    "hrule_frac", "vrule_frac", "n_box", "n_colors", "curve_frac", "stroke_frac", "axes", "plot_frames",
    // text inside
    "n_lines_in", "text_cov", "prose_lines_frac", "numeric_lines_frac", "rot_lines", "small_font_frac",
    "gridness",
    // context
    "fig_caption", "tab_caption", "caption_dist", "top_band", "bottom_band", "anchored",
    "scanned_page", "img_repeat_pages",
    // text candidates, equations and tables
    "src_text", "rotated_text", "rect_frac", "math_frac", "eq_numbers", "alpha_word_frac", "size_spread", "running_frac",
    "col_offset", "col_left", "col_width_frac", "iso_above", "iso_below", "margin_lines_frac", "full_width_lines_frac",
    "n_rows", "n_cols", "multi_cell_rows", "tab_cap_above", "fig_cap_below",
] as const;

export type RegionFeatureName = (typeof REGION_FEATURES)[number];

/** Document-level context: on how many pages each image (by data hash) is drawn. */
export interface RegionDocContext {
    imagePageCount(hash: number): number;
}

export const EMPTY_DOC_CONTEXT: RegionDocContext = { imagePageCount: () => 0 };

function captionDistance(caps: readonly RegionLine[], bbox: Rect, bs: number): number {
    let best = 99;
    for (const cap of caps) {
        const cb = cap.bbox;
        if (hgap(cb, bbox) < 5 && Math.min(bbox[2], cb[2]) - Math.max(bbox[0], cb[0]) > 0) {
            best = Math.min(best, vgap(cb, bbox) / bs);
        }
    }
    return best;
}

/** Caption block directly above (dir -1) or below (dir 1) the box, overlapping it horizontally. */
function captionAdjacent(caps: readonly RegionLine[], bbox: Rect, dir: -1 | 1, bs: number): number {
    for (const cap of caps) {
        const cb = cap.bbox;
        if (hgap(cb, bbox) > 0) continue;
        const gap = dir < 0 ? bbox[1] - cb[3] : cb[1] - bbox[3];
        if (gap >= -bs && gap <= 4 * bs) return 1;
    }
    return 0;
}

/** Text column around `x`: median extent of running lines crossing it, else the running text extent. */
function columnAt(running: readonly RegionLine[], x: number, W: number): [number, number] {
    const crossing = running.filter((l) => l.bbox[0] <= x && l.bbox[2] >= x);
    const pool = crossing.length ? crossing : running;
    if (!pool.length) return [0, W];
    const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
    return crossing.length
        ? [med(pool.map((l) => l.bbox[0])), med(pool.map((l) => l.bbox[2]))]
        : [Math.min(...pool.map((l) => l.bbox[0])), Math.max(...pool.map((l) => l.bbox[2]))];
}

/** Rows (lines grouped by vertical overlap) and left-edge columns shared by at least two lines. */
function gridShape(lines: readonly RegionLine[]): { rows: number; cols: number; multiRows: number } {
    const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1]);
    const rows: RegionLine[][] = [];
    for (const l of sorted) {
        const row = rows[rows.length - 1];
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        if (row && row.some((r) => cy >= r.bbox[1] && cy <= r.bbox[3])) row.push(l);
        else rows.push([l]);
    }
    const lefts = lines.map((l) => l.bbox[0]).sort((a, b) => a - b);
    let cols = 0;
    for (let i = 0; i < lefts.length; ) {
        let j = i;
        while (j + 1 < lefts.length && lefts[j + 1] - lefts[i] <= 3) j++;
        if (j > i) cols++;
        i = j + 1;
    }
    return { rows: rows.length, cols, multiRows: rows.filter((r) => r.length > 1).length };
}

/** Feature vector in `REGION_FEATURES` order. */
export function candidateFeatures(
    c: Candidate,
    page: PageCandidates,
    doc: RegionDocContext,
): number[] {
    const { width: W, height: H, bodySize: bs } = page;
    const bbox = c.bbox;
    const boxArea = Math.max(1, rectArea(bbox));
    const bw = bbox[2] - bbox[0];
    const bh = bbox[3] - bbox[1];
    const members = c.members.map((i) => page.primitives[i]);
    const n = Math.max(1, members.length);
    const count = (kind: string) => members.reduce((k, m) => (m.kind === kind ? k + 1 : k), 0);

    let imageArea = 0;
    let imgRepeat = 0;
    const colors = new Set<number>();
    let curves = 0;
    let strokes = 0;
    for (const m of members) {
        if (m.kind === "image") {
            imageArea += rectArea(intersect(m.bbox, bbox));
            imgRepeat = Math.max(imgRepeat, doc.imagePageCount(m.imageHash));
        }
        if (m.rgb >= 0) colors.add(m.rgb);
        if (m.curve) curves++;
        if (m.stroked) strokes++;
    }

    const inside = page.lines.filter((l) => overlapFrac(l.bbox, bbox) > 0.6);
    const nIn = Math.max(1, inside.length);
    const ys = inside.filter((l) => !l.rot).map((l) => Math.round((l.bbox[1] + l.bbox[3]) / 2)).sort((a, b) => a - b);
    const aligned = ys.filter((y, i) => (i > 0 && Math.abs(ys[i - 1] - y) <= 1) || (i + 1 < ys.length && Math.abs(ys[i + 1] - y) <= 1)).length;
    // Chart axes: a long horizontal and a long vertical line meeting near one corner
    // (not a table grid: tables rarely end their rules at a shared corner with no
    // rule on the opposite side). Plot frames: stroked rectangles framing a panel.
    let axes = 0;
    let plotFrames = 0;
    const hLines: Rect[] = [];
    const vLines: Rect[] = [];
    for (const m of members) {
        const mw = m.bbox[2] - m.bbox[0];
        const mh = m.bbox[3] - m.bbox[1];
        if (m.rect && m.stroked && mw > 0.25 * bw && mh > 0.2 * bh && mw > 4 * bs && mh > 3 * bs) plotFrames++;
        if (mh <= 2 && mw > 0.25 * bw && mw > 4 * bs) hLines.push(m.bbox);
        if (mw <= 2 && mh > 0.2 * bh && mh > 3 * bs) vLines.push(m.bbox);
    }
    for (const h of hLines) {
        if (vLines.some((v) => Math.abs(v[3] - h[1]) < 3 && Math.abs(v[0] - h[0]) < 3)) axes++;
    }
    const figDist = captionDistance(page.figureCaptions, bbox, bs);
    const tabDist = captionDistance(page.tableCaptions, bbox, bs);

    // Text candidates describe their own lines (rotated text in its reading frame).
    const horiz = c.source === "text" && c.lines ? c.lines : inside.filter((l) => !l.rot);
    const sum = (f: (l: RegionLine) => number) => horiz.reduce((t, l) => t + f(l), 0);
    const ink = Math.max(1, sum((l) => l.inkChars));
    const words = Math.max(1, sum((l) => l.words));
    const minSize = horiz.length ? Math.min(...horiz.map((l) => l.minSize)) : 0;
    const maxSize = horiz.length ? Math.max(...horiz.map((l) => l.maxSize)) : 0;
    // Column geometry comes from upright running text.
    const running = [...page.running].filter((l) => !l.rot);
    const [colL, colR] = columnAt(running, (bbox[0] + bbox[2]) / 2, W);
    const colW = Math.max(1, colR - colL);
    const isolation = (dir: -1 | 1) => {
        let best = 20;
        for (const l of running) {
            if (hgap(l.bbox, bbox) > 0 || overlapFrac(l.bbox, bbox) > 0.5) continue;
            const gap = dir < 0 ? bbox[1] - l.bbox[3] : l.bbox[1] - bbox[3];
            if (gap >= -1) best = Math.min(best, Math.max(0, gap) / bs);
        }
        return best;
    };
    const grid = gridShape(horiz);

    const values: Record<RegionFeatureName, number> = {
        area_frac: boxArea / (W * H),
        w_frac: bw / W,
        h_frac: bh / H,
        aspect: Math.log((bw + 1) / (bh + 1)),
        h_over_bs: Math.min(60, bh / bs),
        center_x: (bbox[0] + bbox[2]) / 2 / W,
        center_y: (bbox[1] + bbox[3]) / 2 / H,
        n_prims_log: Math.log1p(members.length),
        n_img: count("image"),
        img_cov: Math.min(1, imageArea / boxArea),
        n_marks_log: Math.log1p(count("mark")),
        n_glyph_log: Math.log1p(count("glyph")),
        n_pixel_log: Math.log1p(count("pixel")),
        n_rules_log: Math.log1p(count("hrule") + count("vrule")),
        hrule_frac: count("hrule") / n,
        vrule_frac: count("vrule") / n,
        n_box: count("box"),
        n_colors: Math.min(10, colors.size),
        curve_frac: curves / n,
        stroke_frac: strokes / n,
        axes: Math.min(10, axes),
        plot_frames: Math.min(10, plotFrames),
        n_lines_in: inside.length,
        text_cov: Math.min(1, inside.reduce((s, l) => s + rectArea(l.bbox), 0) / boxArea),
        prose_lines_frac: inside.filter((l) => isProse(l, bs)).length / nIn,
        numeric_lines_frac: inside.filter((l) => NUMERIC_RE.test(l.text)).length / nIn,
        rot_lines: inside.filter((l) => l.rot).length,
        small_font_frac: inside.filter((l) => l.size < bs - 0.5).length / nIn,
        gridness: aligned / Math.max(1, ys.length),
        fig_caption: figDist < 6 ? 1 : 0,
        tab_caption: tabDist < 6 ? 1 : 0,
        caption_dist: Math.min(figDist, 20),
        top_band: bbox[3] < 0.12 * H ? 1 : 0,
        bottom_band: bbox[1] > 0.9 * H ? 1 : 0,
        anchored: c.anchored ? 1 : 0,
        scanned_page: page.scanned ? 1 : 0,
        img_repeat_pages: Math.min(10, imgRepeat),
        src_text: c.source === "text" ? 1 : 0,
        rotated_text: c.rotated ? 1 : 0,
        rect_frac: members.filter((m) => m.rect).length / n,
        math_frac: sum((l) => l.mathChars) / ink,
        eq_numbers: Math.min(5, horiz.filter((l) => l.eqNumber).length),
        alpha_word_frac: sum((l) => l.alphaWords) / words,
        size_spread: horiz.length ? Math.min(3, (maxSize - minSize) / bs) : 0,
        running_frac: inside.filter((l) => page.running.has(l)).length / nIn,
        col_offset: ((bbox[0] + bbox[2]) / 2 - (colL + colR) / 2) / colW,
        col_left: (bbox[0] - colL) / colW,
        col_width_frac: bw / colW,
        iso_above: isolation(-1),
        iso_below: isolation(1),
        margin_lines_frac: horiz.length ? horiz.filter((l) => running.some((r) => Math.abs(r.bbox[0] - l.bbox[0]) <= 2)).length / horiz.length : 0,
        full_width_lines_frac: horiz.length
            ? horiz.filter((l) => spansColumn(l, running, 2.5 * Math.max(l.size, 1))).length / horiz.length
            : 0,
        n_rows: Math.min(60, grid.rows),
        n_cols: Math.min(20, grid.cols),
        multi_cell_rows: grid.rows ? grid.multiRows / grid.rows : 0,
        tab_cap_above: captionAdjacent(page.tableCaptions, bbox, -1, bs),
        fig_cap_below: captionAdjacent(page.figureCaptions, bbox, 1, bs),
    };
    return REGION_FEATURES.map((name) => values[name]);
}
