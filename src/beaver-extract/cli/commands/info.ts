/**
 * `beaver-extract info <pdf>` — page count, label map, and document
 * metadata in one call. Pure read; no analysis.
 */
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    buildErrorEnvelope,
    buildSuccessEnvelope,
    stringifyEnvelope,
} from "../envelope";

export function buildInfoCommand(deps: CliDeps): Command {
    const cmd = new Command("info");
    cmd.description("Print page count and metadata for a PDF.")
        .argument("<pdf>", "path to the PDF file")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string, options: { json?: boolean; pretty?: boolean }) => {
            let bytes: Uint8Array | undefined;
            const effective = { file: pdfPath };
            try {
                bytes = await deps.loadPdf(pdfPath);
                const [count, metadata] = await Promise.all([
                    deps.api.getPageCount(bytes),
                    deps.api.getMetadata(bytes),
                ]);
                const result = { pageCount: count.count, metadata };
                if (options.json) {
                    deps.stdout.write(
                        stringifyEnvelope(
                            buildSuccessEnvelope(pdfPath, bytes, effective, result),
                            !!options.pretty,
                        ) + "\n",
                    );
                } else {
                    deps.stdout.write(
                        `pages: ${count.count}\n` +
                            `title: ${metadata.title ?? "(none)"}\n` +
                            `author: ${metadata.author ?? "(none)"}\n`,
                    );
                }
            } catch (e) {
                const env = buildErrorEnvelope(e, pdfPath, bytes, effective);
                deps.stderr.write(stringifyEnvelope(env, !!options.pretty) + "\n");
                process.exitCode = 1;
            }
        });
    return cmd;
}
