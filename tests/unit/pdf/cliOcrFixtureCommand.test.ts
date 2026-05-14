/**
 * Unit tests for `beaver-extract ocr-fixture …`.
 *
 * Runs `runCli` in-process with a mocked Node API + a real temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { runCli } from "../../../src/beaver-extract/node/runCli";
import type { CliDeps } from "../../../src/beaver-extract/cli/runCliTypes";
import type * as NodeApi from "../../../src/beaver-extract/node/api";
import type { OCRDetectionResult } from "../../../src/beaver-extract/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class StringSink extends Writable {
    chunks: string[] = [];
    _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
        this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        cb();
    }
    text(): string {
        return this.chunks.join("");
    }
}

const FAKE_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const FAKE_PDF_SHA = createHash("sha256").update(FAKE_PDF_BYTES).digest("hex");

function baseOcrResult(overrides: Partial<OCRDetectionResult> = {}): OCRDetectionResult {
    return {
        needsOCR: false,
        primaryReason: "text_extraction_acceptable",
        issueRatio: 0,
        issueBreakdown: {
            no_text_blocks: 0,
            insufficient_text: 0,
            high_whitespace_ratio: 0,
            high_newline_ratio: 0,
            low_alphanumeric_ratio: 0,
            invalid_characters: 0,
            large_image_coverage: 0,
            bbox_overflow: 0,
            excessive_line_overlap: 0,
        },
        sampledPages: 6,
        totalPages: 12,
        pageAnalyses: [
            {
                pageIndex: 1,
                hasIssues: false,
                issues: [],
                textLength: 1500,
                hasImages: false,
            },
        ],
        ...overrides,
    };
}

interface MockBundle {
    stdout: StringSink;
    stderr: StringSink;
    deps: CliDeps;
    analyze: ReturnType<typeof vi.fn>;
}

function makeDeps(result: OCRDetectionResult = baseOcrResult()): MockBundle {
    const stdout = new StringSink();
    const stderr = new StringSink();
    const analyze = vi.fn().mockResolvedValue(result);
    const fakeApi = {
        getPageCount: vi.fn(),
        getMetadata: vi.fn(),
        extractPdf: vi.fn(),
        analyzeLayout: vi.fn(),
        renderPages: vi.fn(),
        extractRawPageDetailed: vi.fn(),
        analyzeOCRNeeds: analyze,
    };
    const deps: CliDeps = {
        api: fakeApi as unknown as typeof NodeApi,
        drawOverlay: vi.fn().mockResolvedValue(new Uint8Array()),
        loadPdf: vi.fn().mockResolvedValue(FAKE_PDF_BYTES),
        writePngFile: vi.fn().mockResolvedValue(undefined),
        writeJsonFile: vi.fn().mockResolvedValue(undefined),
        stdout,
        stderr,
    };
    return { stdout, stderr, deps, analyze };
}

let tmpRoot = "";

beforeEach(() => {
    process.exitCode = undefined;
    tmpRoot = mkdtempSync(join(tmpdir(), "beaver-ocr-fixture-"));
});

afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = "";
});

function readOcrJson(id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(tmpRoot, id, "ocr.json"), "utf8")) as Record<
        string,
        unknown
    >;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

describe("ocr-fixture capture", () => {
    it("writes a fresh fixture with effectiveOptions merged from defaults", async () => {
        const { deps, stdout } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                "TESTKEY",
                "--json",
            ],
            deps,
        );
        expect(code, `stdout=${stdout.text()}`).toBe(0);

        const fix = readOcrJson("TESTKEY");
        expect(fix.schema).toBe(1);
        expect(fix.id).toBe("TESTKEY");
        expect(fix.pdfSha256).toBe(FAKE_PDF_SHA);
        expect(fix.capturedAt).toBe(fix.updatedAt);
        const config = fix.config as { options: object; effectiveOptions: { sampleSize: number } };
        expect(config.options).toEqual({});
        expect(config.effectiveOptions.sampleSize).toBe(6);
        expect((fix.expected as Record<string, unknown>).needsOCR).toBe(false);
        expect(fix.notes).toBeUndefined();

        // Shared PDF was written.
        expect(existsSync(join(tmpRoot, "_shared", `${FAKE_PDF_SHA}.pdf`))).toBe(true);
    });

    it("rejects an --id that contains __p", async () => {
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                "paperKey__p0",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/__p/);
    });

    it("refuses to overwrite an existing fixture without --update", async () => {
        const args = (extra: string[] = []) => [
            "ocr-fixture",
            "capture",
            "fake.pdf",
            "--root",
            tmpRoot,
            "--id",
            "TESTKEY",
            "--json",
            ...extra,
        ];
        expect(await runCli(args(), makeDeps().deps)).toBe(0);
        const { deps: deps2, stderr: stderr2 } = makeDeps();
        const code = await runCli(args(), deps2);
        expect(code).toBe(1);
        const env = JSON.parse(stderr2.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/--update/);
    });

    it("refuses to co-locate on a folder that already holds fixture.json", async () => {
        // Hand-write an extract fixture in the target folder.
        mkdirSync(join(tmpRoot, "TESTKEY"), { recursive: true });
        writeFileSync(join(tmpRoot, "TESTKEY", "fixture.json"), "{}");

        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                "TESTKEY",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/extract fixture/);
    });

    it("writes a notes field when --notes is provided", async () => {
        const { deps } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                "TESTKEY",
                "--notes",
                "false positive",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(0);
        const fix = readOcrJson("TESTKEY");
        expect(fix.notes).toBe("false positive");
    });

    it("reports wrote=true when --update rewrites a drifted fixture", async () => {
        const baseArgs = [
            "ocr-fixture",
            "capture",
            "fake.pdf",
            "--root",
            tmpRoot,
            "--id",
            "DRIFT",
            "--json",
        ];
        expect(await runCli(baseArgs, makeDeps().deps)).toBe(0);

        const { deps: updateDeps, stdout } = makeDeps(
            baseOcrResult({ needsOCR: true, primaryReason: "scanned_without_ocr" }),
        );
        const code = await runCli([...baseArgs, "--update"], updateDeps);
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as {
            result: { wrote: boolean; needsOCR: boolean };
        };
        expect(env.result.wrote).toBe(true);
        expect(env.result.needsOCR).toBe(true);
    });

    it("reports wrote=false when --update on an unchanged fixture is a true no-op", async () => {
        const baseArgs = [
            "ocr-fixture",
            "capture",
            "fake.pdf",
            "--root",
            tmpRoot,
            "--id",
            "NOOP",
            "--json",
        ];
        expect(await runCli(baseArgs, makeDeps().deps)).toBe(0);

        const { deps: updateDeps, stdout } = makeDeps();
        const code = await runCli([...baseArgs, "--update"], updateDeps);
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as { result: { wrote: boolean } };
        expect(env.result.wrote).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

describe("ocr-fixture evaluate", () => {
    async function captureBaseline(
        id = "EVAL",
        result: OCRDetectionResult = baseOcrResult(),
    ): Promise<void> {
        const { deps } = makeDeps(result);
        const code = await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                id,
                "--json",
            ],
            deps,
        );
        expect(code).toBe(0);
    }

    it("exits 0 when the snapshot matches", async () => {
        await captureBaseline();
        const { deps } = makeDeps();
        const code = await runCli(
            ["ocr-fixture", "evaluate", "EVAL", "--root", tmpRoot, "--json"],
            deps,
        );
        expect(code).toBe(0);
    });

    it("exits 1 with a structured envelope when the snapshot drifts", async () => {
        await captureBaseline();
        const { deps, stdout } = makeDeps(
            baseOcrResult({ needsOCR: true, primaryReason: "scanned_without_ocr" }),
        );
        const code = await runCli(
            ["ocr-fixture", "evaluate", "EVAL", "--root", tmpRoot, "--json"],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stdout.text()) as {
            ok: boolean;
            result: { diffCount: number };
        };
        expect(env.ok).toBe(false);
        expect(env.result.diffCount).toBeGreaterThan(0);
    });

    it("errors clearly when the shared PDF is missing", async () => {
        await captureBaseline();
        // Delete the shared PDF.
        rmSync(join(tmpRoot, "_shared", `${FAKE_PDF_SHA}.pdf`));
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            ["ocr-fixture", "evaluate", "EVAL", "--root", tmpRoot, "--json"],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/shared PDF missing/);
    });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ocr-fixture update", () => {
    async function captureBaseline(): Promise<string> {
        const { deps } = makeDeps();
        await runCli(
            [
                "ocr-fixture",
                "capture",
                "fake.pdf",
                "--root",
                tmpRoot,
                "--id",
                "REBASE",
                "--notes",
                "preserve me",
                "--json",
            ],
            deps,
        );
        const fix = readOcrJson("REBASE");
        return String(fix.capturedAt);
    }

    it("preserves notes by default and the file is bytewise unchanged on a no-op", async () => {
        const capturedAt = await captureBaseline();
        const path = join(tmpRoot, "REBASE", "ocr.json");
        const before = readFileSync(path);
        const beforeMtime = statSync(path).mtimeMs;

        await new Promise((r) => setTimeout(r, 10));

        const { deps } = makeDeps();
        const code = await runCli(
            ["ocr-fixture", "update", "REBASE", "--root", tmpRoot, "--json"],
            deps,
        );
        expect(code).toBe(0);

        expect(readFileSync(path).equals(before)).toBe(true);
        expect(statSync(path).mtimeMs).toBe(beforeMtime);
        const fix = readOcrJson("REBASE");
        expect(fix.capturedAt).toBe(capturedAt);
        expect(fix.notes).toBe("preserve me");
    });

    it("rewrites notes when --notes is provided and bumps updatedAt", async () => {
        await captureBaseline();
        const { deps } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "update",
                "REBASE",
                "--root",
                tmpRoot,
                "--notes",
                "new note",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(0);
        const fix = readOcrJson("REBASE");
        expect(fix.notes).toBe("new note");
        expect(fix.updatedAt).not.toBe(fix.capturedAt);
    });

    it("removes notes when --clear-notes is provided", async () => {
        await captureBaseline();
        const { deps } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "update",
                "REBASE",
                "--root",
                tmpRoot,
                "--clear-notes",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(0);
        const fix = readOcrJson("REBASE");
        expect(fix.notes).toBeUndefined();
    });

    it("rejects --notes and --clear-notes together", async () => {
        await captureBaseline();
        const { deps, stderr } = makeDeps();
        const code = await runCli(
            [
                "ocr-fixture",
                "update",
                "REBASE",
                "--root",
                tmpRoot,
                "--notes",
                "x",
                "--clear-notes",
                "--json",
            ],
            deps,
        );
        expect(code).toBe(1);
        const env = JSON.parse(stderr.text()) as { error: { message: string } };
        expect(env.error.message).toMatch(/mutually exclusive/);
    });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("ocr-fixture list", () => {
    it("emits a JSON envelope with the discovered ids", async () => {
        const idsToCapture = ["AAA", "BBB"];
        for (const id of idsToCapture) {
            const { deps } = makeDeps();
            await runCli(
                [
                    "ocr-fixture",
                    "capture",
                    "fake.pdf",
                    "--root",
                    tmpRoot,
                    "--id",
                    id,
                    "--json",
                ],
                deps,
            );
        }

        const { deps, stdout } = makeDeps();
        const code = await runCli(
            ["ocr-fixture", "list", "--root", tmpRoot, "--json"],
            deps,
        );
        expect(code).toBe(0);
        const env = JSON.parse(stdout.text()) as { result: { ids: string[] } };
        expect(env.result.ids).toEqual(["AAA", "BBB"]);
    });
});
