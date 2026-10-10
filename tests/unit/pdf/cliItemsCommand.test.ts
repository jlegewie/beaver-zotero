/**
 * `beaver-extract items export` batch handling, through the in-process
 * `runCli` seam with a stubbed Node API (no WASM).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../src/beaver-extract/node/runCli";
import type { CliDeps } from "../../../src/beaver-extract/cli/runCliTypes";
import type * as NodeApi from "../../../src/beaver-extract/node/api";
import { FEATURES, FEATURE_VERSION } from "../../../src/beaver-extract/itemTypes/features";

class Sink extends Writable {
    text = "";
    _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
        this.text += chunk.toString();
        cb();
    }
}

let dir: string;

beforeEach(async () => {
    process.exitCode = undefined;
    dir = await mkdtemp(join(tmpdir(), "items-cli-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function makeDeps(api: Partial<Record<keyof typeof NodeApi, unknown>>): CliDeps {
    return {
        api: { resetExtractionRuntime: vi.fn(), ...api } as unknown as typeof NodeApi,
        drawOverlay: vi.fn(),
        loadPdf: vi.fn(async (path: string) => new TextEncoder().encode(path)),
        writePngFile: vi.fn().mockResolvedValue(undefined),
        writeJsonFile: vi.fn(),
        stdout: new Sink(),
        stderr: new Sink(),
    };
}

async function writeList(rows: object[]): Promise<string> {
    const path = join(dir, "list.jsonl");
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
}

async function ledger(path: string): Promise<Array<{ doc_id: string; status: string; fatal?: string }>> {
    return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

const docs = ["a", "b", "c"].map((id) => ({ doc_id: id, pdf_path: `${id}.pdf` }));
const row = (pdfData: Uint8Array) => ({ format: "beaver-items-v1", task: "item-type", pdf: new TextDecoder().decode(pdfData) });

describe("items export", () => {
    it("writes one gzipped row per document, a manifest and a ledger, and skips finished documents on resume", async () => {
        const itemsExport = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => row(pdfData));
        const deps = makeDeps({ itemsExport });
        const out = join(dir, "out");
        const list = await writeList(docs);

        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--limit", "2"], deps)).toBe(0);
        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out], deps)).toBe(0);

        expect(itemsExport).toHaveBeenCalledTimes(3);
        expect(itemsExport.mock.calls[0][0]).toMatchObject({ task: "item-type", bboxPrecision: 2, schemaVersion: "5" });
        expect((await readdir(join(out, "docs"))).sort()).toEqual(["a.json.gz", "b.json.gz", "c.json.gz"]);
        const a = JSON.parse(gunzipSync(await readFile(join(out, "docs", "a.json.gz"))).toString());
        expect(a).toMatchObject({ doc_id: "a", format: "beaver-items-v1", pdf: "a.pdf" });
        expect(a).toHaveProperty("commit");
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
        expect(manifest).toMatchObject({
            task: "item-type",
            feature_set: "item-type",
            feature_version: FEATURE_VERSION,
            names: [...FEATURES],
            schema_version: "5",
            bbox_precision: 2,
            commit: a.commit,
        });
        expect((await ledger(join(out, "ledger.jsonl"))).filter((r) => r.status === "done").map((r) => r.doc_id)).toEqual(["a", "b", "c"]);
    });

    it("keeps a ledger per shard", async () => {
        const deps = makeDeps({ itemsExport: vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => row(pdfData)) });
        const out = join(dir, "out");
        const list = await writeList(docs);
        for (const shard of ["0/2", "1/2"]) {
            expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--shard", shard], deps)).toBe(0);
        }
        const done = [
            ...(await ledger(join(out, "ledger-0of2.jsonl"))),
            ...(await ledger(join(out, "ledger-1of2.jsonl"))),
        ].filter((r) => r.status === "done").map((r) => r.doc_id);
        expect(done.sort()).toEqual(["a", "b", "c"]);
    });

    it("records failed documents and resets the runtime after a WASM trap", async () => {
        const itemsExport = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => {
            if (new TextDecoder().decode(pdfData) === "b.pdf") throw new Error("RuntimeError: memory access out of bounds");
            return row(pdfData);
        });
        const deps = makeDeps({ itemsExport });
        const out = join(dir, "out");

        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", await writeList(docs), "--out", out], deps)).toBe(0);

        expect(deps.api.resetExtractionRuntime).toHaveBeenCalledTimes(1);
        expect((await ledger(join(out, "ledger.jsonl"))).filter((r) => r.status !== "start").map((r) => [r.doc_id, r.status])).toEqual([
            ["a", "done"], ["b", "failed"], ["c", "done"],
        ]);
        expect(existsSync(join(out, "docs", "b.json.gz"))).toBe(false);
    });

    it("rejects an unsupported schema before the ledger records any document", async () => {
        const itemsExport = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => row(pdfData));
        const deps = makeDeps({ itemsExport });
        const out = join(dir, "out");
        const list = await writeList(docs);

        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--schema", "99"], deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain('PDF schema "99"');
        expect(itemsExport).not.toHaveBeenCalled();
        expect(existsSync(join(out, "ledger.jsonl"))).toBe(false);

        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--schema", "5"], deps)).toBe(0);
        expect(itemsExport).toHaveBeenCalledTimes(3);
    });

    it("refuses to resume an export directory with other settings", async () => {
        const itemsExport = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => row(pdfData));
        const deps = makeDeps({ itemsExport });
        const out = join(dir, "out");
        const list = await writeList(docs);

        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--schema", "4", "--limit", "1"], deps)).toBe(0);
        const manifest = await readFile(join(out, "manifest.json"), "utf8");
        for (const args of [["--schema", "5"], ["--schema", "4", "--bbox-precision", "1"]]) {
            expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, ...args], deps)).toBe(1);
        }
        expect((deps.stderr as Sink).text).toContain("schema_version");
        expect((deps.stderr as Sink).text).toContain("bbox_precision");
        expect(itemsExport).toHaveBeenCalledTimes(1);
        expect(await readFile(join(out, "manifest.json"), "utf8")).toBe(manifest);

        // A stale feature set is refused the same way.
        await writeFile(join(out, "manifest.json"), manifest.replace(`"feature_version": ${FEATURE_VERSION}`, `"feature_version": ${FEATURE_VERSION - 1}`));
        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--schema", "4"], deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("feature_version");

        await writeFile(join(out, "manifest.json"), manifest);
        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--schema", "4"], deps)).toBe(0);
        expect(itemsExport).toHaveBeenCalledTimes(3);
    });

    it("lets one of two shards starting together claim a new directory and refuses the other's settings", async () => {
        const itemsExport = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => row(pdfData));
        const out = join(dir, "out");
        const list = await writeList(docs);
        const deps = [makeDeps({ itemsExport }), makeDeps({ itemsExport })];
        const codes = await Promise.all([
            runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--shard", "0/2", "--schema", "4"], deps[0]),
            runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--out", out, "--shard", "1/2", "--schema", "5"], deps[1]),
        ]);

        expect([...codes].sort()).toEqual([0, 1]);
        const winner = codes.indexOf(0);
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
        expect(manifest.schema_version).toBe(winner === 0 ? "4" : "5");
        expect((deps[1 - winner].stderr as Sink).text).toContain("schema_version");
        // Only the winner extracted, all with its schema; no temp files remain.
        expect(new Set(itemsExport.mock.calls.map(([args]) => (args as unknown as { schemaVersion: string }).schemaVersion))).toEqual(
            new Set([manifest.schema_version]),
        );
        expect((await readdir(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("exports the regions-v2 task for the listed pages only, and reports listed pages a document lacks", async () => {
        const regionsExport = vi.fn(async ({ pages }: { pages?: number[] }) => ({
            format: "beaver-regions-v1",
            pages: (pages ?? []).filter((i) => i < 3).map((index) => ({ index })),
        }));
        const itemsExport = vi.fn();
        const deps = makeDeps({ regionsExport, itemsExport });
        const out = join(dir, "out");
        const list = await writeList(docs);
        const pageList = join(dir, "pages.jsonl");
        await writeFile(pageList, [{ doc_id: "a", page_index: 2 }, { doc_id: "a", page_index: 0 }, { doc_id: "c", page_index: 7 }].map((r) => JSON.stringify(r)).join("\n") + "\n");

        const args = ["items", "export", "--task", "regions-v2", "--pdf-list", list, "--page-list", pageList, "--out", out];
        expect(await runCli(args, deps)).toBe(0);

        expect(itemsExport).not.toHaveBeenCalled();
        expect(regionsExport.mock.calls.map(([call]) => call)).toEqual([
            expect.objectContaining({ pages: [2, 0], bboxPrecision: 2, schemaVersion: "5" }),
            expect.objectContaining({ pages: [7] }),
        ]);
        expect((await readdir(join(out, "docs"))).sort()).toEqual(["a.json.gz", "c.json.gz"]);
        const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
        expect(manifest).toMatchObject({ format: "beaver-regions-v1", task: "regions-v2", feature_set: null, feature_version: null, schema_version: "5" });
        expect(manifest.page_list_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect((await ledger(join(out, "ledger.jsonl"))).filter((r) => r.status === "done")).toEqual([
            expect.not.objectContaining({ missing_pages: expect.anything() }),
            expect.objectContaining({ doc_id: "c", missing_pages: [7] }),
        ]);

        // Another page selection is another export.
        await writeFile(pageList, JSON.stringify({ doc_id: "b", page_index: 1 }) + "\n");
        expect(await runCli(args, deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("page_list_sha256");
    });

    it("refuses a page list for item tasks and a schema without regions for regions-v2", async () => {
        const deps = makeDeps({ itemsExport: vi.fn(), regionsExport: vi.fn() });
        const list = await writeList(docs);
        const pageList = join(dir, "pages.jsonl");
        await writeFile(pageList, JSON.stringify({ doc_id: "a", page_index: 0 }) + "\n");
        expect(await runCli(["items", "export", "--task", "item-type", "--pdf-list", list, "--page-list", pageList, "--out", join(dir, "o1")], deps)).toBe(1);
        expect(await runCli(["items", "export", "--task", "regions-v2", "--pdf-list", list, "--schema", "4", "--out", join(dir, "o2")], deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("--page-list is only for");
        expect((deps.stderr as Sink).text).toContain("needs a schema with region detection");
        expect(deps.api.regionsExport).not.toHaveBeenCalled();
    });

    it("rejects an unknown task before extracting anything", async () => {
        const itemsExport = vi.fn();
        const deps = makeDeps({ itemsExport });
        expect(await runCli(["items", "export", "--task", "nope", "--pdf-list", await writeList(docs), "--out", join(dir, "out")], deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("unknown task");
        expect(itemsExport).not.toHaveBeenCalled();
    });
});
