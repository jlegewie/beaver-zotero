/* tslint:disable */
/* eslint-disable */

/**
 * Returns detailed sentence boundaries for a given text based on the specified language.
 *
 * # Arguments
 *
 * * `language` - A string slice that holds the language code (e.g., "en" for English, "fr" for French).
 * * `text` - A string slice that holds the text to be analyzed.
 *
 * # Returns
 *
 * A `JsValue` containing an array of sentence boundary objects. Each object contains:
 * - `start_index`: The byte index where the sentence starts
 * - `end_index`: The byte index where the sentence ends
 * - `text`: The sentence text
 * - `boundary_symbol`: The punctuation mark that ended the sentence (if any)
 * - `is_paragraph_break`: Whether this boundary represents a paragraph break
 *
 * # Example
 *
 * ```javascript
 * import init, { get_sentence_boundaries } from './pkg/sentencex_wasm.js';
 *
 * async function run() {
 *     await init();
 *     const boundaries = get_sentence_boundaries("en", "Hello world. This is a test.");
 *     console.log(boundaries); // Array of boundary objects
 * }
 * run();
 * ```
 */
export function get_sentence_boundaries(language: string, text: string): any;

/**
 * Segments a given text into sentences based on the specified language.
 *
 * # Arguments
 *
 * * `language` - A string slice that holds the language code (e.g., "en" for English, "fr" for French).
 * * `text` - A string slice that holds the text to be segmented.
 *
 * # Returns
 *
 * A `JsValue` containing the segmented sentences as a JavaScript array.
 *
 * # Example
 *
 * ```javascript
 * import init, { segment } from './pkg/sentencex_wasm.js';
 *
 * async function run() {
 *     await init();
 *     const sentences = segment("en", "Hello world. This is a test.");
 *     console.log(sentences); // ["Hello world. ", "This is a test."]
 * }
 * run();
 * ```
 */
export function segment(language: string, text: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_sentence_boundaries: (a: number, b: number, c: number, d: number) => any;
    readonly segment: (a: number, b: number, c: number, d: number) => any;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
