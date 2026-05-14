/**
 * tests/scripts/cliVsHandlerParity.ts
 *
 * Harness A from `docs-zotero/beaver-extract-cli-parity-tests.md`.
 *
 * Diffs `beaver-extract` (Node CLI) output against the running
 * `/beaver/test/pdf-*` HTTP endpoints to verify the two surfaces have
 * not drifted apart. The CLI bundles the same `worker/ops.ts` the
 * handlers call, so any diff is either a wire-projection bug, a
 * loader-side bug, or an option-parsing bug.
 *
 * Run:
 *   npx tsx tests/scripts/cliVsHandlerParity.ts \
 *       --port 23119 \
 *       --fixture tests/fixtures/pdfs/sentences/_shared/0a3a...pdf
 *
 *   # auto-probe ports 23119 / 23124 and use the SMOKE_PDF default:
 *   npx tsx tests/scripts/cliVsHandlerParity.ts
 *
 *   # filter cases / fixtures / pick a different page:
 *   npx tsx tests/scripts/cliVsHandlerParity.ts \
 *       --fixture path/a.pdf,path/b.pdf \
 *       --commands info,extract,overlay,analyze-layout \
 *       --page 0
 *
 * Exit code is the number of failed comparisons (0 = pass).
 *
 * Report: `tests/.parity-report.md` (override with `--report`).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_MAIN = resolve(REPO_ROOT, "src/beaver-extract/cli/main.ts");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const DEFAULT_FIXTURE = resolve(
    REPO_ROOT,
    "tests/fixtures/pdfs/sentences/_shared/0a3a5c40534376346b36c03c4469694674fd85ea1493c493be7c777df1ea4561.pdf",
);
const DEFAULT_REPORT = resolve(REPO_ROOT, "tests/.parity-report.md");

// Ports probed when --port is not passed. Mirrors `tests/helpers/fixtures.ts`.
const PORT_CANDIDATES = [23119, 23124];

// =============================================================================
// CLI invocation helpers
// =============================================================================

interface SpawnResult {
    code: number;
    stdout: string;
    stderr: string;
}

function spawnCli(argv: string[]): Promise<SpawnResult> {
    return new Promise((res, rej) => {
        const child = spawn(TSX_BIN, [CLI_MAIN, ...argv], {
            cwd: REPO_ROOT,
            // Keeps experimental warnings out of stderr so structured
            // error envelopes parse cleanly.
            env: { ...process.env, NODE_NO_WARNINGS: "1" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        child.on("error", rej);
        child.on("close", (code) =>
            res({ code: code ?? -1, stdout, stderr }),
        );
    });
}

// =============================================================================
// HTTP helpers
// =============================================================================

async function probePort(port: number): Promise<boolean> {
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const r = await fetch(`http://127.0.0.1:${port}/beaver/test/ping`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: ctl.signal,
        });
        clearTimeout(timer);
        return r.ok;
    } catch {
        return false;
    }
}

async function resolvePort(explicit: number | undefined): Promise<number> {
    if (explicit != null) {
        if (await probePort(explicit)) return explicit;
        throw new Error(
            `--port ${explicit} did not answer /beaver/test/ping. Is Zotero+Beaver running?`,
        );
    }
    for (const p of PORT_CANDIDATES) {
        if (await probePort(p)) return p;
    }
    throw new Error(
        `Could not reach Zotero on any of: ${PORT_CANDIDATES.join(", ")}. ` +
            "Pass --port <n> explicitly.",
    );
}

async function postJson(
    port: number,
    path: string,
    body: unknown,
    timeoutMs = 120000,
): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctl.signal,
        });
        const txt = await r.text();
        if (!r.ok) {
            throw new Error(
                `HTTP ${r.status} ${path}: ${txt.slice(0, 500)}`,
            );
        }
        return JSON.parse(txt);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Throws if the HTTP envelope reports `{ ok: false, error }`. The
 * handlers always return a `{ ok }` discriminator (lines 105-139 of
 * `react/hooks/httpHandlers/testPdfHandlers.ts`), so a `false` here
 * means a real failure on the Zotero side — flag it as a case error
 * rather than feeding it into the structural diff and producing a
 * confusing flood of "missing" entries.
 */
function assertHttpOk(resp: unknown, endpoint: string): asserts resp is { ok: true } & Record<string, unknown> {
    if (resp == null || typeof resp !== "object") {
        throw new Error(`${endpoint}: HTTP response was not an object`);
    }
    const r = resp as { ok?: unknown; error?: unknown };
    if (r.ok === false) {
        const err = r.error as { name?: string; message?: string } | undefined;
        throw new Error(
            `${endpoint} HTTP returned ok=false: ${err?.name ?? "?"} — ${err?.message ?? "(no message)"}`,
        );
    }
    if (r.ok !== true) {
        throw new Error(`${endpoint}: HTTP response missing ok=true discriminator`);
    }
}

// =============================================================================
// Utilities
// =============================================================================

function sha256Hex(buf: Buffer | Uint8Array): string {
    return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

function decodeBase64(b64: string): Buffer {
    return Buffer.from(b64, "base64");
}

/**
 * Recursive deep-compare with a path-prefix deny-list. Returns a flat
 * list of human-readable diff strings rooted at `<path>`. Empty list ≡
 * structurally equal modulo the deny-list.
 *
 * Numbers compare by `Object.is` (so NaN === NaN, +0 ≠ -0). All other
 * primitives compare by `===`. Arrays compare by length then index;
 * objects compare by sorted-key set equality then per-key recursion.
 */
function deepDiff(
    a: unknown,
    b: unknown,
    path: string,
    deny: ReadonlySet<string>,
    out: string[],
    aLabel: string,
    bLabel: string,
    maxDiffs = 50,
): void {
    if (out.length >= maxDiffs) return;
    if (deny.has(path)) return;
    if (a === b) return;
    // `undefined` round-trips to "key absent" through JSON.stringify, so
    // treat `undefined` as equivalent to "missing" on either side. This
    // matters for optional fields like `degradation` that producers
    // return on the object but JSON drops on the wire.
    if (a === undefined || b === undefined) return;
    if (typeof a !== typeof b) {
        out.push(
            `[${path}] type mismatch: ${aLabel}=${typeName(a)} vs ${bLabel}=${typeName(b)}`,
        );
        return;
    }
    if (a == null || b == null) {
        out.push(
            `[${path}] ${aLabel}=${stringifyShort(a)} vs ${bLabel}=${stringifyShort(b)}`,
        );
        return;
    }
    if (typeof a === "number" && typeof b === "number") {
        if (!Object.is(a, b)) {
            out.push(`[${path}] ${aLabel}=${a} vs ${bLabel}=${b}`);
        }
        return;
    }
    if (typeof a !== "object") {
        out.push(
            `[${path}] ${aLabel}=${stringifyShort(a)} vs ${bLabel}=${stringifyShort(b)}`,
        );
        return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) {
            out.push(
                `[${path}] kind mismatch: ${aLabel}=${
                    Array.isArray(a) ? "array" : "object"
                } vs ${bLabel}=${Array.isArray(b) ? "array" : "object"}`,
            );
            return;
        }
        if (a.length !== b.length) {
            out.push(
                `[${path}] array length ${aLabel}=${a.length} vs ${bLabel}=${b.length}`,
            );
        }
        const lim = Math.min(a.length, b.length);
        for (let i = 0; i < lim; i++) {
            deepDiff(a[i], b[i], `${path}[${i}]`, deny, out, aLabel, bLabel, maxDiffs);
            if (out.length >= maxDiffs) return;
        }
        return;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    const all = new Set<string>([...ak, ...bk]);
    for (const k of all) {
        const subPath = path ? `${path}.${k}` : k;
        if (deny.has(subPath)) continue;
        const aHas = k in ao;
        const bHas = k in bo;
        if (!aHas) {
            // Keys present-but-undefined round-trip to "absent" through
            // JSON.stringify. Don't flag those as a structural diff.
            if (bo[k] === undefined) continue;
            out.push(`[${subPath}] missing in ${aLabel} (${bLabel}=${stringifyShort(bo[k])})`);
            continue;
        }
        if (!bHas) {
            if (ao[k] === undefined) continue;
            out.push(`[${subPath}] missing in ${bLabel} (${aLabel}=${stringifyShort(ao[k])})`);
            continue;
        }
        deepDiff(ao[k], bo[k], subPath, deny, out, aLabel, bLabel, maxDiffs);
        if (out.length >= maxDiffs) return;
    }
}

function typeName(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

function stringifyShort(v: unknown, max = 60): string {
    let s: string;
    try {
        s = JSON.stringify(v);
    } catch {
        s = String(v);
    }
    if (s == null) s = String(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Strip every key whose path matches a deny-list entry. Mutates `obj`
 * in place. Used pre-stringify when we want to log the comparable
 * subtree.
 */
function stripDeny(
    obj: unknown,
    deny: ReadonlySet<string>,
    path = "",
): void {
    if (obj == null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => stripDeny(v, deny, `${path}[${i}]`));
        return;
    }
    const o = obj as Record<string, unknown>;
    for (const k of Object.keys(o)) {
        const subPath = path ? `${path}.${k}` : k;
        if (deny.has(subPath)) {
            delete o[k];
            continue;
        }
        stripDeny(o[k], deny, subPath);
    }
}

// =============================================================================
// Per-case definitions
// =============================================================================

interface ParityContext {
    port: number;
    pdfPath: string;
    pdfB64: string;
    pageIndex: number;
    pageIndices: number[];
    workDir: string;
}

interface ParityCase {
    name: string;
    /** Single command label so `--commands extract` matches multiple cases. */
    group: string;
    /** Resolved subtrees from the two surfaces, plus a per-case deny-list. */
    run: (ctx: ParityContext) => Promise<{
        cli: unknown;
        http: unknown;
        deny: ReadonlySet<string>;
        notes?: string[];
    }>;
}

// Deny-list entries shared by every case. Each entry is a dotted path
// rooted at the *comparable subtree* (after each case's `httpResultExtract`
// / `cliResultExtract`). The CLI envelope's `input` / `options` wrappers
// don't appear here because cases extract `result.*` directly.
const COMMON_DENY = new Set<string>([
    "metadata.extractedAt",
    "metadata.timings",
    "metadata.version",
    // analyze-layout has its own metadata block — same fields:
    // (already covered by the dotted prefix `metadata.*` above for the
    // top-level shape; nested `pages[].metadata` doesn't exist there).
]);

// -----------------------------------------------------------------------------
// info → pdf-page-count
// -----------------------------------------------------------------------------

async function runCliJson<T = unknown>(
    args: string[],
): Promise<{ envelope: T; raw: string }> {
    const r = await spawnCli(args);
    if (r.code !== 0) {
        throw new Error(
            `CLI exited ${r.code}\n  args: ${args.join(" ")}\n  stderr: ${r.stderr.trim()}`,
        );
    }
    if (!r.stdout.trim()) {
        throw new Error(`CLI produced empty stdout (args: ${args.join(" ")})`);
    }
    return { envelope: JSON.parse(r.stdout) as T, raw: r.stdout };
}

const CASE_PAGE_COUNT: ParityCase = {
    name: "info → pdf-page-count",
    group: "info",
    run: async (ctx) => {
        const http = await postJson(ctx.port, "/beaver/test/pdf-page-count", {
            raw_bytes_base64: ctx.pdfB64,
        });
        assertHttpOk(http, "pdf-page-count");
        const { envelope } = await runCliJson<{
            ok: true;
            result: { pageCount: number };
        }>(["info", ctx.pdfPath, "--json"]);
        return {
            cli: { pageCount: envelope.result.pageCount },
            http: { pageCount: http.count },
            deny: new Set<string>(),
        };
    },
};

const CASE_PAGE_LABELS: ParityCase = {
    name: "info → pdf-page-labels",
    group: "info",
    run: async (ctx) => {
        const http = await postJson(ctx.port, "/beaver/test/pdf-page-labels", {
            raw_bytes_base64: ctx.pdfB64,
        });
        assertHttpOk(http, "pdf-page-labels");
        const { envelope } = await runCliJson<{
            ok: true;
            result: { metadata: { pageLabels?: Record<string, string> } };
        }>(["info", ctx.pdfPath, "--json"]);
        return {
            cli: { pageLabels: envelope.result.metadata.pageLabels },
            http: { pageLabels: http.pageLabels },
            deny: new Set<string>(),
        };
    },
};

// -----------------------------------------------------------------------------
// render → pdf-render-pages (per-page sha256 + dims)
// -----------------------------------------------------------------------------

// Render scale must be passed explicitly to BOTH sides — the worker
// op defaults to scale=1.0 / dpi=72 when no options are given, while
// the CLI defaults to scale=2.0. We pass scale=2.0 to both so the
// PNG bytes are byte-identical.
const RENDER_SCALE = 2.0;

const CASE_RENDER: ParityCase = {
    name: "render → pdf-render-pages",
    group: "render",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-render-pages",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_indices: ctx.pageIndices,
                options: { format: "png", scale: RENDER_SCALE },
            },
        );
        assertHttpOk(http, "pdf-render-pages");
        const httpPages = (http.pages as Array<{
            pageIndex: number;
            width: number;
            height: number;
            data_base64: string;
            data_byte_length: number;
        }>).map((p) => ({
            pageIndex: p.pageIndex,
            width: p.width,
            height: p.height,
            byteLength: p.data_byte_length,
            sha256: sha256Hex(decodeBase64(p.data_base64)),
        }));

        const renderDir = join(ctx.workDir, "render");
        await mkdir(renderDir, { recursive: true });
        const { envelope } = await runCliJson<{
            ok: true;
            result: {
                pageCount: number;
                pages: Array<{
                    pageIndex: number;
                    width: number;
                    height: number;
                    byteLength: number;
                    sha256: string;
                }>;
            };
        }>([
            "render",
            ctx.pdfPath,
            "--pages",
            ctx.pageIndices.join(","),
            "--out",
            renderDir,
            "--scale",
            String(RENDER_SCALE),
            "--json",
        ]);
        const cliPages = envelope.result.pages.map((p) => ({
            pageIndex: p.pageIndex,
            width: p.width,
            height: p.height,
            byteLength: p.byteLength,
            sha256: p.sha256,
        }));
        return {
            cli: cliPages,
            http: httpPages,
            deny: new Set<string>(),
        };
    },
};

const CASE_RENDER_WITH_META: ParityCase = {
    name: "render → pdf-render-pages-with-meta",
    group: "render",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-render-pages-with-meta",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_indices: ctx.pageIndices,
                options: { format: "png", scale: RENDER_SCALE },
            },
        );
        assertHttpOk(http, "pdf-render-pages-with-meta");
        const httpPages = (http.pages as Array<{
            pageIndex: number;
            width: number;
            height: number;
            data_base64: string;
            data_byte_length: number;
        }>).map((p) => ({
            pageIndex: p.pageIndex,
            width: p.width,
            height: p.height,
            byteLength: p.data_byte_length,
            sha256: sha256Hex(decodeBase64(p.data_base64)),
        }));

        const renderDir = join(ctx.workDir, "render-meta");
        await mkdir(renderDir, { recursive: true });
        const { envelope } = await runCliJson<{
            ok: true;
            result: {
                pageCount: number;
                pages: Array<{
                    pageIndex: number;
                    width: number;
                    height: number;
                    byteLength: number;
                    sha256: string;
                    label?: string;
                }>;
            };
        }>([
            "render",
            ctx.pdfPath,
            "--pages",
            ctx.pageIndices.join(","),
            "--out",
            renderDir,
            "--scale",
            String(RENDER_SCALE),
            "--json",
        ]);

        // HTTP returns labels as a `{ pageIndex → label }` map. The
        // CLI returns each page's `label` inline. Reshape both into the
        // same `{ index → label }` map so the diff is structural.
        const httpPageLabels = http.pageLabels as Record<string, string> | undefined;
        const httpLabels: Record<string, string | undefined> = {};
        for (const p of httpPages) {
            httpLabels[String(p.pageIndex)] = httpPageLabels?.[p.pageIndex] ?? httpPageLabels?.[String(p.pageIndex)];
        }
        const cliLabels: Record<string, string | undefined> = {};
        for (const p of envelope.result.pages) {
            cliLabels[String(p.pageIndex)] = p.label;
        }

        const cliPages = envelope.result.pages.map((p) => ({
            pageIndex: p.pageIndex,
            width: p.width,
            height: p.height,
            byteLength: p.byteLength,
            sha256: p.sha256,
        }));

        return {
            cli: {
                pageCount: envelope.result.pageCount,
                labels: cliLabels,
                pages: cliPages,
            },
            http: {
                pageCount: http.pageCount,
                labels: httpLabels,
                pages: httpPages,
            },
            deny: new Set<string>(),
        };
    },
};

// -----------------------------------------------------------------------------
// raw-detailed → pdf-extract-raw-detailed
// -----------------------------------------------------------------------------

const CASE_RAW_DETAILED: ParityCase = {
    name: "raw-detailed → pdf-extract-raw-detailed",
    group: "raw-detailed",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-extract-raw-detailed",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_index: ctx.pageIndex,
            },
        );
        assertHttpOk(http, "pdf-extract-raw-detailed");
        const { envelope } = await runCliJson<{
            ok: true;
            result: unknown;
        }>([
            "raw-detailed",
            ctx.pdfPath,
            "--page",
            String(ctx.pageIndex),
            "--json",
        ]);
        return {
            cli: envelope.result,
            http: http.result,
            deny: new Set<string>(),
        };
    },
};

// -----------------------------------------------------------------------------
// extract → pdf-extract  (HTTP defaults to markdown engine)
// -----------------------------------------------------------------------------

const CASE_EXTRACT_MARKDOWN: ParityCase = {
    name: "extract (markdown) → pdf-extract",
    group: "extract",
    run: async (ctx) => {
        const http = await postJson(ctx.port, "/beaver/test/pdf-extract", {
            raw_bytes_base64: ctx.pdfB64,
            settings: { pages: ctx.pageIndices },
        });
        assertHttpOk(http, "pdf-extract");
        // CLI defaults to --mode structured, but HTTP defaults to
        // markdown/paragraph. Match the HTTP default for parity.
        const { envelope } = await runCliJson<{
            ok: true;
            result: { pages: unknown[]; metadata?: unknown };
        }>([
            "extract",
            ctx.pdfPath,
            "--mode",
            "markdown",
            "--pages",
            ctx.pageIndices.join(","),
            "--json",
        ]);
        return {
            cli: envelope.result,
            http: http.result,
            deny: COMMON_DENY,
        };
    },
};

// -----------------------------------------------------------------------------
// extract --mode markdown → pdf-extract-paragraph
// -----------------------------------------------------------------------------

const CASE_EXTRACT_PARAGRAPH: ParityCase = {
    name: "extract (markdown) → pdf-extract-paragraph",
    group: "extract",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-extract-paragraph",
            {
                raw_bytes_base64: ctx.pdfB64,
                settings: { pages: ctx.pageIndices },
            },
        );
        assertHttpOk(http, "pdf-extract-paragraph");
        const { envelope } = await runCliJson<{
            ok: true;
            result: { pages: unknown[] };
        }>([
            "extract",
            ctx.pdfPath,
            "--mode",
            "markdown",
            "--pages",
            ctx.pageIndices.join(","),
            "--json",
        ]);
        return {
            cli: envelope.result,
            http: http.result,
            deny: COMMON_DENY,
        };
    },
};

// -----------------------------------------------------------------------------
// extract (structured) → pdf-sentence-bboxes
// -----------------------------------------------------------------------------

interface PageWithSentences {
    items?: unknown;
    sentences?: unknown;
    degradation?: unknown;
    width?: number;
    height?: number;
    index?: number;
}

const CASE_SENTENCE_BBOXES: ParityCase = {
    name: "extract (structured) → pdf-sentence-bboxes",
    group: "extract",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-sentence-bboxes",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_index: ctx.pageIndex,
            },
        );
        assertHttpOk(http, "pdf-sentence-bboxes");
        const httpResult = http.result as {
            pageIndex: number;
            width: number;
            height: number;
            items: unknown;
            sentences: unknown;
            degradation: unknown;
        };
        const { envelope } = await runCliJson<{
            ok: true;
            result: { pages: PageWithSentences[] };
        }>([
            "extract",
            ctx.pdfPath,
            "--pages",
            String(ctx.pageIndex),
            "--json",
        ]);
        const cliPage = envelope.result.pages.find(
            (p) => p.index === ctx.pageIndex,
        );
        if (!cliPage) {
            throw new Error(
                `extract did not return page ${ctx.pageIndex} (got ${envelope.result.pages
                    .map((p) => p.index)
                    .join(", ")})`,
            );
        }
        return {
            cli: {
                pageIndex: cliPage.index,
                width: cliPage.width,
                height: cliPage.height,
                items: cliPage.items ?? [],
                sentences: cliPage.sentences ?? [],
                degradation: cliPage.degradation,
            },
            http: httpResult,
            deny: new Set<string>(),
        };
    },
};

// -----------------------------------------------------------------------------
// overlay → pdf-render-overlay  (sidecar rects only — PNG bytes diverge)
// -----------------------------------------------------------------------------

const CASE_OVERLAY: ParityCase = {
    name: "overlay (sentences) → pdf-render-overlay",
    group: "overlay",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-render-overlay",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_index: ctx.pageIndex,
                level: "sentences",
                dpi: 144,
            },
        );
        assertHttpOk(http, "pdf-render-overlay");
        const httpO = http as {
            level: string;
            page_index: number;
            page_width: number;
            page_height: number;
            image_width: number;
            image_height: number;
            dpi: number;
            group_count: number;
            stats: unknown;
            rects: unknown;
        };

        const overlayOut = join(ctx.workDir, "overlay.png");
        const sidecarPath = `${overlayOut}.json`;
        // CLI overlay default scale=2.0 = 144 DPI (matching HTTP
        // default). The structured-mode worker op the CLI uses on
        // levels other than "margins" is the same one the HTTP
        // handler runs, so the rect data should match exactly.
        await runCliJson([
            "overlay",
            ctx.pdfPath,
            "--page",
            String(ctx.pageIndex),
            "--level",
            "sentences",
            "--out",
            overlayOut,
            "--dpi",
            "144",
            "--sidecar-json",
            "--json",
        ]);
        const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
            ok: true;
            input: { pageIndex: number; level: string };
            result: {
                image: {
                    width: number;
                    height: number;
                    pageWidth: number;
                    pageHeight: number;
                };
                stats: unknown;
                rects: unknown;
            };
        };

        return {
            cli: {
                level: sidecar.input.level,
                pageIndex: sidecar.input.pageIndex,
                pageWidth: sidecar.result.image.pageWidth,
                pageHeight: sidecar.result.image.pageHeight,
                imageWidth: sidecar.result.image.width,
                imageHeight: sidecar.result.image.height,
                stats: sidecar.result.stats,
                rects: sidecar.result.rects,
            },
            http: {
                level: httpO.level,
                pageIndex: httpO.page_index,
                pageWidth: httpO.page_width,
                pageHeight: httpO.page_height,
                imageWidth: httpO.image_width,
                imageHeight: httpO.image_height,
                stats: httpO.stats,
                rects: httpO.rects,
            },
            deny: new Set<string>(),
            notes: [
                "PNG bytes intentionally not compared (sharp vs OffscreenCanvas).",
            ],
        };
    },
};

// -----------------------------------------------------------------------------
// analyze-layout → pdf-analyze-layout
// -----------------------------------------------------------------------------

const CASE_ANALYZE_LAYOUT: ParityCase = {
    name: "analyze-layout → pdf-analyze-layout",
    group: "analyze-layout",
    run: async (ctx) => {
        const http = await postJson(
            ctx.port,
            "/beaver/test/pdf-analyze-layout",
            {
                raw_bytes_base64: ctx.pdfB64,
                page_indices: ctx.pageIndices,
            },
        );
        assertHttpOk(http, "pdf-analyze-layout");
        // HTTP returns { ok, ...wire }; CLI returns { ok, ..., result: wire }.
        const httpWire: Record<string, unknown> = { ...http };
        delete httpWire.ok;
        const { envelope } = await runCliJson<{
            ok: true;
            result: Record<string, unknown>;
        }>([
            "analyze-layout",
            ctx.pdfPath,
            "--pages",
            ctx.pageIndices.join(","),
            "--json",
        ]);
        return {
            cli: envelope.result,
            http: httpWire,
            deny: COMMON_DENY,
        };
    },
};

const ALL_CASES: ParityCase[] = [
    CASE_PAGE_COUNT,
    CASE_PAGE_LABELS,
    CASE_RENDER,
    CASE_RENDER_WITH_META,
    CASE_RAW_DETAILED,
    CASE_EXTRACT_MARKDOWN,
    CASE_EXTRACT_PARAGRAPH,
    CASE_SENTENCE_BBOXES,
    CASE_OVERLAY,
    CASE_ANALYZE_LAYOUT,
];

// =============================================================================
// Argv parsing
// =============================================================================

interface CliArgs {
    port?: number;
    fixtures: string[];
    commands?: Set<string>;
    pageIndex: number;
    pageIndices: number[];
    reportPath: string;
    keepWork: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    let port: number | undefined;
    const fixtures: string[] = [];
    let commands: Set<string> | undefined;
    let pageIndex = 0;
    let pageIndices = [0, 1];
    let reportPath = DEFAULT_REPORT;
    let keepWork = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = (): string => {
            const v = argv[++i];
            if (v == null) throw new Error(`${a} expects a value`);
            return v;
        };
        switch (a) {
            case "--port":
                port = Number(next());
                break;
            case "--fixture":
                fixtures.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
                break;
            case "--commands":
                commands = new Set(
                    next().split(",").map((s) => s.trim()).filter(Boolean),
                );
                break;
            case "--page":
                pageIndex = Number(next());
                if (!Number.isInteger(pageIndex) || pageIndex < 0) {
                    throw new Error(`--page must be a non-negative integer`);
                }
                break;
            case "--pages":
                pageIndices = next()
                    .split(",")
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isFinite(n));
                if (pageIndices.length === 0) {
                    throw new Error(`--pages must list at least one page`);
                }
                break;
            case "--report":
                reportPath = resolve(REPO_ROOT, next());
                break;
            case "--keep-work":
                keepWork = true;
                break;
            case "-h":
            case "--help":
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown arg: ${a}`);
        }
    }

    if (fixtures.length === 0) fixtures.push(DEFAULT_FIXTURE);
    // Make sure --page is in --pages so cases that use both line up.
    if (!pageIndices.includes(pageIndex)) pageIndices = [pageIndex, ...pageIndices];

    return { port, fixtures, commands, pageIndex, pageIndices, reportPath, keepWork };
}

function printHelp(): void {
    process.stdout.write(
        [
            "Usage: npx tsx tests/scripts/cliVsHandlerParity.ts [opts]",
            "",
            "  --port <n>          HTTP port (default: probe 23119, 23124)",
            "  --fixture <path>    PDF path (repeat or comma-separate)",
            "  --commands <list>   Filter cases by group (info,render,",
            "                      raw-detailed,extract,overlay,analyze-layout)",
            "  --page <n>          Single-page argument (default 0)",
            "  --pages <list>      Multi-page argument (default 0,1)",
            "  --report <path>     Markdown report path (default tests/.parity-report.md)",
            "  --keep-work         Don't delete the temp work dir on exit",
            "",
        ].join("\n"),
    );
}

// =============================================================================
// Runner
// =============================================================================

interface CaseResult {
    fixture: string;
    case: string;
    diffs: string[];
    notes?: string[];
    error?: string;
    durationMs: number;
}

async function runOne(
    c: ParityCase,
    ctx: ParityContext,
    fixtureLabel: string,
): Promise<CaseResult> {
    const t0 = Date.now();
    try {
        const { cli, http, deny, notes } = await c.run(ctx);
        const diffs: string[] = [];
        deepDiff(cli, http, "", deny, diffs, "cli", "http", 100);
        return {
            fixture: fixtureLabel,
            case: c.name,
            diffs,
            notes,
            durationMs: Date.now() - t0,
        };
    } catch (e) {
        return {
            fixture: fixtureLabel,
            case: c.name,
            diffs: [],
            error: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - t0,
        };
    }
}

async function loadPdfBytes(path: string): Promise<Buffer> {
    const stats = await stat(path).catch(() => null);
    if (!stats || !stats.isFile()) {
        throw new Error(`Fixture not found or not a file: ${path}`);
    }
    return readFile(path);
}

function pickCases(filter: Set<string> | undefined): ParityCase[] {
    if (!filter) return ALL_CASES;
    return ALL_CASES.filter((c) => filter.has(c.group) || filter.has(c.name));
}

function buildReport(results: CaseResult[], port: number): string {
    const out: string[] = [];
    out.push("# BeaverExtract CLI ↔ HTTP parity report");
    out.push("");
    out.push(`- Generated: ${new Date().toISOString()}`);
    out.push(`- Port: ${port}`);
    const failed = results.filter((r) => r.diffs.length > 0 || r.error);
    out.push(
        `- Cases run: ${results.length} — passed: ${results.length - failed.length}, failed: ${failed.length}`,
    );
    out.push("");
    out.push("## Summary");
    out.push("");
    out.push("| Fixture | Case | Status | Diffs | Time |");
    out.push("|---|---|---|---:|---:|");
    for (const r of results) {
        const status = r.error ? "ERROR" : r.diffs.length > 0 ? "FAIL" : "PASS";
        out.push(
            `| \`${r.fixture}\` | ${r.case} | ${status} | ${r.diffs.length} | ${r.durationMs} ms |`,
        );
    }
    out.push("");

    if (failed.length === 0) {
        out.push("All cases match — no drift detected.");
        out.push("");
        return out.join("\n");
    }

    out.push("## Failures");
    out.push("");
    for (const r of failed) {
        out.push(`### ${r.fixture} — ${r.case}`);
        out.push("");
        if (r.error) {
            out.push("**Error**");
            out.push("");
            out.push("```");
            out.push(r.error);
            out.push("```");
            out.push("");
            continue;
        }
        if (r.notes && r.notes.length > 0) {
            out.push("Notes:");
            for (const n of r.notes) out.push(`- ${n}`);
            out.push("");
        }
        out.push(`Diff (cli vs http) — ${r.diffs.length} entries (truncated at 100):`);
        out.push("");
        out.push("```");
        for (const d of r.diffs) out.push(d);
        out.push("```");
        out.push("");
    }
    return out.join("\n");
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    const port = await resolvePort(args.port);
    process.stderr.write(`[parity] using port ${port}\n`);

    const cases = pickCases(args.commands);
    if (cases.length === 0) {
        process.stderr.write(
            `[parity] --commands filter matched no cases; run with --help.\n`,
        );
        return 1;
    }
    process.stderr.write(
        `[parity] running ${cases.length} case(s): ${cases.map((c) => c.name).join(", ")}\n`,
    );

    const workRoot = await mkdtemp(join(tmpdir(), "beaver-parity-"));
    try {
        const results: CaseResult[] = [];
        for (const fix of args.fixtures) {
            const fixturePath = resolve(REPO_ROOT, fix);
            const fixtureLabel = fixturePath.startsWith(REPO_ROOT)
                ? fixturePath.slice(REPO_ROOT.length + 1)
                : fixturePath;
            process.stderr.write(`\n[parity] fixture: ${fixtureLabel}\n`);
            const bytes = await loadPdfBytes(fixturePath);
            const pdfB64 = bytes.toString("base64");
            for (const c of cases) {
                const ctx: ParityContext = {
                    port,
                    pdfPath: fixturePath,
                    pdfB64,
                    pageIndex: args.pageIndex,
                    pageIndices: args.pageIndices,
                    workDir: await mkdtemp(join(workRoot, "case-")),
                };
                const r = await runOne(c, ctx, fixtureLabel);
                const status = r.error
                    ? "ERROR"
                    : r.diffs.length > 0
                      ? `FAIL (${r.diffs.length})`
                      : "PASS";
                process.stderr.write(
                    `  ${c.name}: ${status} (${r.durationMs}ms)\n`,
                );
                results.push(r);
            }
        }

        const report = buildReport(results, port);
        await mkdir(dirname(args.reportPath), { recursive: true });
        await writeFile(args.reportPath, report, "utf8");
        process.stderr.write(`\n[parity] report: ${args.reportPath}\n`);

        const failed = results.filter((r) => r.diffs.length > 0 || r.error).length;
        return failed;
    } finally {
        if (!args.keepWork) {
            await rm(workRoot, { recursive: true, force: true }).catch(() => {});
        } else {
            process.stderr.write(`[parity] kept work dir: ${workRoot}\n`);
        }
    }
}

main().then(
    (code) => {
        process.exitCode = code;
    },
    (err) => {
        process.stderr.write(
            `[parity] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
    },
);

// Apply the deny-list once before recursing so the report stays
// self-contained (we don't actually use this — `deepDiff` consults
// `deny` per-step — but exposing it makes the deny-list semantics
// easy to test from a unit test if we ever want to.)
export { deepDiff, stripDeny };
