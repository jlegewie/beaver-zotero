/**
 * CLI binary entry. Thin wrapper around `runCli` so the test seam
 * (in-process `runCli`) is the only place argument-handling logic lives.
 */
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
