/**
 * Region candidates: clusters of drawing primitives, grown over adjacent
 * non-prose text (axis labels, legends, panel letters), merged across small
 * prose-free gaps (figure panels), plus caption-anchored regions for sparse or
 * text-built figures. Candidates are classified afterwards (see `features.ts`).
 */
import { clusterRects } from "./cluster";
import { dilate, hgap, overlapFrac, rectArea, touches, unionRect, vgap, type Rect } from "./geometry";
import {
    FIGURE_CAPTION_RE,
    TABLE_CAPTION_RE,
    isCaptionLine,
    isProse,
    type Primitive,
    type PrimitiveKind,
    type RegionLine,
} from "./pageSignals";

/** Candidate merging is quadratic; beyond this the page keeps its unmerged candidates. */
const MAX_MERGE_CANDIDATES = 300;
/** Continuation lines followed below a caption's first row. */
const MAX_CAPTION_LINES = 15;
const CLUSTERED: ReadonlySet<PrimitiveKind> = new Set(["image", "mark", "glyph", "pixel", "hrule", "vrule", "box"]);

export interface Candidate {
    bbox: Rect;
    /** Indexes into `PageCandidates.primitives`. */
    members: number[];
    /** Created from a caption rather than from a primitive cluster. */
    anchored: boolean;
}

export interface PageCandidates {
    candidates: Candidate[];
    /** Primitives that took part in clustering. */
    primitives: Primitive[];
    lines: RegionLine[];
    figureCaptions: RegionLine[];
    tableCaptions: RegionLine[];
    bodySize: number;
    /** A page-sized image carries most of the page text (scan with a text layer). */
    scanned: boolean;
    width: number;
    height: number;
}

/**
 * Scan layer: page-spanning images (one page image, or full-width strips) that
 * cover most of the page and carry most of its text. Scanned pages are left to
 * OCR layout analysis; their scan images never form a candidate.
 */
function scanImages(prims: readonly Primitive[], lines: readonly RegionLine[], W: number, H: number): Set<Primitive> {
    const spanning = prims.filter(
        (p) => p.kind === "image" && (p.bbox[2] - p.bbox[0] >= 0.8 * W || p.bbox[3] - p.bbox[1] >= 0.8 * H),
    );
    const area = spanning.reduce((n, p) => n + rectArea(p.bbox), 0);
    if (area < 0.75 * W * H) return new Set();
    const totalChars = lines.reduce((n, l) => n + l.nchar, 0);
    const covered = lines.reduce(
        (n, l) => (spanning.some((p) => overlapFrac(l.bbox, p.bbox) > 0.9) ? n + l.nchar : n),
        0,
    );
    return totalChars === 0 || covered >= 0.6 * totalChars ? new Set(spanning) : new Set();
}

function dropScanAndEdges(prims: Primitive[], lines: readonly RegionLine[], W: number, H: number) {
    const scan = scanImages(prims, lines, W, H);
    const scanned = scan.size > 0;
    const edgeStrip = (r: Rect) => {
        const w = r[2] - r[0];
        const h = r[3] - r[1];
        const nearLR = r[0] < 0.06 * W || r[2] > 0.94 * W;
        const nearTB = r[1] < 0.04 * H || r[3] > 0.96 * H;
        return (
            (nearLR && w < 0.06 * W && h > 0.2 * H) ||
            (nearTB && h < 0.04 * H && w > 0.3 * W && (r[1] < 0.02 * H || r[3] > 0.98 * H))
        );
    };
    const kept = prims.filter(
        (p) =>
            !scan.has(p) &&
            !((p.kind === "image" || p.kind === "mark" || p.kind === "box") && edgeStrip(p.bbox)),
    );
    return { kept, scanned };
}

export function findCandidates(
    lines: RegionLine[],
    allPrimitives: Primitive[],
    W: number,
    H: number,
    bs: number,
): PageCandidates {
    const { kept, scanned } = dropScanAndEdges(allPrimitives, lines, W, H);
    const primitives = kept.filter((p) => CLUSTERED.has(p.kind));
    const rects = primitives.map((p) => p.bbox);
    const figureCaptions = captionBlocks(lines.filter((l) => !l.rot && FIGURE_CAPTION_RE.test(l.text)), lines, bs);
    const tableCaptions = captionBlocks(lines.filter((l) => !l.rot && TABLE_CAPTION_RE.test(l.text)), lines, bs);
    const blocks = [...figureCaptions, ...tableCaptions];
    const captionText = new Set(lines.filter((l) => blocks.some((b) => overlapFrac(l.bbox, b.bbox) > 0.6)));

    let candidates: Candidate[] = [];
    for (const group of rects.length ? clusterRects(rects, Math.max(4, 0.8 * bs)) : []) {
        let bbox = rects[group[0]];
        for (const i of group) bbox = unionRect(bbox, rects[i]);
        if (bbox[2] - bbox[0] < 12 || bbox[3] - bbox[1] < 12) continue;
        const onlyRulesOrBoxes = group.every((i) => {
            const k = primitives[i].kind;
            return k === "hrule" || k === "vrule" || k === "box";
        });
        if (onlyRulesOrBoxes && group.length <= 3) continue; // lone rules/boxes are never a region
        candidates.push({ bbox, members: group, anchored: false });
    }

    const grow = (start: Rect): Rect => {
        // Absorb touching non-prose lines: axis labels, legends, panel letters.
        let bbox = start;
        for (let round = 0; round < 4; round++) {
            let next = bbox;
            for (const l of lines) {
                if (overlapFrac(l.bbox, next) >= 0.99 || !touches(dilate(next, bs), l.bbox)) continue;
                if (isProse(l, bs) || captionText.has(l)) continue;
                if (l.words <= 8 || l.size < bs - 0.5) next = unionRect(next, l.bbox);
            }
            if (next[0] === bbox[0] && next[1] === bbox[1] && next[2] === bbox[2] && next[3] === bbox[3]) break;
            bbox = next;
        }
        return bbox;
    };
    for (const c of candidates) c.bbox = grow(c.bbox);

    if (candidates.length <= MAX_MERGE_CANDIDATES) candidates = mergeCandidates(candidates, lines, captionText, bs);

    for (const cap of figureCaptions) {
        const region = captionAnchoredRegion(cap, lines, rects, candidates, bs, H);
        if (region) candidates.push({ bbox: grow(region.bbox), members: region.members, anchored: true });
    }

    return { candidates, primitives, lines, figureCaptions, tableCaptions, bodySize: bs, scanned, width: W, height: H };
}

/**
 * Caption blocks: the caption line extended over the rest of its row (a label
 * such as "Fig. 4." is often its own text line, set left of the figure it
 * names), then down over the caption's continuation lines.
 */
function captionBlocks(caps: RegionLine[], lines: readonly RegionLine[], bs: number): RegionLine[] {
    return caps.map((cap) => {
        const out = { ...cap };
        const absorb = (l: RegionLine) => {
            out.bbox = unionRect(out.bbox, l.bbox);
            out.text = `${out.text} ${l.text}`;
            out.words += l.words;
            out.nchar += l.nchar + 1;
        };
        const sameRow = (l: RegionLine) =>
            Math.min(l.bbox[3], cap.bbox[3]) - Math.max(l.bbox[1], cap.bbox[1]) > 0.5 * (cap.bbox[3] - cap.bbox[1]);
        const row = lines
            .filter((l) => l !== cap && !l.rot && l.bbox[0] >= cap.bbox[2] - 1 && sameRow(l))
            .sort((a, b) => a.bbox[0] - b.bbox[0]);
        for (const l of row) {
            if (l.bbox[0] - out.bbox[2] > 3 * bs) break;
            absorb(l);
        }
        const below = lines
            .filter((l) => !l.rot && l.bbox[1] > cap.bbox[1] + 1 && !isCaptionLine(l) && Math.abs(l.size - cap.size) <= 1)
            .sort((a, b) => a.bbox[1] - b.bbox[1]);
        for (let n = 0; n < MAX_CAPTION_LINES; n++) {
            const lineH = out.bbox[3] - out.bbox[1];
            const next = below.find(
                (l) =>
                    l.bbox[1] > out.bbox[1] + 1 &&
                    overlapFrac(l.bbox, out.bbox) < 0.6 &&
                    l.bbox[1] - out.bbox[3] <= Math.min(0.8 * (l.bbox[3] - l.bbox[1]), lineH) &&
                    l.bbox[0] >= out.bbox[0] - bs &&
                    l.bbox[2] <= out.bbox[2] + bs,
            );
            if (!next) break;
            absorb(next);
        }
        return out;
    });
}

/**
 * Merge candidates that touch, or sit within a small gap with no prose or
 * caption line between them (stacked figures are separated by their captions).
 */
function mergeCandidates(
    candidates: Candidate[],
    lines: readonly RegionLine[],
    captionText: ReadonlySet<RegionLine>,
    bs: number,
): Candidate[] {
    const proseBetween = (a: Rect, b: Rect) => {
        const u = unionRect(a, b);
        return lines.some(
            (l) =>
                (isProse(l, bs) || captionText.has(l)) &&
                overlapFrac(l.bbox, u) > 0.5 &&
                !(overlapFrac(l.bbox, a) > 0.5 || overlapFrac(l.bbox, b) > 0.5),
        );
    };
    const out = candidates.map((c) => ({ ...c, members: [...c.members] }));
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < out.length; i++) {
            for (let j = i + 1; j < out.length; j++) {
                const a = out[i].bbox;
                const b = out[j].bbox;
                const close = vgap(a, b) < 1.5 * bs && hgap(a, b) < 3 * bs;
                if (touches(a, b) || (close && !proseBetween(a, b))) {
                    out[i] = {
                        bbox: unionRect(a, b),
                        members: out[i].members.concat(out[j].members),
                        anchored: out[i].anchored || out[j].anchored,
                    };
                    out.splice(j, 1);
                    merged = true;
                    break outer;
                }
            }
        }
    }
    return out;
}

/** Region between a figure caption and the nearest prose line, when no candidate is adjacent. */
function captionAnchoredRegion(
    cap: RegionLine,
    lines: readonly RegionLine[],
    rects: readonly Rect[],
    candidates: readonly Candidate[],
    bs: number,
    H: number,
): { bbox: Rect; members: number[] } | null {
    const cb = cap.bbox;
    if (candidates.some((c) => hgap(c.bbox, cb) < 5 && vgap(c.bbox, cb) < 4 * bs)) return null;
    for (const direction of [-1, 1]) {
        let textRegion: Rect | null = null;
        let edge = direction < 0 ? 0 : H;
        const ordered = [...lines].sort((a, b) => (direction < 0 ? b.bbox[3] - a.bbox[3] : a.bbox[1] - b.bbox[1]));
        for (const l of ordered) {
            const lb = l.bbox;
            if ((direction < 0 && lb[3] > cb[1] + 1) || (direction > 0 && lb[1] < cb[3] - 1)) continue;
            if (hgap(lb, cb) > 0 || l === cap) continue;
            if (isProse(l, bs) || isCaptionLine(l)) {
                edge = direction < 0 ? lb[3] : lb[1];
                break;
            }
            textRegion = textRegion ? unionRect(textRegion, lb) : lb;
        }
        const span: Rect = direction < 0 ? [cb[0] - 20, edge, cb[2] + 20, cb[1]] : [cb[0] - 20, cb[3], cb[2] + 20, edge];
        const members: number[] = [];
        let graphics: Rect | null = null;
        rects.forEach((r, i) => {
            if (overlapFrac(r, span) > 0.8) {
                members.push(i);
                graphics = graphics ? unionRect(graphics, r) : r;
            }
        });
        const box: Rect | null = graphics && textRegion ? unionRect(textRegion, graphics) : (graphics ?? textRegion);
        if (!box || box[3] - box[1] <= 3 * bs) continue;
        const nText = textRegion ? lines.filter((l) => overlapFrac(l.bbox, textRegion!) > 0.8).length : 0;
        if (members.length || nText >= 3) return { bbox: box, members };
    }
    return null;
}
