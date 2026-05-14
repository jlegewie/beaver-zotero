/**
 * Dependency contract for `runCli(argv, deps)`.
 *
 * Lifted into its own module so command builders can `import type
 * { CliDeps }` without pulling in `runCli.ts` (which imports `commander`
 * and the Node API). Keeps test stubs lightweight.
 */
import type { drawBBoxOverlayPNGNode } from "../node/overlayPng";
import type * as NodeApi from "../node/api";

export interface CliDeps {
    api: typeof NodeApi;
    drawOverlay: typeof drawBBoxOverlayPNGNode;
    loadPdf: (path: string) => Promise<Uint8Array>;
    writePngFile: (path: string, bytes: Uint8Array) => Promise<void>;
    writeJsonFile: (
        path: string,
        value: unknown,
        pretty?: boolean,
    ) => Promise<void>;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
}
