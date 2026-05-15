/**
 * Node-only barrel for the BeaverExtract package.
 *
 * Re-exports the Node API + bootstrap + overlay + CLI runner. Does NOT
 * re-export from `../index.ts` (the main barrel) because that pulls in
 * `MuPDFWorkerClient` and the browser-side facade.
 */
export * from "./api";
export {
    ensureExtractionRuntime,
    ensureMuPDFNode,
    ensureSentencexNode,
    resetMuPDFNode,
} from "./bootstrap";
export { drawBBoxOverlayPNGNode } from "./overlayPng";
export { buildProgram, runCli } from "./runCli";
export { defaultWasmDir, repoRoot } from "./paths";
