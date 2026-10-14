/**
 * Serializable splitter configuration. Crosses the worker boundary via
 * `postMessage`, so all members must be `structuredClone`-able.
 */
export type SentenceSplitterConfig =
    | { type: "sentencex"; language?: string }
    | { type: "simple" };
