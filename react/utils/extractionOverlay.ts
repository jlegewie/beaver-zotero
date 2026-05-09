/**
 * Re-export shim for the shared overlay builders.
 *
 * The implementation moved to `src/services/pdf/debug/overlayBuilders.ts`
 * so the CLI can import the same builders without dragging in
 * `MuPDFWorkerClient` (which the `src/services/pdf/index.ts` barrel
 * re-exports). This file stays in place only for back-compat with the
 * React-side consumers (`extractionVisualizer.ts`, the
 * `pdf-render-overlay` HTTP handler).
 */
export {
    OVERLAY_COLORS,
    buildColumnOverlayFromPage,
    buildLineOverlayFromPage,
    buildMarginsOverlayFromAnalysis,
    buildParagraphOverlayFromPage,
    buildSentenceOverlayFromPage,
    buildSentenceOverlayFromResult,
} from "../../src/services/pdf/debug/overlayBuilders";

export type {
    OverlayLevel,
    OverlayRect,
    OverlayResult,
} from "../../src/services/pdf/debug/overlayBuilders";
