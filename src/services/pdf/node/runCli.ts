/**
 * In-process CLI entry: wires `commander` to the Node API.
 *
 * Tests import `runCli(argv, deps)` directly with mocked deps —
 * Vitest module mocks don't survive `child_process.spawn`, so the
 * in-process seam is the only reliable way to assert envelope shape /
 * exit codes / argument parsing without exercising MuPDF and sharp.
 *
 * The shipped `cli/main.ts` is a 5-line wrapper around `runCli`.
 */
import { Command, InvalidArgumentError } from "commander";

import * as defaultApi from "./api";
import { drawBBoxOverlayPNGNode as defaultDrawOverlay } from "./overlayPng";
import {
    loadPdf as defaultLoadPdf,
    writeJsonFile as defaultWriteJsonFile,
    writePngFile as defaultWritePngFile,
} from "../cli/io";
import { clearAllCachedDocs } from "../worker/docCache";
import { setCliLogLevel, type CliLogLevel } from "./bootstrap";
import type { CliDeps } from "../cli/runCliTypes";
import { buildAnalyzeLayoutCommand } from "../cli/commands/analyzeLayout";
import { buildExtractCommand } from "../cli/commands/extract";
import { buildFixtureCommand } from "../cli/commands/fixture";
import { buildInfoCommand } from "../cli/commands/info";
import { buildOverlayCommand } from "../cli/commands/overlay";
import { buildRawDetailedCommand } from "../cli/commands/rawDetailed";
import { buildRenderCommand } from "../cli/commands/render";

const LOG_LEVEL_CHOICES: ReadonlyArray<CliLogLevel> = [
    "error",
    "warn",
    "info",
    "silent",
];

function parseLogLevel(value: string): CliLogLevel {
    if (!(LOG_LEVEL_CHOICES as readonly string[]).includes(value)) {
        throw new InvalidArgumentError(
            `--log-level must be one of: ${LOG_LEVEL_CHOICES.join(", ")}`,
        );
    }
    return value as CliLogLevel;
}

function defaultDeps(): CliDeps {
    return {
        api: defaultApi,
        drawOverlay: defaultDrawOverlay,
        loadPdf: defaultLoadPdf,
        writePngFile: defaultWritePngFile,
        writeJsonFile: defaultWriteJsonFile,
        stdout: process.stdout,
        stderr: process.stderr,
    };
}

export function buildProgram(deps: CliDeps): Command {
    const program = new Command("beaver-extract");
    program
        .description("Local PDF extraction CLI for the BeaverExtract pipeline.")
        // Global stderr verbosity. Must be specified BEFORE the subcommand
        // (commander's default parent-option position). Default `warn` keeps
        // analyzer errors and warnings visible while suppressing the chatty
        // doc-cache + analyzer info traces. Wired to `setCliLogLevel` via the
        // preAction hook below so it applies before the runtime bootstrap
        // installs its sink.
        .option(
            "--log-level <level>",
            `stderr log verbosity: ${LOG_LEVEL_CHOICES.join(" | ")}`,
            parseLogLevel,
            "warn" as CliLogLevel,
        )
        .hook("preAction", (thisCommand) => {
            const level = thisCommand.opts().logLevel as CliLogLevel;
            setCliLogLevel(level);
        })
        .addCommand(buildInfoCommand(deps))
        .addCommand(buildExtractCommand(deps))
        .addCommand(buildOverlayCommand(deps))
        .addCommand(buildAnalyzeLayoutCommand(deps))
        .addCommand(buildRawDetailedCommand(deps))
        .addCommand(buildRenderCommand(deps))
        .addCommand(buildFixtureCommand(deps));
    program.exitOverride();
    return program;
}

/**
 * Parse and execute CLI arguments in-process.
 *
 * @returns 0 on success, 1 on extraction failure, 2 on argument-parse failure.
 *   Sets `process.exitCode` on failure so the spawned-binary path also exits
 *   non-zero without an explicit `process.exit` call.
 */
export async function runCli(
    argv: string[],
    overrides?: Partial<CliDeps>,
): Promise<number> {
    const deps = { ...defaultDeps(), ...(overrides || {}) };
    const program = buildProgram(deps);
    try {
        // commander expects argv with executable + script as the first two
        // entries, so we pad with empty placeholders (`from: "user"` mode
        // would also work but is undocumented in older commander versions).
        await program.parseAsync(["node", "beaver-extract", ...argv]);
        // `process.exitCode` widened to `string | number` in Node 22; we
        // only ever set numeric values, so coerce.
        const code = process.exitCode;
        // Cancel any pending doc-cache TTL setTimeouts so the Node process
        // can exit immediately. Without this, the worker's per-doc TTL
        // timer (60s by default) keeps the event loop alive after the CLI
        // has finished its work.
        clearAllCachedDocs(true);
        return typeof code === "number" ? code : 0;
    } catch (e) {
        const err = e as { code?: string; message?: string };
        // commander throws CommanderError for parse/help/version exits.
        // exitCode 0 (--help, --version) is success; otherwise it's an
        // argv-parse failure.
        if (err && err.code && err.code.startsWith("commander.")) {
            const ce = e as { exitCode?: number };
            return ce.exitCode ?? 2;
        }
        deps.stderr.write(
            `beaver-extract: ${err.message ?? String(e)}\n`,
        );
        clearAllCachedDocs(true);
        return 1;
    }
}
