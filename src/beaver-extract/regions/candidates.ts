/**
 * Region candidates from three sources:
 * - graphics: clusters of drawing primitives, grown over adjacent non-prose
 *   text (axis labels, legends, panel letters) and merged across small
 *   prose-free gaps (figure panels);
 * - caption: regions anchored on a figure caption, for sparse or text-built
 *   figures;
 * - text: groups of lines that are not running text (tables, display
 *   equations; see `textCandidates.ts`).
 * Candidates are classified afterwards (see `features.ts`).
 */
import { UnionFind, clusterRects } from "./cluster";
import { dilate, hgap, overlapFrac, rectArea, touches, unionRect, vgap, type Rect } from "./geometry";
import {
    NOTE_CAPTION_RE,
    isFigureCaption,
    isTableCaption,
    isCaptionLine,
    isProse,
    type Primitive,
    type PrimitiveKind,
    type RegionLine,
} from "./pageSignals";
import { runningTextLines, textGroups } from "./textCandidates";

/** Candidate merging is quadratic; beyond this the page keeps its unmerged candidates. */
const MAX_MERGE_CANDIDATES = 300;
/** Continuation lines followed below a caption's first row. */
const MAX_CAPTION_LINES = 15;
/** Text on one row this many em apart is in separate cells; inline math sits closer. */
const CELL_GAP_EM = 2;
const CLUSTERED: ReadonlySet<PrimitiveKind> = new Set(["image", "mark", "glyph", "pixel", "hrule", "vrule", "box"]);
/** Primitive kinds that make up table rulings rather than pictures. */
const RULE_KINDS: ReadonlySet<PrimitiveKind> = new Set(["hrule", "vrule", "box", "pixel"]);

export type CandidateSource = "graphics" | "caption" | "text";

export interface Candidate {
    bbox: Rect;
    /** Indexes into `PageCandidates.primitives`. */
    members: number[];
    /** Created from a caption rather than from a primitive cluster. */
    anchored: boolean;
    source: CandidateSource;
    /**
     * Text candidates: the grouped lines, in the group's reading frame (rotated
     * text is turned so that its lines read left to right, stacked top to bottom).
     */
    lines?: RegionLine[];
    /** Text candidates built from rotated (landscape) text. */
    rotated?: boolean;
}

export interface PageCandidates {
    candidates: Candidate[];
    /** Primitives that took part in clustering. */
    primitives: Primitive[];
    lines: RegionLine[];
    figureCaptions: RegionLine[];
    tableCaptions: RegionLine[];
    /** Notes, sources and credits (caption text without a figure or table number). */
    noteCaptions: RegionLine[];
    /** Lines of caption blocks, upright or rotated. */
    captionText: ReadonlySet<RegionLine>;
    /** Running text (prose and other wide lines of words), upright or rotated. */
    running: ReadonlySet<RegionLine>;
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
    const { figureCaptions, tableCaptions, noteCaptions, captionText } = findCaptions(lines, bs);
    // Upright running text; the page result also holds rotated running text.
    const running = runningTextLines(lines, bs);
    const pageRunning = new Set(running);
    // Rotated (landscape) text is read in its own frame, one per direction; its
    // captions and running text are found there and reported on the page lines.
    const frames = ([90, 270] as const).flatMap((rot) => {
        const source = lines.filter((l) => l.rot === rot);
        if (!source.length) return [];
        const { toFrame, toPage } = readingFrame(rot, W, H);
        const frameLines = source.map((l): RegionLine => ({ ...l, bbox: toFrame(l.bbox), rot: 0 }));
        const frameCaptions = findCaptions(frameLines, bs).captionText;
        const frameRunning = runningTextLines(frameLines, bs);
        frameLines.forEach((t, i) => {
            if (frameCaptions.has(t)) captionText.add(source[i]);
            if (frameRunning.has(t)) pageRunning.add(source[i]);
        });
        return [{ source, frameLines, frameCaptions, frameRunning, toFrame, toPage }];
    });
    const runningList = [...running];
    const captionList = [...captionText];
    const clustered = kept.filter((p) => CLUSTERED.has(p.kind));
    const primitives = clustered.filter((p) => !isContainer(p, clustered, runningList, captionList, H));
    // Text a framed figure or table may keep inside its frame: not caption text and not a
    // margin stamp. A figure's labels (legends, axis titles) are not lines of a paragraph
    // (a stack of more than `LABEL_BLOCK_LINES` running lines; a wrapped title is a short
    // stack); a table's cells may be (wrapped prose cells). `framedContent` decides which
    // of it belongs to the content.
    const frameText = lines.filter((l) => !captionText.has(l) && !l.skewed && l.bbox[3] - l.bbox[1] <= 0.5 * H);
    let labelCache: RegionLine[] | undefined;
    const frameLabels = (table: boolean): RegionLine[] => {
        if (table) return frameText;
        if (labelCache) return labelCache;
        const stacks = new UnionFind(runningList.length);
        for (let i = 0; i < runningList.length; i++) {
            const a = runningList[i];
            if (a.rot || captionText.has(a)) continue;
            for (let j = i + 1; j < runningList.length; j++) {
                const b = runningList[j];
                if (b.rot || captionText.has(b) || Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]) <= 0) continue;
                const stacked = a.bbox[3] <= b.bbox[1] + 1 || b.bbox[3] <= a.bbox[1] + 1;
                if (stacked && vgap(a.bbox, b.bbox) <= Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1])) stacks.union(i, j);
            }
        }
        const stackSize = new Map<number, number>();
        runningList.forEach((_, i) => stackSize.set(stacks.find(i), (stackSize.get(stacks.find(i)) ?? 0) + 1));
        const runningIndex = new Map(runningList.map((l, i) => [l, i]));
        const inParagraph = (l: RegionLine) => {
            const i = runningIndex.get(l);
            return i !== undefined && (stackSize.get(stacks.find(i)) ?? 1) > LABEL_BLOCK_LINES;
        };
        // Widths are judged against the frame.
        labelCache = frameText.filter((l) => !inParagraph(l));
        return labelCache;
    };
    const rects = primitives.map((p) => p.bbox);

    const clusters: Candidate[] = [];
    for (const group of rects.length ? clusterRects(rects, Math.max(4, 0.8 * bs)) : []) {
        let bbox = rects[group[0]];
        for (const i of group) bbox = unionRect(bbox, rects[i]);
        if (bbox[2] - bbox[0] < 12 || bbox[3] - bbox[1] < 12) continue;
        const onlyRulesOrBoxes = group.every((i) => {
            const k = primitives[i].kind;
            return k === "hrule" || k === "vrule" || k === "box";
        });
        if (onlyRulesOrBoxes && group.length <= 3) continue; // lone rules/boxes are never a region
        clusters.push({ bbox, members: group, anchored: false, source: "graphics" });
    }
    // A framed figure becomes its content (`framedContent`), taking the clusters set
    // inside its frame (panels inset from the frame) along.
    const inside = (outer: Rect, r: Rect) => r[0] >= outer[0] && r[1] >= outer[1] && r[2] <= outer[2] && r[3] <= outer[3];
    const absorbed = new Set<Candidate>();
    const framed = new Map<Candidate, Candidate>();
    // Only a frame with a numbered caption inside qualifies; the search for its inner
    // clusters runs once that holds.
    const numberedCaptions = [...figureCaptions, ...tableCaptions];
    for (const c of numberedCaptions.length ? clusters : []) {
        if (absorbed.has(c)) continue;
        let inner: Candidate[] = [];
        const innerOf = () => (inner = clusters.filter((o) => o !== c && !absorbed.has(o) && !framed.has(o) && inside(c.bbox, o.bbox)));
        const content = framedContent(c, innerOf, primitives, numberedCaptions, new Set(tableCaptions), frameLabels, running, bs);
        if (!content) continue;
        framed.set(c, content);
        for (const o of inner) absorbed.add(o);
    }
    let candidates: Candidate[] = clusters.filter((c) => !absorbed.has(c)).map((c) => framed.get(c) ?? c);

    const grow = (start: Rect): Rect => {
        // Absorb touching non-prose lines: axis labels, legends, panel letters.
        let bbox = start;
        for (let round = 0; round < 4; round++) {
            let next = bbox;
            for (const l of lines) {
                if (overlapFrac(l.bbox, next) >= 0.99 || !touches(dilate(next, bs), l.bbox)) continue;
                if (isProse(l, bs) || running.has(l) || captionText.has(l)) continue;
                // A line running half the page (a margin stamp) is never a figure label.
                if (l.bbox[2] - l.bbox[0] > 0.5 * W || l.bbox[3] - l.bbox[1] > 0.5 * H) continue;
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
        if (region) {
            candidates.push({ bbox: grow(region.bbox), members: region.members, anchored: true, source: "caption" });
        }
    }

    // Text inside a picture-like graphics cluster (axis labels, legends) belongs to
    // that cluster. Rulings (tables) and the few strokes of an equation (fraction
    // bars, radicals) leave their text available for grouping.
    const figureText = new Set(captionText);
    for (const c of candidates) {
        if (c.source !== "graphics" || !isPictureLike(c, primitives, bs)) continue;
        for (const l of lines) if (overlapFrac(l.bbox, c.bbox) >= 0.8) figureText.add(l);
    }
    const addGroups = (
        groupLines: RegionLine[],
        groupRunning: ReadonlySet<RegionLine>,
        groupCaptions: ReadonlySet<RegionLine>,
        prims: Primitive[],
        toPage: (r: Rect) => Rect,
        rotated: boolean,
    ) => {
        for (const g of textGroups(groupLines, figureText, groupRunning, groupCaptions, prims, bs, rotated ? H : W)) {
            const bbox = toPage(g.bbox);
            const members: number[] = [];
            rects.forEach((r, i) => {
                if (overlapFrac(r, bbox) >= 0.5) members.push(i);
            });
            candidates.push({ bbox, members, anchored: false, source: "text", lines: g.lines, rotated });
        }
    };
    addGroups(lines, running, captionText, primitives, (r) => r, false);
    for (const { source, frameLines, frameCaptions, frameRunning, toFrame, toPage } of frames) {
        frameLines.forEach((t, i) => {
            if (figureText.has(source[i])) figureText.add(t);
        });
        const framePrims = primitives.map((p) => ({
            ...p,
            bbox: toFrame(p.bbox),
            kind: p.kind === "hrule" ? ("vrule" as const) : p.kind === "vrule" ? ("hrule" as const) : p.kind,
        }));
        addGroups(frameLines, frameRunning, frameCaptions, framePrims, toPage, true);
    }

    return {
        candidates,
        primitives,
        lines,
        figureCaptions,
        tableCaptions,
        noteCaptions,
        captionText,
        running: pageRunning,
        bodySize: bs,
        scanned,
        width: W,
        height: H,
    };
}

/** Frame rules lie within this many points of the cluster's edge... */
const FRAME_EDGE = 2;
/** ...and run along at least this share of it. */
const FRAME_SPAN = 0.8;
/** Figure text inside a frame joins the drawing across gaps of at most this many body sizes. */
const FRAME_LABEL_REACH = 3;
/** A stack of more running lines than this inside a frame is a paragraph, not a (wrapped) label. */
const LABEL_BLOCK_LINES = 3;

/**
 * A cluster drawn inside its own frame (a rectangle, or rules along all four of
 * its edges) that also encloses a numbered caption (`captions`: figure and table
 * caption blocks) above or below its content — a figure or table set in a box
 * with its caption and notes: the candidate is the content inside the frame,
 * without the frame, with the clusters set inside it (`inner`: inset panels, when
 * the frame's own cluster holds drawing too) and figure text near it (`labels`:
 * legends, axis titles) on its side of the caption.
 * The caption then lies outside it, as for an unframed figure, and is not read as
 * text inside the region. Undefined when the cluster is no such frame.
 */
function framedContent(
    c: Candidate,
    inner: () => readonly Candidate[],
    prims: readonly Primitive[],
    captions: readonly RegionLine[],
    tableCaptions: ReadonlySet<RegionLine>,
    labels: (table: boolean) => readonly RegionLine[],
    running: ReadonlySet<RegionLine>,
    bs: number,
): Candidate | undefined {
    const [x0, y0, x1, y1] = c.bbox;
    const w = x1 - x0;
    const h = y1 - y0;
    const near = (a: number, b: number) => Math.abs(a - b) <= FRAME_EDGE;
    const sides = new Set<number>();
    const frame = new Set<number>();
    for (const i of c.members) {
        const p = prims[i];
        const [a0, b0, a1, b1] = p.bbox;
        if ((p.rect || p.kind === "box") && near(a0, x0) && near(b0, y0) && near(a1, x1) && near(b1, y1)) {
            for (const side of [0, 1, 2, 3]) sides.add(side);
            frame.add(i);
        } else if (p.kind === "hrule" && a1 - a0 >= FRAME_SPAN * w && (near(b0, y0) || near(b1, y1))) {
            sides.add(near(b0, y0) ? 1 : 3);
            frame.add(i);
        } else if (p.kind === "vrule" && b1 - b0 >= FRAME_SPAN * h && (near(a0, x0) || near(a1, x1))) {
            sides.add(near(a0, x0) ? 0 : 2);
            frame.add(i);
        }
    }
    if (sides.size < 4) return undefined;
    const center = (b: Rect) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const enclosed = captions.filter((l) => {
        const [cx, cy] = center(l.bbox);
        return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
    if (!enclosed.length) return undefined;
    // The drawing: the frame's other members and, when it has some, the clusters set
    // inside it (`inner`, panels further from the frame). A frame alone in its cluster
    // stays part of the figure it encloses.
    const own = c.members.filter((i) => !frame.has(i));
    if (!own.length) return undefined;
    const members = [...own, ...inner().flatMap((o) => o.members)];
    let bbox = prims[members[0]].bbox;
    for (const i of members) bbox = unionRect(bbox, prims[i].bbox);
    // Labels chain outward from the drawing, above or below it (or rotated beside it)
    // within `FRAME_LABEL_REACH` body sizes, never past a caption: text beyond it
    // continues the caption or its notes.
    const drawing = bbox;
    const sideOfDrawing = (b: Rect) =>
        enclosed.every((cap) =>
            cap.bbox[1] >= drawing[3] ? b[3] <= cap.bbox[1] : cap.bbox[3] <= drawing[1] ? b[1] >= cap.bbox[3] : true,
        );
    // Figure text: what `grow` takes (short or small labels), or a line centred on the
    // drawing along its axis (an axis title of many words), not other prose a frame holds.
    // A line standing alone, centred along the drawing and shorter than it.
    const centred = (l: RegionLine) => {
        const [cx, cy] = center(l.bbox);
        const [d0, d1] = l.rot ? [drawing[1], drawing[3]] : [drawing[0], drawing[2]];
        const [c, len] = l.rot ? [cy, l.bbox[3] - l.bbox[1]] : [cx, l.bbox[2] - l.bbox[0]];
        return Math.abs(c - (d0 + d1) / 2) <= 0.25 * (d1 - d0) && len <= 0.8 * (d1 - d0);
    };
    // A table's frame holds rows of any text (wide cells, symbols) beyond its rules.
    const table = enclosed.some((cap) => tableCaptions.has(cap));
    const figureText = (l: RegionLine) =>
        table || (!running.has(l) && !isProse(l, bs) && (l.words <= 8 || l.size < bs - 0.5)) || centred(l);
    const pool = labels(table).filter((l) => {
        const [cx, cy] = center(l.bbox);
        return (
            cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && l.bbox[2] - l.bbox[0] <= w &&
            sideOfDrawing(l.bbox) && figureText(l)
        );
    });
    // No running text stands above or below `l` beside the drawing (within its height): a
    // legend, not the head of a text column the frame also holds.
    const freeStrip = (l: RegionLine) =>
        ![...running].some(
            (r) =>
                r !== l && !r.rot &&
                Math.min(r.bbox[3], drawing[3]) - Math.max(r.bbox[1], drawing[1]) > 0 &&
                Math.min(r.bbox[2], l.bbox[2]) - Math.max(r.bbox[0], l.bbox[0]) > 0,
        );
    // Each label joins at most once, so the growth ends (a zero-size box never "overlaps").
    const taken = new Set<RegionLine>();
    for (let grew = true; grew; ) {
        grew = false;
        for (const l of pool) {
            if (taken.has(l)) continue;
            // Above or below the drawing across a wider gap, and so is an axis title set
            // along its side (rotated) or a legend beside it in a strip of the frame free of
            // running text; other text beside it joins only within a body size.
            const across = Math.min(l.bbox[2], bbox[2]) - Math.max(l.bbox[0], bbox[0]) > 0;
            const wide = table || across || l.rot || freeStrip(l);
            if (!touches(dilate(bbox, wide ? FRAME_LABEL_REACH * bs : bs), l.bbox)) continue;
            taken.add(l);
            bbox = unionRect(bbox, l.bbox);
            grew = true;
        }
    }
    // Labels set just outside the frame (an axis title against its border) belong to the
    // figure as `grow` would have taken them for the framed box: within a body size of
    // the frame, figure text by `grow`'s own test.
    for (const l of labels(table)) {
        const [cx, cy] = center(l.bbox);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) continue;
        if (running.has(l) || isProse(l, bs) || (l.words > 8 && l.size >= bs - 0.5) || l.bbox[2] - l.bbox[0] > w) continue;
        if (!touches(dilate(c.bbox, bs), l.bbox) || !sideOfDrawing(l.bbox)) continue;
        bbox = unionRect(bbox, l.bbox);
    }
    // Caption text sits between the frame and the content, above or below it; text
    // set among the drawing (labels matched as captions) is no frame's caption.
    if (enclosed.some((l) => l.bbox[3] > bbox[1] + 1 && l.bbox[1] < bbox[3] - 1)) return undefined;
    return { ...c, bbox, members };
}

/** Running-text lines a container must enclose to be a text box rather than part of a figure. */
const CONTAINER_RUNNING_LINES = 3;
/** A box holding more drawing primitives than this is a framed figure, not a text box. */
const CONTAINER_MAX_DRAWING = 8;
const DRAWING_KINDS: ReadonlySet<PrimitiveKind> = new Set(["image", "mark", "glyph"]);

/**
 * Page furniture that would chain unrelated content into one cluster: a frame
 * or filled box that holds text rather than drawing — running text (sidebars,
 * abstracts, page frames) or a caption (caption bars between stacked tables) —
 * or a column rule spanning half the page. A frame around a figure holds the
 * figure's drawing and stays part of it.
 */
function isContainer(
    p: Primitive,
    prims: readonly Primitive[],
    running: readonly RegionLine[],
    captions: readonly RegionLine[],
    H: number,
): boolean {
    if (p.kind === "vrule") return p.bbox[3] - p.bbox[1] > 0.5 * H;
    if (!p.rect && p.kind !== "box") return false;
    const inside = (b: Rect) => {
        const cx = (b[0] + b[2]) / 2;
        const cy = (b[1] + b[3]) / 2;
        return cx >= p.bbox[0] && cx <= p.bbox[2] && cy >= p.bbox[1] && cy <= p.bbox[3];
    };
    let text = captions.some((l) => inside(l.bbox));
    if (!text) {
        let n = 0;
        for (const l of running) if (inside(l.bbox) && ++n >= CONTAINER_RUNNING_LINES) break;
        text = n >= CONTAINER_RUNNING_LINES;
    }
    if (!text) return false;
    let drawing = 0;
    for (const q of prims) {
        if (q !== p && DRAWING_KINDS.has(q.kind) && inside(q.bbox) && ++drawing > CONTAINER_MAX_DRAWING) return false;
    }
    return true;
}

/**
 * Maps rotated text to a frame where it reads left to right with lines stacked
 * top to bottom, and frame boxes back to the page. Text at 90° reads down the
 * page and its lines stack leftward; text at 270° reads up and stacks rightward.
 * The frame is H wide and W tall.
 */
function readingFrame(rot: 90 | 270, W: number, H: number): { toFrame: (r: Rect) => Rect; toPage: (r: Rect) => Rect } {
    return rot === 90
        ? { toFrame: (r) => [r[1], W - r[2], r[3], W - r[0]], toPage: (r) => [W - r[3], r[0], W - r[1], r[2]] }
        : { toFrame: (r) => [H - r[3], r[0], H - r[1], r[2]], toPage: (r) => [r[1], H - r[2], r[3], H - r[0]] };
}

/**
 * A graphics cluster that is a picture rather than rulings (rules, cell borders
 * and cell fills: axis-aligned rectangles) or the strokes of an equation.
 */
function isPictureLike(c: Candidate, primitives: readonly Primitive[], bs: number): boolean {
    let other = 0;
    for (const i of c.members) {
        const p = primitives[i];
        if (p.kind === "image") return true;
        if (!RULE_KINDS.has(p.kind) && !p.rect) other++;
    }
    return other >= 6 || (other >= 2 && c.bbox[3] - c.bbox[1] > 5 * bs);
}

/**
 * Caption blocks: the caption line extended over the rest of its row (a label
 * such as "Fig. 4." is often its own text line, set left of the figure it
 * names), then down over the caption's continuation lines.
 */
/** Figure, table and note caption blocks among upright lines, and the lines they cover. */
function findCaptions(lines: readonly RegionLine[], bs: number) {
    const figureCaptions = captionBlocks(lines.filter((l) => !l.rot && isFigureCaption(l.text)), lines, bs);
    const tableCaptions = captionBlocks(lines.filter((l) => !l.rot && isTableCaption(l.text)), lines, bs);
    const noteCaptions = captionBlocks(lines.filter((l) => !l.rot && NOTE_CAPTION_RE.test(l.text)), lines, bs);
    const blocks = [...figureCaptions, ...tableCaptions, ...noteCaptions];
    const captionText = new Set(lines.filter((l) => blocks.some((b) => overlapFrac(l.bbox, b.bbox) > 0.6)));
    return { figureCaptions, tableCaptions, noteCaptions, captionText };
}

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
        // Continuation lines follow at the caption's own line spacing and height; a
        // table or figure below the caption starts after a larger gap. Caption text
        // runs one line per row: a row whose text, in the caption's span, breaks at a
        // column gap holds table cells set tight under the caption. Inline math set
        // as separate pieces sits closer.
        const capH = cap.bbox[3] - cap.bbox[1];
        const rowShared = (l: RegionLine) => {
            const row = lines
                .filter(
                    (o) =>
                        (o === l || o.source !== l.source) &&
                        !o.rot &&
                        o.bbox[0] < out.bbox[2] + bs &&
                        o.bbox[2] > out.bbox[0] - bs &&
                        Math.min(o.bbox[3], l.bbox[3]) - Math.max(o.bbox[1], l.bbox[1]) >
                            0.5 * Math.min(o.bbox[3] - o.bbox[1], l.bbox[3] - l.bbox[1]),
                )
                .sort((a, b) => a.bbox[0] - b.bbox[0]);
            return row.some(
                (o, i) => i > 0 && o.bbox[0] - Math.max(...row.slice(0, i).map((p) => p.bbox[2])) >= CELL_GAP_EM * Math.max(l.size, 1),
            );
        };
        for (let n = 0; n < MAX_CAPTION_LINES; n++) {
            const next = below.find(
                (l) =>
                    l.bbox[1] > out.bbox[1] + 1 &&
                    overlapFrac(l.bbox, out.bbox) < 0.6 &&
                    l.bbox[1] - out.bbox[3] <= 0.5 * capH &&
                    l.bbox[3] - l.bbox[1] <= 1.5 * capH &&
                    l.bbox[0] >= out.bbox[0] - bs &&
                    l.bbox[2] <= out.bbox[2] + bs,
            );
            if (!next || rowShared(next)) break;
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
                        source: "graphics",
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
