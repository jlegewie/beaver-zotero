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

export const REGION_FEATURE_VERSION = 2;

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
    };
    return REGION_FEATURES.map((name) => values[name]);
}
