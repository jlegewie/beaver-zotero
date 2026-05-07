/**
 * sentencex-wasm — pure helper re-exports.
 *
 * The main-thread chrome:// loader chain (`loadSentencexModule`,
 * `getSentencexSplitter`, `getSentenceSplitterWithFallback`,
 * `disposeSentencex`) was retired in Step 2 of the worker migration
 * (Stage 6) — sentencex now runs exclusively inside the MuPDF worker
 * via `worker/sentencexInit.ts` + `worker/splitterResolver.ts`. The
 * pure offset / language helpers in `sentencexShared.ts` stay; this
 * file is a back-compat re-export shim.
 */

export {
    buildByteOffsetTable,
    byteRangesToCharRanges,
    sentencexBoundariesToCharRanges,
    normalizeLanguageCode,
} from "./sentencexShared";
export type { SentencexBoundary } from "./sentencexShared";
