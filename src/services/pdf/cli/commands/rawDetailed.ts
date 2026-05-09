/**
 * `beaver-extract raw-detailed <pdf>` — per-character quad info for one
 * page. Used for low-level extraction debugging.
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";
import { parsePageInt } from "../options";

export function buildRawDetailedCommand(deps: CliDeps): Command {
    const cmd = new Command("raw-detailed");
    cmd.description("Detailed per-character extraction for a single page.")
        .argument("<pdf>", "path to the PDF file")
        .requiredOption("--page <n>", "page index (0-based)")
        .option("--include-images", "include image data in the output", false)
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, opts: Record<string, string | boolean | undefined>) => {
            let bytes: Uint8Array | undefined;
            const pageIndex = parsePageInt(String(opts.page));
            const includeImages = !!opts.includeImages;
            const effective: Record<string, unknown> = {
                file: pdfPath,
                pageIndex,
                includeImages,
            };
            try {
                bytes = await deps.loadPdf(pdfPath);
                const result = await deps.api.extractRawPageDetailed(
                    bytes,
                    pageIndex,
                    includeImages,
                );
                if (opts.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, result),
                            !!opts.pretty,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(
                        `page ${pageIndex}: ${result.blocks.length} block(s)\n`,
                    );
                }
            } catch (e) {
                const env = buildErrorEnvelope(e, pdfPath, bytes, effective);
                deps.stderr.write(stringifyEnvelope(env, !!opts.pretty) + "\n");
                process.exitCode = 1;
            }
        });
    return cmd;
}
