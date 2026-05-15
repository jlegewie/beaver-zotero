/**
 * MuPDF API wrappers (Document/Page/StructuredText/Pixmap/ColorSpace/Matrix).
 *
 * The worker is self-contained by design — these wrappers are the only
 * surface that touches libmupdf-wasm. Every routine used by orchestration
 * ops must be in this file.
 */

/**
 * Minimal type for the libmupdf WASM module. We declare only the symbols
 * actually invoked; everything else is reached through `(libmupdf as any)`
 * boundaries inside the wrappers. Full coverage of the WASM ABI is not
 * worth the engineering cost.
 */
export interface LibMuPdf {
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
    lengthBytesUTF8(str: string): number;
    stringToUTF8(str: string, ptr: number, max: number): void;
    UTF8ToString(ptr: number): string;
    _wasm_malloc(size: number): number;
    _wasm_free(ptr: number): void;
    _wasm_init_context(): void;
    _wasm_new_buffer_from_data(ptr: number, len: number): number;
    _wasm_drop_buffer(ptr: number): void;
    _wasm_buffer_get_data(ptr: number): number;
    _wasm_buffer_get_len(ptr: number): number;
    _wasm_open_document_with_buffer(magic: number, buffer: number): number;
    _wasm_drop_document(ptr: number): void;
    _wasm_count_pages(ptr: number): number;
    _wasm_lookup_metadata(ptr: number, key: number): number;
    _wasm_load_page(ptr: number, index: number): number;
    _wasm_drop_page(ptr: number): void;
    _wasm_bound_page(ptr: number, boxIdx: number): number;
    _wasm_page_label(ptr: number): number;
    _wasm_needs_password?(ptr: number): number;
    _wasm_new_stext_page_from_page(page: number, opts: number): number;
    _wasm_drop_stext_page(ptr: number): void;
    _wasm_print_stext_page_as_json(ptr: number, scale: number): number;
    _wasm_print_stext_page_as_text(ptr: number): number;
    _wasm_stext_page_get_first_block(ptr: number): number;
    _wasm_stext_block_get_type(ptr: number): number;
    _wasm_stext_block_get_bbox(ptr: number): number;
    _wasm_stext_block_get_first_line(ptr: number): number;
    _wasm_stext_block_get_next(ptr: number): number;
    _wasm_stext_line_get_bbox(ptr: number): number;
    _wasm_stext_line_get_wmode(ptr: number): number;
    _wasm_stext_line_get_dir(ptr: number): number;
    _wasm_stext_line_get_first_char(ptr: number): number;
    _wasm_stext_line_get_next(ptr: number): number;
    _wasm_stext_char_get_c(ptr: number): number;
    _wasm_stext_char_get_origin(ptr: number): number;
    _wasm_stext_char_get_font(ptr: number): number;
    _wasm_stext_char_get_size(ptr: number): number;
    _wasm_stext_char_get_quad(ptr: number): number;
    _wasm_stext_char_get_argb(ptr: number): number;
    _wasm_stext_char_get_next(ptr: number): number;
    _wasm_font_get_name(ptr: number): number;
    _wasm_font_is_bold(ptr: number): number;
    _wasm_font_is_italic(ptr: number): number;
    _wasm_search_page(page: number, needle: number, marks: number, hits: number, max: number): number;
    _wasm_new_pixmap_from_page(page: number, matrix: number, cs: number, alpha: number): number;
    _wasm_new_pixmap_from_page_contents(page: number, matrix: number, cs: number, alpha: number): number;
    _wasm_new_buffer_from_pixmap_as_png(ptr: number): number;
    _wasm_new_buffer_from_pixmap_as_jpeg(ptr: number, q: number, invertCmyk: number): number;
    _wasm_drop_pixmap(ptr: number): void;
    _wasm_pixmap_get_w(ptr: number): number;
    _wasm_pixmap_get_h(ptr: number): number;
    _wasm_pixmap_get_stride(ptr: number): number;
    _wasm_pixmap_get_n(ptr: number): number;
    _wasm_pixmap_get_alpha(ptr: number): number;
    _wasm_pixmap_get_samples(ptr: number): number;
    _wasm_device_gray(): number;
    _wasm_device_rgb(): number;
    _wasm_device_bgr(): number;
    _wasm_device_cmyk(): number;
    // ----- JS device + path-walker plumbing (used by collectFilledRects) -----
    // `_wasm_new_js_device()` creates a fz_device whose callbacks dispatch
    // into `globalThis.$libmupdf_device` (set by `installDeviceCallbacks`).
    // `_wasm_run_page_contents(page, dev, ctm, cookie)` runs the page's
    // content stream through the device, firing one JS callback per
    // drawing primitive. `_wasm_walk_path(path)` walks a path emitted by
    // a fill_path / stroke_path callback into `globalThis.$libmupdf_path_walk`.
    _wasm_new_js_device(): number;
    _wasm_run_page_contents(page: number, device: number, ctm: number, cookie: number): void;
    _wasm_walk_path(path: number): void;
    _wasm_close_device(device: number): void;
    _wasm_drop_device(device: number): void;
    _wasm_colorspace_get_type(ptr: number): number;
    _wasm_colorspace_get_n(ptr: number): number;
    _wasm_stroke_state_get_linewidth?(ptr: number): number;
    [key: string]: unknown;
}

export type MatrixTuple = [number, number, number, number, number, number];
export type RectTuple = [number, number, number, number];
export type QuadTuple = [number, number, number, number, number, number, number, number];

export interface ColorSpaceLike {
    pointer: number;
}

export interface PixmapLike {
    pointer: number;
    getWidth(): number;
    getHeight(): number;
    getStride(): number;
    getNumberOfComponents(): number;
    getAlpha(): number;
    getSamples(): Uint8Array;
    asPNG(): Uint8Array;
    asJPEG(quality?: number, invertCmyk?: boolean): Uint8Array;
    destroy(): void;
}

export interface StructuredTextWalker {
    beginTextBlock?(bbox: RectTuple): void;
    endTextBlock?(): void;
    beginLine?(bbox: RectTuple, wmode: number, dir: [number, number]): void;
    /**
     * Fires once per non-empty line, before any `onChar` for that line.
     * Reports the first character's font pointer and size — emitted once
     * here instead of per-char because every consumer treats line-level
     * font as a property of the line, not the character.
     */
    onLineFont?(fontPtr: number, size: number): void;
    endLine?(): void;
    onChar?(rune: string, quad: QuadTuple): void;
    onImageBlock?(bbox: RectTuple, transform: unknown, image: unknown): void;
}

export interface StructuredTextLike {
    pointer: number;
    asJSON(scale?: number): string;
    asText(): string;
    walk(walker: StructuredTextWalker): void;
    destroy(): void;
}

/**
 * A filled drawing primitive captured by `Page.collectFilledRects()`.
 *
 * Page-content streams emit one `fill_path` call per filled vector
 * primitive (rectangles, polygons, curves, glyph paths…). Each entry here
 * is one such call, with the path's bbox already transformed into PDF
 * page coordinates (origin top-left to match the rest of the extractor;
 * MuPDF's native space is y-up bottom-left).
 *
 * `colorspaceType` mirrors `fz_colorspace_type` (1 Gray, 2 RGB, 3 BGR,
 * 4 CMYK, 5 Lab, 6 Indexed, 7 Separation, 8 DeviceN, …). For tinted-aside
 * detection on real PDFs the value 7 (Separation) shows up often — a
 * "1.0" component is full ink saturation of a separation plate and
 * appears visibly tinted, so the detector should NOT treat it as white.
 */
export interface FillRect {
    /** Page-space axis-aligned bbox `[x0, y0, x1, y1]` (top-left origin). */
    bbox: RectTuple;
    /** Color components, length == colorspace.n */
    color: number[];
    /** `fz_colorspace_type` integer; 0 if no colorspace was reported */
    colorspaceType: number;
    /** Alpha (0-1) */
    alpha: number;
    /**
     * Whether the path renders as an axis-aligned rectangle in PAGE
     * space. Two conditions, both required: the path consists of one
     * `moveto` + three `lineto` + optional `closepath` (no curves,
     * no extra sub-paths), AND the four corner coordinates after CTM
     * transformation form a rectangle topology: exactly two distinct
     * x-values, exactly two distinct y-values, four unique vertices,
     * and every path edge horizontal or vertical within FP tolerance.
     *
     * The second condition is what keeps `filterToContainerRects`
     * from accepting diamonds, trapezoids, parallelograms, and
     * 45°-rotated rectangles as zone containers — all of those share
     * the M-L-L-L-Z shape but their corners do not line up on two
     * axes, so their axis-aligned bounding box overestimates the
     * fill's true visual footprint.
     */
    isAxisAlignedRect: boolean;
}

export interface DividerLine {
    /** Endpoints in page-space (top-left origin) after CTM transform. */
    a: [number, number];
    b: [number, number];
    /** Stroke width in page-space points, perpendicular to the segment. */
    thickness: number;
    /** Axis classification derived at probe time. */
    orientation: "horizontal" | "vertical";
    color: number[];
    colorspaceType: number;
    alpha: number;
}

export interface GraphicsLayerPrimitives {
    fills: FillRect[];
    strokes: DividerLine[];
}

export interface CollectGraphicsOptions {
    maxFills?: number;
    maxStrokes?: number;
}

export interface PageLike {
    pointer: number;
    getBounds(box?: "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox"): RectTuple;
    getLabel(): string | undefined;
    toStructuredText(options?: string): StructuredTextLike;
    toPixmap(matrix: MatrixTuple, colorspace: ColorSpaceLike, alpha?: boolean, showExtras?: boolean): PixmapLike;
    search(needle: string, maxHits?: number): QuadTuple[][];
    /**
     * Run the page's content stream through a JS device and collect every
     * `fill_path` event with its bbox in page coordinates. Used by column
     * detection to discover background-shaded display elements (tinted
     * sidebars / "facts" boxes / callouts) — text inside such a fill
     * should not merge with text outside it.
     *
     * Returned bboxes are in PDF page coordinates with the y-axis flipped
     * to match `BoundingBox` (origin top-left, y grows downward). Empty array
     * if the page has no filled paths.
     *
     * **Budget.** `maxFills` caps how many fill_path events we'll
     * actually process before bailing out. When a page exceeds the
     * budget (vector figures, glyph-as-path text, infographic
     * illustrations — DDS69CQI page 0 emits 1223 fill_path events),
     * the collector aborts: subsequent device callbacks short-circuit
     * to no-ops (no path walk, no bbox math) and the method returns an
     * empty array. The intent is correctness ("we can't reliably tell
     * a tinted aside box from one of a thousand chart primitives") as
     * much as it is performance — a chart-heavy page has no display
     * containers worth surfacing. Default 15 is a generous ceiling for
     * real content pages with sidebars/callouts (typical is 1–5).
     */
    collectFilledRects(maxFills?: number): FillRect[];
    collectGraphics(opts?: CollectGraphicsOptions): GraphicsLayerPrimitives;
    destroy(): void;
}

export interface DocumentLike {
    pointer: number;
    needsPassword(): boolean;
    countPages(): number;
    getMetadata(key: string): string | undefined;
    loadPage(index: number): PageLike;
    destroy(): void;
}

export interface DocumentStaticApi {
    openDocument(data: Uint8Array | ArrayBuffer, magic?: string): DocumentLike;
}

export interface MatrixApi {
    identity: MatrixTuple;
    scale(sx: number, sy: number): MatrixTuple;
    translate(tx: number, ty: number): MatrixTuple;
    rotate(degrees: number): MatrixTuple;
    concat(one: MatrixTuple, two: MatrixTuple): MatrixTuple;
}

export interface ColorSpacePalette {
    DeviceGray: ColorSpaceLike;
    DeviceRGB: ColorSpaceLike;
    DeviceBGR: ColorSpaceLike;
    DeviceCMYK: ColorSpaceLike;
}

/**
 * Direct accessors over a font pointer produced by the structured-text
 * walker. The walker passes `fontPtr` (a wasm pointer) to its `onChar`
 * callback; consumers that want family/weight/style without parsing the
 * full JSON serializer use these wrappers.
 */
export interface FontApi {
    getName(fontPtr: number): string;
    isBold(fontPtr: number): boolean;
    isItalic(fontPtr: number): boolean;
}

export interface MuPDFApi {
    Document: DocumentStaticApi;
    Matrix: MatrixApi;
    ColorSpace: ColorSpacePalette;
    Font: FontApi;
}

/**
 * Path-walker callback table. The WASM bridge calls these for every
 * segment of a `_wasm_walk_path` invocation. The active collector is
 * keyed by module-level state — one path walk in flight at a time.
 */
interface PathWalkerCallbacks {
    moveto?(arg: number, x: number, y: number): void;
    lineto?(arg: number, x: number, y: number): void;
    curveto?(arg: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
    closepath?(arg: number): void;
}

/**
 * Device callback table — fz_device's vtable, dispatched into JS by the
 * WASM bridge. We only set the callbacks we use; the rest must still
 * exist as no-ops because the WASM bridge will dereference them
 * unconditionally during page run.
 *
 * Layouts mirror the wasm bundle's EM_JS bindings (see
 * `addon/content/lib/mupdf-wasm.mjs`). The first arg `_` is the device
 * user data pointer (unused — we key off the active collector instead).
 */
interface DeviceCallbacks {
    close_device(devRef: number): void;
    drop_device(devRef: number): void;
    fill_path(
        devRef: number,
        pathPtr: number,
        evenOdd: number,
        ctmPtr: number,
        csPtr: number,
        csN: number,
        colorPtr: number,
        alpha: number,
    ): void;
    stroke_path(
        devRef: number,
        pathPtr: number,
        strokeStatePtr: number,
        ctmPtr: number,
        csPtr: number,
        csN: number,
        colorPtr: number,
        alpha: number,
    ): void;
    clip_path(...args: number[]): void;
    clip_stroke_path(...args: number[]): void;
    fill_text(...args: number[]): void;
    stroke_text(...args: number[]): void;
    clip_text(...args: number[]): void;
    clip_stroke_text(...args: number[]): void;
    ignore_text(...args: number[]): void;
    fill_shade(...args: number[]): void;
    fill_image(...args: number[]): void;
    fill_image_mask(...args: number[]): void;
    clip_image_mask(...args: number[]): void;
    pop_clip(...args: number[]): void;
    begin_mask(...args: number[]): void;
    end_mask(...args: number[]): void;
    begin_group(...args: number[]): void;
    end_group(...args: number[]): void;
    begin_tile(...args: number[]): number;
    end_tile(...args: number[]): void;
    begin_layer(...args: number[]): void;
    end_layer(...args: number[]): void;
}

/**
 * Default ceiling on the number of fill_path events `collectFilledRects`
 * will process before aborting. Above this, the page is treated as a
 * figure / vector illustration / glyph-as-path render — none of those
 * carry meaningful display containers, and walking thousands of paths
 * would cost milliseconds per page for no gain.
 *
 * 15 is a generous upper bound for typical "content page with
 * sidebars/callouts" — real layouts emit 1–5 fill_path events for
 * background-tinted display boxes.
 */
export const DEFAULT_MAX_FILL_RECTS = 15;
export const DEFAULT_MAX_STROKE_LINES = 50;

/**
 * Internal collector state — populated by the device's `fill_path`
 * callback during `Page.collectFilledRects()`. Single-threaded worker,
 * so a module-level singleton is safe.
 */
interface GraphicsCollectorState {
    /** Output accumulator, populated as fill_path events fire. */
    fills: FillRect[];
    /** Output accumulator, populated as stroke_path events fire. */
    strokes: DividerLine[];
    /** Page height in points — used to flip MuPDF's y-up bbox to top-left. */
    pageHeight: number;
    /** Per-path callback scratch buffer. */
    path: Array<["M" | "L", number, number] | ["C", number, number, number, number, number, number] | ["Z"]>;
    /**
     * Total count of fill_path events seen on this page, including
     * events past the budget. Drives the abort decision.
     */
    fillsSeen: number;
    strokesSeen: number;
    /** Hard ceiling on `fillsSeen` — see `DEFAULT_MAX_FILL_RECTS`. */
    maxFills: number;
    /** Hard ceiling on `strokesSeen` — see `DEFAULT_MAX_STROKE_LINES`. */
    maxStrokes: number;
    /**
     * Once true, the callback no longer walks paths / reads colors /
     * appends to `fills`. The return path of `collectFilledRects`
     * checks this flag and discards `fills` entirely (empty result).
     */
    fillsAborted: boolean;
    strokesAborted: boolean;
}
let _activeGraphicsCollector: GraphicsCollectorState | null = null;

type PathSegment = GraphicsCollectorState["path"][number];

function sameCoord(a: number, b: number, tolerance: number): boolean {
    return Math.abs(a - b) <= tolerance;
}

function pointEquals(
    a: readonly [number, number],
    b: readonly [number, number],
    tolerance: number,
): boolean {
    return sameCoord(a[0], b[0], tolerance) && sameCoord(a[1], b[1], tolerance);
}

function addDistinct(values: number[], value: number, tolerance: number): void {
    if (!values.some((u) => sameCoord(u, value, tolerance))) values.push(value);
}

/**
 * True only when the path's first four vertices form a closed
 * axis-aligned rectangle after CTM transformation.
 */
export function isAxisAlignedRectanglePath(
    segs: ReadonlyArray<PathSegment>,
    ctm: readonly [number, number, number, number, number, number],
    tolerance = 0.25,
): boolean {
    const shapeOk =
        segs.length >= 4 &&
        segs.length <= 5 &&
        segs[0][0] === "M" &&
        segs[1][0] === "L" &&
        segs[2][0] === "L" &&
        segs[3][0] === "L" &&
        (segs.length === 4 || segs[4][0] === "Z");
    if (!shapeOk) return false;

    const [a, b, cc, d, e, f] = ctm;
    const corners: Array<[number, number]> = [];
    for (let si = 0; si < 4; si++) {
        const seg = segs[si] as ["M" | "L", number, number];
        const sx = seg[1];
        const sy = seg[2];
        corners.push([a * sx + cc * sy + e, b * sx + d * sy + f]);
    }

    const distinctX: number[] = [];
    const distinctY: number[] = [];
    for (const [x, y] of corners) {
        addDistinct(distinctX, x, tolerance);
        addDistinct(distinctY, y, tolerance);
    }
    if (distinctX.length !== 2 || distinctY.length !== 2) return false;

    for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
            if (pointEquals(corners[i], corners[j], tolerance)) return false;
        }
    }

    for (let i = 0; i < 4; i++) {
        const current = corners[i];
        const next = corners[(i + 1) % 4];
        const sameX = sameCoord(current[0], next[0], tolerance);
        const sameY = sameCoord(current[1], next[1], tolerance);
        if (sameX === sameY) return false;
    }

    return true;
}

export function isAxisAlignedLineSegment(
    segs: ReadonlyArray<PathSegment>,
    ctm: readonly [number, number, number, number, number, number],
    tolerance = 0.25,
): { orientation: "horizontal" | "vertical"; a: [number, number]; b: [number, number] } | null {
    if (
        segs.length !== 2 ||
        segs[0][0] !== "M" ||
        segs[1][0] !== "L"
    ) {
        return null;
    }
    const [aa, bb, cc, dd, ee, ff] = ctm;
    const start = segs[0] as ["M", number, number];
    const end = segs[1] as ["L", number, number];
    const a: [number, number] = [
        aa * start[1] + cc * start[2] + ee,
        bb * start[1] + dd * start[2] + ff,
    ];
    const b: [number, number] = [
        aa * end[1] + cc * end[2] + ee,
        bb * end[1] + dd * end[2] + ff,
    ];
    if (pointEquals(a, b, tolerance)) return null;
    if (sameCoord(a[1], b[1], tolerance)) {
        return { orientation: "horizontal", a, b };
    }
    if (sameCoord(a[0], b[0], tolerance)) {
        return { orientation: "vertical", a, b };
    }
    return null;
}

function readColor(
    libmupdf: LibMuPdf,
    csPtr: number,
    csN: number,
    colorPtr: number,
): { color: number[]; colorspaceType: number } {
    const color: number[] = [];
    if (colorPtr && csN > 0) {
        const cp = colorPtr >> 2;
        for (let i = 0; i < csN; i++) color.push(libmupdf.HEAPF32[cp + i]);
    }
    const colorspaceType = csPtr ? libmupdf._wasm_colorspace_get_type(csPtr) : 0;
    return { color, colorspaceType };
}

function readCtm(
    libmupdf: LibMuPdf,
    ctmPtr: number,
): [number, number, number, number, number, number] {
    const cm = ctmPtr >> 2;
    return [
        libmupdf.HEAPF32[cm + 0],
        libmupdf.HEAPF32[cm + 1],
        libmupdf.HEAPF32[cm + 2],
        libmupdf.HEAPF32[cm + 3],
        libmupdf.HEAPF32[cm + 4],
        libmupdf.HEAPF32[cm + 5],
    ];
}

function transformPoint(
    ctm: readonly [number, number, number, number, number, number],
    x: number,
    y: number,
): [number, number] {
    const [a, b, c, d, e, f] = ctm;
    return [a * x + c * y + e, b * x + d * y + f];
}

function pathSpaceStrokeThickness(
    segs: ReadonlyArray<PathSegment>,
    ctm: readonly [number, number, number, number, number, number],
    lineWidth: number,
): number {
    if (lineWidth <= 0 || segs.length < 2 || segs[0][0] !== "M" || segs[1][0] !== "L") {
        return Math.max(0, lineWidth);
    }
    const start = segs[0] as ["M", number, number];
    const end = segs[1] as ["L", number, number];
    const dx = end[1] - start[1];
    const dy = end[2] - start[2];
    const len = Math.hypot(dx, dy);
    if (len <= 0) return Math.max(0, lineWidth);
    const px = (-dy / len) * lineWidth;
    const py = (dx / len) * lineWidth;
    const p0 = transformPoint(ctm, start[1], start[2]);
    const p1 = transformPoint(ctm, start[1] + px, start[2] + py);
    return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
}

export function lineSegmentToTopLeftFrame(
    line: { orientation: "horizontal" | "vertical"; a: [number, number]; b: [number, number] },
    pageHeight: number,
): { orientation: "horizontal" | "vertical"; a: [number, number]; b: [number, number] } {
    return {
        orientation: line.orientation,
        a: [line.a[0], pageHeight - line.a[1]],
        b: [line.b[0], pageHeight - line.b[1]],
    };
}

/**
 * Install the global JS-device and path-walker callback dispatchers.
 *
 * The WASM bundle's EM_JS bindings dereference
 * `globalThis.$libmupdf_device` and `globalThis.$libmupdf_path_walk` on
 * every device call — both must exist before the first `_wasm_new_js_device()`
 * / `_wasm_walk_path()` invocation, or wasm crashes with "X is not a function".
 *
 * The dispatchers route to `_activeGraphicsCollector` when one is set
 * (during `collectGraphics`); otherwise they no-op. This keeps the
 * dispatchers permanently installed without leaking state between calls.
 */
function installCallbacks(libmupdf: LibMuPdf): void {
    const g = globalThis as unknown as {
        $libmupdf_device?: DeviceCallbacks;
        $libmupdf_path_walk?: PathWalkerCallbacks;
    };

    if (g.$libmupdf_path_walk && g.$libmupdf_device) return; // idempotent

    g.$libmupdf_path_walk = {
        moveto: (_a, x, y) => {
            const c = _activeGraphicsCollector;
            if (c) c.path.push(["M", x, y]);
        },
        lineto: (_a, x, y) => {
            const c = _activeGraphicsCollector;
            if (c) c.path.push(["L", x, y]);
        },
        curveto: (_a, x1, y1, x2, y2, x3, y3) => {
            const c = _activeGraphicsCollector;
            if (c) c.path.push(["C", x1, y1, x2, y2, x3, y3]);
        },
        closepath: (_a) => {
            const c = _activeGraphicsCollector;
            if (c) c.path.push(["Z"]);
        },
    };

    const noop = () => {};
    g.$libmupdf_device = {
        close_device: noop,
        drop_device: noop,
        fill_path: (_dev, pathPtr, _evenOdd, ctmPtr, csPtr, csN, colorPtr, alpha) => {
            const c = _activeGraphicsCollector;
            if (!c) return;
            // Hot-path early-exit. Once aborted, every subsequent
            // fill_path event short-circuits before any work
            // (no path walk, no bbox math, no allocations) — keeps
            // chart-heavy pages from billing the per-page extract
            // for a thousand JS callbacks worth of grouping work.
            if (c.fillsAborted) return;
            c.fillsSeen += 1;
            if (c.fillsSeen > c.maxFills) {
                c.fillsAborted = true;
                return;
            }
            // Walk the path *now* — pathPtr / ctmPtr live in scratch
            // buffers that MuPDF reuses across subsequent device calls,
            // so all reads must happen inside this callback.
            c.path = [];
            libmupdf._wasm_walk_path(pathPtr);
            const segs = c.path;
            if (segs.length === 0) return;

            // Local-space bbox (MuPDF user space, y-up bottom-left).
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const seg of segs) {
                if (seg[0] === "Z") continue;
                // M / L / C — every non-Z segment has (xN, yN) pairs.
                for (let i = 1; i < seg.length; i += 2) {
                    const x = seg[i] as number;
                    const y = seg[i + 1] as number;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
            if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) return;

            // Read ctm inline (HEAPF32 view, 6 floats: a b c d e f).
            const [a, b, cc, d, e, f] = readCtm(libmupdf, ctmPtr);

            // Transform the four bbox corners through the ctm and take
            // the axis-aligned envelope — handles rotated / mirrored
            // matrices (page 36's `[1,0,0,-1,0,792]` PDF y-flip; rare
            // rotated CTMs on annotated PDFs).
            const tx = (x: number, y: number): [number, number] => [a * x + cc * y + e, b * x + d * y + f];
            const c1 = tx(minX, minY);
            const c2 = tx(maxX, minY);
            const c3 = tx(minX, maxY);
            const c4 = tx(maxX, maxY);
            const px0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
            const py0Mupdf = Math.min(c1[1], c2[1], c3[1], c4[1]);
            const px1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
            const py1Mupdf = Math.max(c1[1], c2[1], c3[1], c4[1]);

            // The CTM may include the page's y-axis flip (e.g. p36's
            // `0,-1,…,792`), in which case `py*` are already in
            // top-left-origin space. If the CTM keeps MuPDF's native y-up
            // orientation (e.g. p33's `0,0,0,0,…` degenerate matrix —
            // rare encoder quirks), we still need to convert via page
            // height. Heuristic: when the transformed bbox's top sits
            // *below* the page bottom (pyMin > pageH) we're in y-up
            // space and need to flip. Otherwise pass through.
            let py0: number;
            let py1: number;
            if (py0Mupdf < 0 || py1Mupdf > c.pageHeight) {
                // Degenerate / unexpected CTM — fall back to interpreting
                // local-space coords as user space and flipping via page
                // height. This matches the typical PDF authoring
                // convention (y-up, origin bottom-left).
                py0 = c.pageHeight - maxY;
                py1 = c.pageHeight - minY;
            } else {
                py0 = py0Mupdf;
                py1 = py1Mupdf;
            }

            // Read color (csN floats) and colorspace type. csPtr may be 0
            // for "no colorspace" — typical for clipping-only paths,
            // though those route through clip_* callbacks, not fill_path.
            const { color, colorspaceType } = readColor(libmupdf, csPtr, csN, colorPtr);

            const isAxisAlignedRect = isAxisAlignedRectanglePath(segs, [a, b, cc, d, e, f]);

            c.fills.push({
                bbox: [px0, py0, px1, py1],
                color,
                colorspaceType,
                alpha,
                isAxisAlignedRect,
            });
        },
        stroke_path: (_dev, pathPtr, strokeStatePtr, ctmPtr, csPtr, csN, colorPtr, alpha) => {
            const c = _activeGraphicsCollector;
            if (!c) return;
            if (c.strokesAborted) return;
            c.strokesSeen += 1;
            if (c.strokesSeen > c.maxStrokes) {
                c.strokesAborted = true;
                return;
            }

            c.path = [];
            libmupdf._wasm_walk_path(pathPtr);
            const segs = c.path;
            const ctm = readCtm(libmupdf, ctmPtr);
            const line = isAxisAlignedLineSegment(segs, ctm);
            if (!line) return;
            const topLeftLine = lineSegmentToTopLeftFrame(line, c.pageHeight);

            const rawLineWidth =
                typeof libmupdf._wasm_stroke_state_get_linewidth === "function"
                    ? libmupdf._wasm_stroke_state_get_linewidth(strokeStatePtr)
                    : 0;
            const thickness = pathSpaceStrokeThickness(segs, ctm, rawLineWidth);
            const { color, colorspaceType } = readColor(libmupdf, csPtr, csN, colorPtr);

            c.strokes.push({
                a: topLeftLine.a,
                b: topLeftLine.b,
                thickness,
                orientation: topLeftLine.orientation,
                color,
                colorspaceType,
                alpha,
            });
        },
        clip_path: noop,
        clip_stroke_path: noop,
        fill_text: noop,
        stroke_text: noop,
        clip_text: noop,
        clip_stroke_text: noop,
        ignore_text: noop,
        fill_shade: noop,
        fill_image: noop,
        fill_image_mask: noop,
        clip_image_mask: noop,
        pop_clip: noop,
        begin_mask: noop,
        end_mask: noop,
        begin_group: noop,
        end_group: noop,
        // Return 0 — "render the tile, MuPDF will cache it". Anything
        // else asks for per-instance rendering, which we don't need.
        begin_tile: () => 0,
        end_tile: noop,
        begin_layer: noop,
        end_layer: noop,
    };
}

/**
 * Build the API wrappers around a libmupdf module. Allocates real WASM
 * heap (scratch UTF8/Matrix slots, ColorSpace pointers) — call once per
 * worker lifetime via `ensureApi()`.
 */
export function makeDocumentApi(libmupdf: LibMuPdf): MuPDFApi {
    installCallbacks(libmupdf);
    const Malloc = (size: number) => libmupdf._wasm_malloc(size);
    const Free = (ptr: number) => libmupdf._wasm_free(ptr);

    const allocateUTF8 = (str: string) => {
        const size = libmupdf.lengthBytesUTF8(str) + 1;
        const ptr = Malloc(size);
        libmupdf.stringToUTF8(str, ptr, size);
        return ptr;
    };

    const fromString = (ptr: number) => libmupdf.UTF8ToString(ptr);
    const fromStringFree = (ptr: number) => {
        const str = libmupdf.UTF8ToString(ptr);
        Free(ptr);
        return str;
    };

    // Scratch UTF8 slot, freed and reallocated on every STRING() call so
    // we never accumulate per-op allocations beyond a single live slot.
    const _wasm_string: [number, number] = [0, 0];
    const STRING = (s: string): number => {
        if (_wasm_string[0]) {
            Free(_wasm_string[0]);
            _wasm_string[0] = 0;
        }
        return (_wasm_string[0] = allocateUTF8(s));
    };

    // Buffer helper — copies bytes into a fresh WASM buffer.
    const createBuffer = (data: Uint8Array | ArrayBuffer): number => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const data_len = bytes.byteLength;
        const data_ptr = Malloc(data_len);
        libmupdf.HEAPU8.set(bytes, data_ptr);
        return libmupdf._wasm_new_buffer_from_data(data_ptr, data_len);
    };

    const fromRect = (ptr: number): RectTuple => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
        ];
    };

    const fromQuad = (ptr: number): QuadTuple => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
            libmupdf.HEAPF32[a + 4],
            libmupdf.HEAPF32[a + 5],
            libmupdf.HEAPF32[a + 6],
            libmupdf.HEAPF32[a + 7],
        ];
    };

    // Matrix scratch (6 floats), reused across calls.
    const _wasm_matrix = Malloc(4 * 6) >> 2;
    const MATRIX = (m: MatrixTuple): number => {
        libmupdf.HEAPF32[_wasm_matrix + 0] = m[0];
        libmupdf.HEAPF32[_wasm_matrix + 1] = m[1];
        libmupdf.HEAPF32[_wasm_matrix + 2] = m[2];
        libmupdf.HEAPF32[_wasm_matrix + 3] = m[3];
        libmupdf.HEAPF32[_wasm_matrix + 4] = m[4];
        libmupdf.HEAPF32[_wasm_matrix + 5] = m[5];
        return _wasm_matrix << 2;
    };

    const Matrix: MatrixApi = {
        identity: [1, 0, 0, 1, 0, 0],
        scale(sx, sy) {
            return [sx, 0, 0, sy, 0, 0];
        },
        translate(tx, ty) {
            return [1, 0, 0, 1, tx, ty];
        },
        rotate(degrees) {
            let d = degrees;
            while (d < 0) d += 360;
            while (d >= 360) d -= 360;
            const s = Math.sin((d * Math.PI) / 180);
            const c = Math.cos((d * Math.PI) / 180);
            return [c, s, -s, c, 0, 0];
        },
        concat(one, two) {
            return [
                one[0] * two[0] + one[1] * two[2],
                one[0] * two[1] + one[1] * two[3],
                one[2] * two[0] + one[3] * two[2],
                one[2] * two[1] + one[3] * two[3],
                one[4] * two[0] + one[5] * two[2] + two[4],
                one[4] * two[1] + one[5] * two[3] + two[5],
            ];
        },
    };

    class ColorSpaceImpl implements ColorSpaceLike {
        constructor(public pointer: number) {}
    }
    const ColorSpace: ColorSpacePalette = {
        DeviceGray: new ColorSpaceImpl(libmupdf._wasm_device_gray()),
        DeviceRGB: new ColorSpaceImpl(libmupdf._wasm_device_rgb()),
        DeviceBGR: new ColorSpaceImpl(libmupdf._wasm_device_bgr()),
        DeviceCMYK: new ColorSpaceImpl(libmupdf._wasm_device_cmyk()),
    };

    class Pixmap implements PixmapLike {
        constructor(public pointer: number) {}
        getWidth() {
            return libmupdf._wasm_pixmap_get_w(this.pointer);
        }
        getHeight() {
            return libmupdf._wasm_pixmap_get_h(this.pointer);
        }
        getStride() {
            return libmupdf._wasm_pixmap_get_stride(this.pointer);
        }
        getNumberOfComponents() {
            return libmupdf._wasm_pixmap_get_n(this.pointer);
        }
        getAlpha() {
            return libmupdf._wasm_pixmap_get_alpha(this.pointer);
        }
        getSamples() {
            const stride = this.getStride();
            const height = this.getHeight();
            const ptr = libmupdf._wasm_pixmap_get_samples(this.pointer);
            return new Uint8Array(libmupdf.HEAPU8.buffer, ptr, stride * height);
        }
        asPNG() {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_png(this.pointer);
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        asJPEG(quality = 85, invertCmyk = false) {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_jpeg(
                this.pointer,
                quality,
                invertCmyk ? 1 : 0,
            );
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_pixmap(this.pointer);
                this.pointer = 0;
            }
        }
    }

    const runSearch = (
        searchFun: (this_: number, needle: number, marks: number, hits: number, max: number) => number,
        searchThis: number,
        needle: string,
        maxHits = 500,
    ): QuadTuple[][] => {
        let hits = 0;
        let marks = 0;
        try {
            hits = Malloc(32 * maxHits);
            marks = Malloc(4 * maxHits);
            const n = searchFun(searchThis, STRING(needle), marks, hits, maxHits);
            const outer: QuadTuple[][] = [];
            if (n > 0) {
                let inner: QuadTuple[] = [];
                for (let i = 0; i < n; i++) {
                    const mark = libmupdf.HEAP32[(marks >> 2) + i];
                    const quad = fromQuad(hits + i * 32);
                    if (i > 0 && mark) {
                        outer.push(inner);
                        inner = [];
                    }
                    inner.push(quad);
                }
                outer.push(inner);
            }
            return outer;
        } finally {
            Free(marks);
            Free(hits);
        }
    };

    class Page implements PageLike {
        constructor(public pointer: number) {}
        getBounds(box: "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox" = "CropBox") {
            const boxTypes: Record<string, number> = {
                MediaBox: 0,
                CropBox: 1,
                BleedBox: 2,
                TrimBox: 3,
                ArtBox: 4,
            };
            const boxIdx = boxTypes[box] ?? 1;
            return fromRect(libmupdf._wasm_bound_page(this.pointer, boxIdx));
        }
        getLabel() {
            const ptr = libmupdf._wasm_page_label(this.pointer);
            if (!ptr) return undefined;
            return fromString(ptr);
        }
        toStructuredText(options = ""): StructuredTextLike {
            const optionsPtr = STRING(options);
            const stextPtr = libmupdf._wasm_new_stext_page_from_page(this.pointer, optionsPtr);
            if (!stextPtr) {
                throw new Error("Failed to create structured text");
            }
            return new StructuredText(stextPtr);
        }
        toPixmap(matrix: MatrixTuple, colorspace: ColorSpaceLike, alpha = false, showExtras = true) {
            let result: number;
            if (showExtras) {
                result = libmupdf._wasm_new_pixmap_from_page(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            } else {
                result = libmupdf._wasm_new_pixmap_from_page_contents(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            }
            return new Pixmap(result);
        }
        search(needle: string, maxHits = 500) {
            return runSearch(
                libmupdf._wasm_search_page.bind(libmupdf) as (
                    a: number, b: number, c: number, d: number, e: number,
                ) => number,
                this.pointer,
                needle,
                maxHits,
            );
        }
        collectFilledRects(maxFills: number = DEFAULT_MAX_FILL_RECTS): FillRect[] {
            return this.collectGraphics({ maxFills, maxStrokes: 0 }).fills;
        }
        collectGraphics(opts: CollectGraphicsOptions = {}): GraphicsLayerPrimitives {
            // Single-collector reentrancy guard. The worker is
            // single-threaded so concurrent calls aren't expected, but
            // surfacing this as an error beats silently mixing two
            // pages' graphics streams.
            if (_activeGraphicsCollector) {
                throw new Error("collectGraphics: another collection is already in progress");
            }
            const bounds = this.getBounds();
            const pageHeight = bounds[3] - bounds[1];
            // Identity CTM — we want the path coords MuPDF emits (each
            // fill_path callback gets the path's own CTM at draw time;
            // the matrix we pass to `run_page_contents` only adds an
            // OUTER transform on top of that and would skew our bboxes).
            const ctmTuple: MatrixTuple = [1, 0, 0, 1, 0, 0];
            const ctmPtr = MATRIX(ctmTuple);

            const state: GraphicsCollectorState = {
                fills: [],
                strokes: [],
                pageHeight,
                path: [],
                fillsSeen: 0,
                strokesSeen: 0,
                maxFills: opts.maxFills ?? DEFAULT_MAX_FILL_RECTS,
                maxStrokes: opts.maxStrokes ?? DEFAULT_MAX_STROKE_LINES,
                fillsAborted: false,
                strokesAborted: false,
            };
            _activeGraphicsCollector = state;
            const device = libmupdf._wasm_new_js_device();
            try {
                libmupdf._wasm_run_page_contents(this.pointer, device, ctmPtr, 0);
            } finally {
                // MuPDF emits "dropping unclosed device" to stderr if
                // `close_device` is skipped before `drop_device`. The
                // close callback flushes any buffered state in the
                // device's vtable (no-op for our JS device — see the
                // `close_device` stub in `installCallbacks`) and
                // matches the lifecycle MuPDF expects.
                libmupdf._wasm_close_device(device);
                libmupdf._wasm_drop_device(device);
                _activeGraphicsCollector = null;
            }
            // Hard abort: a page that emitted more than `maxFills`
            // fill_path events is treated as a figure / vector
            // illustration with no semantically-meaningful display
            // containers. Discard everything we *did* collect — those
            // first N fills are almost always sub-shapes of the same
            // illustration, not real aside boxes.
            return {
                fills: state.fillsAborted ? [] : state.fills,
                strokes: state.strokesAborted ? [] : state.strokes,
            };
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class StructuredText implements StructuredTextLike {
        constructor(public pointer: number) {}
        asJSON(scale = 1) {
            const jsonPtr = libmupdf._wasm_print_stext_page_as_json(this.pointer, scale);
            return fromStringFree(jsonPtr);
        }
        asText() {
            const textPtr = libmupdf._wasm_print_stext_page_as_text(this.pointer);
            return fromStringFree(textPtr);
        }
        walk(walker: StructuredTextWalker) {
            let block = libmupdf._wasm_stext_page_get_first_block(this.pointer);
            while (block) {
                const blockType = libmupdf._wasm_stext_block_get_type(block);
                const blockBBox = fromRect(libmupdf._wasm_stext_block_get_bbox(block));
                if (blockType === 1) {
                    if (walker.onImageBlock) {
                        walker.onImageBlock(blockBBox, null, null);
                    }
                } else {
                    if (walker.beginTextBlock) {
                        walker.beginTextBlock(blockBBox);
                    }
                    let line = libmupdf._wasm_stext_block_get_first_line(block);
                    while (line) {
                        const lineBBox = fromRect(libmupdf._wasm_stext_line_get_bbox(line));
                        const lineWmode = libmupdf._wasm_stext_line_get_wmode(line);
                        const dirPtr = libmupdf._wasm_stext_line_get_dir(line) >> 2;
                        const lineDir: [number, number] = [
                            libmupdf.HEAPF32[dirPtr + 0],
                            libmupdf.HEAPF32[dirPtr + 1],
                        ];
                        if (walker.beginLine) {
                            walker.beginLine(lineBBox, lineWmode, lineDir);
                        }
                        if (walker.onChar || walker.onLineFont) {
                            let ch = libmupdf._wasm_stext_line_get_first_char(line);
                            // Font/size are line-level in every consumer
                            // today, so we read them only off the first
                            // char and skip the per-char WASM trampolines
                            // for the rest of the line.
                            if (ch && walker.onLineFont) {
                                const fontPtr = libmupdf._wasm_stext_char_get_font(ch);
                                const size = libmupdf._wasm_stext_char_get_size(ch);
                                walker.onLineFont(fontPtr, size);
                            }
                            if (walker.onChar) {
                                while (ch) {
                                    const runeCode = libmupdf._wasm_stext_char_get_c(ch);
                                    // fromCodePoint (not fromCharCode) so
                                    // non-BMP characters (emoji, U+1D400
                                    // math bold, extended CJK) survive
                                    // intact. Without this the rune is
                                    // truncated to a single UTF-16 unit
                                    // and the `text.length === chars.length`
                                    // invariant in ParagraphSentenceMapper
                                    // fails, forcing a degradation fallback.
                                    const rune = String.fromCodePoint(runeCode);
                                    const quad = fromQuad(libmupdf._wasm_stext_char_get_quad(ch));
                                    walker.onChar(rune, quad);
                                    ch = libmupdf._wasm_stext_char_get_next(ch);
                                }
                            }
                        }
                        if (walker.endLine) {
                            walker.endLine();
                        }
                        line = libmupdf._wasm_stext_line_get_next(line);
                    }
                    if (walker.endTextBlock) {
                        walker.endTextBlock();
                    }
                }
                block = libmupdf._wasm_stext_block_get_next(block);
            }
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_stext_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class Document implements DocumentLike {
        constructor(public pointer: number) {}

        static openDocument(data: Uint8Array | ArrayBuffer, magic = "application/pdf"): Document {
            const bufferPtr = createBuffer(data);
            const magicPtr = STRING(magic);
            const docPtr = libmupdf._wasm_open_document_with_buffer(magicPtr, bufferPtr);
            libmupdf._wasm_drop_buffer(bufferPtr);
            if (!docPtr) {
                throw new Error("Failed to open document");
            }
            return new Document(docPtr);
        }

        needsPassword() {
            if (typeof libmupdf._wasm_needs_password === "function") {
                return libmupdf._wasm_needs_password(this.pointer) !== 0;
            }
            const enc = this.getMetadata("encryption");
            return enc !== undefined && enc !== "" && enc !== "None";
        }

        countPages() {
            return libmupdf._wasm_count_pages(this.pointer);
        }

        getMetadata(key: string) {
            const valuePtr = libmupdf._wasm_lookup_metadata(this.pointer, STRING(key));
            if (!valuePtr) return undefined;
            return fromString(valuePtr);
        }

        loadPage(index: number) {
            const pagePtr = libmupdf._wasm_load_page(this.pointer, index);
            if (!pagePtr) {
                throw new Error(`Failed to load page ${index}`);
            }
            return new Page(pagePtr);
        }

        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_document(this.pointer);
                this.pointer = 0;
            }
        }
    }

    const Font: FontApi = {
        getName(fontPtr: number): string {
            if (!fontPtr) return "";
            const namePtr = libmupdf._wasm_font_get_name(fontPtr);
            if (!namePtr) return "";
            return fromString(namePtr);
        },
        isBold(fontPtr: number): boolean {
            if (!fontPtr) return false;
            return libmupdf._wasm_font_is_bold(fontPtr) !== 0;
        },
        isItalic(fontPtr: number): boolean {
            if (!fontPtr) return false;
            return libmupdf._wasm_font_is_italic(fontPtr) !== 0;
        },
    };

    return {
        Document: { openDocument: Document.openDocument.bind(Document) },
        Matrix,
        ColorSpace,
        Font,
    };
}
