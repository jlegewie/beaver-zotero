/**
 * CLI binary entry. Thin wrapper around `runCli` so the test seam
 * (in-process `runCli`) is the only place argument-handling logic lives.
 *
 * `dotenv/config` is imported first so `.env` is folded into `process.env`
 * before any command resolves config knobs like $BEAVER_EXTRACT_FIXTURES_DIR
 * or $BEAVER_EXTRACT_WASM_DIR. The in-process `runCli` test seam skips this
 * import on purpose — tests drive env vars explicitly.
 */
import "dotenv/config";
import { runCli } from "../node/runCli";

runCli(process.argv.slice(2)).then(
    (code) => {
        if (code !== 0) process.exitCode = code;
    },
    (err) => {
        process.stderr.write(
            `beaver-extract: unexpected error: ${
                err instanceof Error ? err.stack ?? err.message : String(err)
            }\n`,
        );
        process.exitCode = 1;
    },
);
