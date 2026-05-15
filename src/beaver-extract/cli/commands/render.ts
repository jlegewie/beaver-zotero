/**
 * `beaver-extract render <pdf>` — render one or more pages to PNG.
 *
 * Always writes to `--out`. With one page selected, `--out` is treated
 * as a file path; with multiple, it's a directory and per-page files are
 * written as `page-<idx>.png`. The `--json` envelope reports written
 * paths + per-page metadata; PNG bytes are NEVER inlined into JSON
 * unless the explicit `--inline-base64` flag is set.
 */
import { Command } from "commander";
import { join } from "node:path";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";
import {
    parsePageRange,
    parsePagesList,
} from "../options";
import { pdfSha256 } from "../io";
import type { RenderPagesInput } from "../../node/api";

export function buildRenderCommand(deps: CliDeps): Command {
    const cmd = new Command("render");
    cmd.description("Render one or more PDF pages to PNG.")
        .argument("<pdf>", "path to the PDF file")
        .option("--pages <list>", "comma-separated page indices (e.g. '0,1,4')")
        .option("--page-range <range>", "page range '<start>:<end>' (end inclusive)")
        .option("--dpi <n>", "target DPI (overrides --scale)")
        .option("--scale <n>", "scale factor (1.0 = 72 DPI). Default: 2.0")
        .requiredOption("--out <path>", "output file (single page) or directory (multi-page)")
        .option("--inline-base64", "inline PNG bytes in the --json envelope as base64", false)
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | boolean | undefined>) => {
            let bytes: Uint8Array | undefined;
            const effective: Record<string, unknown> = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);
                const input: RenderPagesInput = { pdfData: bytes, options: {} };

                if (opts.pages) {
                    input.pageIndices = parsePagesList(String(opts.pages));
                    effective.pageIndices = input.pageIndices;
                }
                if (opts.pageRange) {
                    input.pageRange = parsePageRange(String(opts.pageRange));
                    effective.pageRange = input.pageRange;
                }
                if (opts.dpi != null) {
                    input.options!.dpi = Number(opts.dpi);
                    effective.dpi = input.options!.dpi;
                } else {
                    input.options!.scale = opts.scale != null ? Number(opts.scale) : 2.0;
                    effective.scale = input.options!.scale;
                }

                const result = await deps.api.renderPages(input);
                const outPath = String(opts.out);
                const isMultiPage = result.pages.length !== 1;

                const written: Array<{
                    pageIndex: number;
                    path: string;
                    width: number;
                    height: number;
                    byteLength: number;
                    sha256: string;
                    label?: string;
                    base64?: string;
                }> = [];
                for (const page of result.pages) {
                    const filename = `page-${String(page.pageIndex).padStart(4, "0")}.png`;
                    const outFile = isMultiPage ? join(outPath, filename) : outPath;
                    await deps.writePngFile(outFile, page.data);
                    const entry = {
                        pageIndex: page.pageIndex,
                        path: outFile,
                        width: page.width,
                        height: page.height,
                        byteLength: page.data.byteLength,
                        sha256: pdfSha256(page.data),
                        label: result.pageLabels[page.pageIndex],
                    } as (typeof written)[number];
                    if (opts.inlineBase64) {
                        entry.base64 = Buffer.from(page.data).toString("base64");
                    }
                    written.push(entry);
                }

                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, {
                                pageCount: result.pageCount,
                                pages: written,
                            }),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    for (const w of written) {
                        deps.stdout.write(
                            `wrote ${w.path} (${w.width}x${w.height}, ${w.byteLength} bytes)\n`,
                        );
                    }
                }
            } catch (e) {
                const env = buildErrorEnvelope(e, pdfPath, bytes, effective);
                deps.stderr.write(stringifyEnvelope(env, !!opts.pretty) + "\n");
                process.exitCode = 1;
            }
        });
    return cmd;
}
