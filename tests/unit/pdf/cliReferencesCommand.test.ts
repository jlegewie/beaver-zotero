/**
 * `beaver-extract references export|render` batch recovery, through the
 * in-process `runCli` seam with a stubbed Node API (no WASM).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../src/beaver-extract/node/runCli";
import type { CliDeps } from "../../../src/beaver-extract/cli/runCliTypes";
import type * as NodeApi from "../../../src/beaver-extract/node/api";

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
    dir = await mkdtemp(join(tmpdir(), "refs-cli-"));
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

async function ledger(out: string): Promise<Array<{ doc_id: string; status: string; fatal?: string }>> {
    const text = await readFile(`${out}.ledger.jsonl`, "utf8");
    return text.trim().split("\n").map((line) => JSON.parse(line));
}

const docs = ["a", "b", "c"].map((id) => ({ doc_id: id, pdf_path: `${id}.pdf` }));

describe("references export", () => {
    it("resets the runtime after a WASM trap so later documents still succeed", async () => {
        const referenceInputs = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => {
            if (new TextDecoder().decode(pdfData) === "b.pdf") {
                throw new Error("RuntimeError: memory access out of bounds");
            }
            return { pageCount: 1, pages: [] };
        });
        const deps = makeDeps({ referenceInputs });
        const out = join(dir, "out.jsonl");

        expect(await runCli(["references", "export", "--pdf-list", await writeList(docs), "--out", out], deps)).toBe(0);

        expect(deps.api.resetExtractionRuntime).toHaveBeenCalledTimes(1);
        const outcomes = (await ledger(out)).filter((row) => row.status !== "start");
        expect(outcomes.map((row) => [row.doc_id, row.status, row.fatal])).toEqual([
            ["a", "done", undefined],
            ["b", "failed", "trap"],
            ["c", "done", undefined],
        ]);
    });

    it("leaves a heap-exhausted document for a retry on a fresh runtime, then gives up after two starts", async () => {
        const referenceInputs = vi.fn(async () => {
            throw new Error("Aborted(OOM)");
        });
        const deps = makeDeps({ referenceInputs });
        const out = join(dir, "out.jsonl");
        const list = await writeList([docs[0]]);

        await runCli(["references", "export", "--pdf-list", list, "--out", out], deps);
        expect(deps.api.resetExtractionRuntime).toHaveBeenCalledTimes(1);
        expect((await ledger(out)).map((row) => row.status)).toEqual(["start", "retry"]);

        await runCli(["references", "export", "--pdf-list", list, "--out", out], deps);
        await runCli(["references", "export", "--pdf-list", list, "--out", out], deps);
        expect(referenceInputs).toHaveBeenCalledTimes(2);
    });

    it("keeps the runtime for ordinary per-document errors", async () => {
        const deps = makeDeps({
            referenceInputs: vi.fn(async () => {
                throw new Error("Document may require OCR");
            }),
        });
        const out = join(dir, "out.jsonl");

        await runCli(["references", "export", "--pdf-list", await writeList([docs[0]]), "--out", out], deps);

        expect(deps.api.resetExtractionRuntime).not.toHaveBeenCalled();
        expect((await ledger(out)).map((row) => row.status)).toEqual(["start", "failed"]);
    });
});

describe("references export options", () => {
    it("rejects an unsupported schema before the ledger records any document", async () => {
        const referenceInputs = vi.fn(async () => ({ pageCount: 1, pages: [] }));
        const deps = makeDeps({ referenceInputs });
        const out = join(dir, "out.jsonl");

        expect(await runCli(["references", "export", "--pdf-list", await writeList(docs), "--out", out, "--schema", "99"], deps)).toBe(1);
        expect(referenceInputs).not.toHaveBeenCalled();
        expect(existsSync(`${out}.ledger.jsonl`)).toBe(false);
    });
});

describe("references export output errors", () => {
    it("fails before extracting anything when --out can't be written", async () => {
        const referenceInputs = vi.fn(async () => ({ pageCount: 1, pages: [] }));
        const deps = makeDeps({ referenceInputs });
        const out = join(dir, "out.jsonl");
        await mkdir(out); // a directory can't be appended to

        expect(await runCli(["references", "export", "--pdf-list", await writeList(docs), "--out", out], deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("EISDIR");
        expect(referenceInputs).not.toHaveBeenCalled();
    });

    it("stops on an output error mid-run without failing the document, and retries it once fixed", async () => {
        const out = join(dir, "out.jsonl");
        // The output path turns unwritable while the first document extracts.
        const referenceInputs = vi.fn(async () => {
            if (!existsSync(out)) await mkdir(out);
            return { pageCount: 1, pages: [] };
        });
        const deps = makeDeps({ referenceInputs });
        const list = await writeList(docs.slice(0, 2));

        for (let run = 0; run < 2; run++) {
            await rm(out, { recursive: true, force: true });
            expect(await runCli(["references", "export", "--pdf-list", list, "--out", out], deps)).toBe(1);
            expect((deps.stderr as Sink).text).toContain("EISDIR");
        }
        expect((await ledger(out)).map((row) => [row.doc_id, row.status])).toEqual([
            ["a", "start"], ["a", "output_error"], ["a", "start"], ["a", "output_error"],
        ]);

        await rm(out, { recursive: true });
        referenceInputs.mockImplementation(async () => ({ pageCount: 1, pages: [] }));
        expect(await runCli(["references", "export", "--pdf-list", list, "--out", out], deps)).toBe(0);
        const rows = (await readFile(out, "utf8")).trim().split("\n").map((line) => JSON.parse(line).doc_id);
        expect(rows).toEqual(["a", "b"]);
    });

    it("drops an interrupted last row before appending on resume", async () => {
        const deps = makeDeps({ referenceInputs: vi.fn(async () => ({ pageCount: 1, pages: [] })) });
        const out = join(dir, "out.jsonl");
        await writeFile(out, JSON.stringify({ doc_id: "a" }) + "\n" + '{"doc_id":"b","pag');
        await writeFile(`${out}.ledger.jsonl`, JSON.stringify({ doc_id: "a", status: "done" }) + "\n");

        expect(await runCli(["references", "export", "--pdf-list", await writeList(docs.slice(0, 2)), "--out", out], deps)).toBe(0);

        const rows = (await readFile(out, "utf8")).trim().split("\n").map((line) => JSON.parse(line).doc_id);
        expect(rows).toEqual(["a", "b"]);
    });
});

describe("resume after interrupted writes", () => {
    it("drops a partial last ledger row instead of refusing to resume", async () => {
        const referenceInputs = vi.fn(async () => ({ pageCount: 1, pages: [] }));
        const deps = makeDeps({ referenceInputs });
        const out = join(dir, "out.jsonl");
        await writeFile(out, JSON.stringify({ doc_id: "a" }) + "\n");
        await writeFile(
            `${out}.ledger.jsonl`,
            [{ doc_id: "a", status: "start" }, { doc_id: "a", status: "done" }].map((r) => JSON.stringify(r)).join("\n")
                + '\n{"doc_id":"b","sta',
        );

        expect(await runCli(["references", "export", "--pdf-list", await writeList(docs.slice(0, 2)), "--out", out], deps)).toBe(0);

        expect(referenceInputs).toHaveBeenCalledTimes(1);
        expect((await ledger(out)).map((row) => [row.doc_id, row.status])).toEqual([
            ["a", "start"], ["a", "done"], ["b", "start"], ["b", "done"],
        ]);
    });

    it("renders a truncated PNG again and skips a complete one", async () => {
        const png = (complete: boolean) => Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            ...(complete ? [Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])] : []),
        ]);
        const outDir = join(dir, "png");
        await mkdir(outDir);
        await writeFile(join(outDir, "a__p0.png"), png(false));
        await writeFile(join(outDir, "b__p0.png"), png(true));
        const renderPages = vi.fn(async () => ({
            pageCount: 1, pageLabels: {}, pages: [{ pageIndex: 0, data: new Uint8Array([1]) }],
        }));
        const deps = makeDeps({ renderPages });
        const list = await writeList(docs.slice(0, 2).map((d) => ({ ...d, page_index: 0 })));

        expect(await runCli(["references", "render", "--page-list", list, "--out-dir", outDir], deps)).toBe(0);

        expect(renderPages).toHaveBeenCalledTimes(1);
        expect(deps.writePngFile).toHaveBeenCalledWith(join(outDir, "a__p0.png"), new Uint8Array([1]));
    });
});

describe("references render", () => {
    it("resets the runtime after a WASM trap and renders the remaining documents", async () => {
        const renderPages = vi.fn(async ({ pdfData }: { pdfData: Uint8Array }) => {
            if (new TextDecoder().decode(pdfData) === "a.pdf") throw new Error("unreachable executed");
            return { pageCount: 1, pageLabels: {}, pages: [{ pageIndex: 0, data: new Uint8Array([1]) }] };
        });
        const deps = makeDeps({ renderPages });
        const list = await writeList(docs.slice(0, 2).map((d) => ({ ...d, page_index: 0 })));

        await runCli(["references", "render", "--page-list", list, "--out-dir", join(dir, "png")], deps);

        expect(deps.api.resetExtractionRuntime).toHaveBeenCalledTimes(1);
        expect(deps.writePngFile).toHaveBeenCalledTimes(1);
        expect(deps.writePngFile).toHaveBeenCalledWith(join(dir, "png", "b__p0.png"), new Uint8Array([1]));
    });
});

describe("missing inputs", () => {
    it.each([
        ["export", ["references", "export", "--pdf-list", "MISSING", "--out", "OUT"]],
        ["render", ["references", "render", "--page-list", "MISSING", "--out-dir", "OUT"]],
        ["featurize", ["references", "featurize", "--in", "MISSING", "--out", "OUT"]],
        ["featurize line items", ["references", "featurize", "--in", "INPUTS", "--out", "OUT", "--line-items", "MISSING"]],
        ["plan", ["references", "plan", "--in", "MISSING", "--out", "OUT"]],
    ])("%s fails on a missing input file and writes no output", async (_name, args) => {
        const inputs = join(dir, "inputs.jsonl");
        await writeFile(inputs, "");
        const missing = join(dir, "missing.jsonl");
        const out = join(dir, "out", "result.jsonl");
        const argv = args.map((a) => (a === "MISSING" ? missing : a === "INPUTS" ? inputs : a === "OUT" ? out : a));
        const deps = makeDeps({ referenceInputs: vi.fn(), renderPages: vi.fn() });

        expect(await runCli(argv, deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain(`input file not found: ${missing}`);
        await expect(readFile(out, "utf8")).rejects.toThrow();
        await expect(readFile(`${out}.ledger.jsonl`, "utf8")).rejects.toThrow();
        await expect(readFile(`${out}.meta.json`, "utf8")).rejects.toThrow();
    });
});

describe("output files", () => {
    const doc = {
        doc_id: "d1",
        pageCount: 1,
        pages: [{
            width: 600,
            height: 800,
            items: [],
            input: {
                pageIndex: 0,
                width: 600,
                height: 800,
                bodySize: 10,
                items: [{
                    header: false,
                    column: 0,
                    text: "Smith, J. 2001. A title. Journal 3: 1–9.",
                    lines: [{ text: "Smith, J. 2001. A title. Journal 3: 1–9.", l: 50, t: 100, r: 400, b: 110, size: 10, role: 0, lead: 1 }],
                }],
            },
        }],
    };

    async function inputs(): Promise<string> {
        const path = join(dir, "inputs.jsonl");
        await writeFile(path, JSON.stringify(doc) + "\n");
        return path;
    }

    it("writes plans and features, including line features", async () => {
        const deps = makeDeps({});
        const plans = join(dir, "plans.jsonl");
        const features = join(dir, "features.jsonl");
        const lineItems = join(dir, "line-items.jsonl");
        await writeFile(lineItems, JSON.stringify(["d1", 0, 0]) + "\n");

        expect(await runCli(["references", "plan", "--in", await inputs(), "--out", plans], deps)).toBe(0);
        expect(JSON.parse(await readFile(plans, "utf8")).pages[0].probs).toHaveLength(1);

        expect(await runCli(
            ["references", "featurize", "--in", await inputs(), "--out", features, "--line-items", lineItems],
            deps,
        )).toBe(0);
        expect((await readFile(features, "utf8")).trim().split("\n")).toHaveLength(1);
        expect((await readFile(`${features}.lines.jsonl`, "utf8")).trim().split("\n")).toHaveLength(1);
    });

    it.each([
        ["plan", (input: string, out: string) => ["references", "plan", "--in", input, "--out", out]],
        ["featurize", (input: string, out: string) => ["references", "featurize", "--in", input, "--out", out]],
        ["featurize with line items", (input: string, out: string) =>
            ["references", "featurize", "--in", input, "--out", out, "--line-items", input]],
    ])("%s rejects an unopenable --out instead of crashing", async (_name, argv) => {
        const deps = makeDeps({});
        const out = join(dir, "no-such-dir", "out.jsonl");

        expect(await runCli(argv(await inputs(), out), deps)).toBe(1);
        expect((deps.stderr as Sink).text).toContain("ENOENT");
    });
});

describe("resumed exports with repeated document rows", () => {
    const exportRow = (docId: string, text: string) => ({
        doc_id: docId,
        ms: 1,
        pageCount: 1,
        pages: [{
            width: 600,
            height: 800,
            items: [],
            input: {
                pageIndex: 0,
                width: 600,
                height: 800,
                bodySize: 10,
                items: [{ header: false, column: 0, text, lines: [{ text, l: 50, t: 100, r: 400, b: 110, size: 10, role: 0, lead: 1 }] }],
            },
        }],
    });

    async function exports(): Promise<string[]> {
        const first = join(dir, "inputs-0.jsonl");
        const second = join(dir, "inputs-1.jsonl");
        // "a" is re-exported within a file and again in another file; the last row wins.
        await writeFile(first, [exportRow("a", "Old text."), exportRow("b", "Smith, J. 2001."), exportRow("a", "Older text.")]
            .map((r) => JSON.stringify(r)).join("\n") + "\n");
        await writeFile(second, JSON.stringify(exportRow("a", "Smith, J. 2001. A title. Journal 3: 1–9.")) + "\n");
        return [first, second];
    }

    it("plans each document once, from its last row", async () => {
        const out = join(dir, "plans.jsonl");
        expect(await runCli(["references", "plan", "--in", ...(await exports()), "--out", out], makeDeps({}))).toBe(0);
        const rows = (await readFile(out, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(rows.map((r) => r.doc_id)).toEqual(["b", "a"]);
    });

    it("featurizes each document once, including its line features", async () => {
        const out = join(dir, "features.jsonl");
        const lineItems = join(dir, "line-items.jsonl");
        await writeFile(lineItems, [["a", 0, 0], ["b", 0, 0]].map((r) => JSON.stringify(r)).join("\n") + "\n");
        expect(await runCli(
            ["references", "featurize", "--in", ...(await exports()), "--out", out, "--line-items", lineItems],
            makeDeps({}),
        )).toBe(0);
        const keys = (file: string) => readFile(file, "utf8").then((t) => t.trim().split("\n").map((l) => JSON.parse(l).slice(0, 3).join(":")));
        expect(await keys(out)).toEqual(["b:0:0", "a:0:0"]);
        expect(await keys(`${out}.lines.jsonl`)).toEqual(["b:0:0", "a:0:0"]);
    });
});
