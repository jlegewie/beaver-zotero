/**
 * Hermetic test for the structured-text walker's rune decoding.
 *
 * Stands in a minimal libmupdf-shaped fake and drives one text block /
 * one line through `makeDocumentApi(...)` -> `Document.openDocument`
 * -> `Page.toStructuredText` -> `StructuredText.walk`. The fake's
 * `_wasm_stext_char_get_c` returns whatever codepoint the test asks for.
 *
 * Regression target: codepoints above 0xFFFF (emoji, U+1D400 mathematical
 * bold, extended CJK) must be decoded with `String.fromCodePoint`, not
 * `String.fromCharCode` — the latter silently truncates to a single UTF-16
 * unit and produces wrong text. The downstream
 * `ParagraphSentenceMapper.buildParagraphText` invariant
 * (`line.text.length === line.chars.length`) still trips on surrogate
 * pairs; the win here is "wrong character, no degradation" -> "correct
 * character, honest degradation", not full sentence-level granularity.
 */

import { describe, it, expect } from "vitest";
import {
    makeDocumentApi,
    sanitizeRune,
    type LibMuPdf,
    type StructuredTextWalker,
} from "../../../src/beaver-extract/worker/mupdfApi";

const BLOCK_PTR = 100;
const LINE_PTR = 200;
const CHAR_BASE = 300; // chars at 300, 301, ...
const DOC_PTR = 7;
const PAGE_PTR = 11;
const STEXT_PTR = 13;
const FONT_PTR = 17;

function makeFakeLibMuPdf(charCodepoints: number[]): LibMuPdf {
    // Bump allocator. We hand out raw byte addresses; callers reading
    // floats/ints index via `ptr >> 2`. Heap is sized generously so a
    // few hundred small allocations never overflow.
    const heap = new ArrayBuffer(64 * 1024);
    const heapu8 = new Uint8Array(heap);
    const heap32 = new Int32Array(heap);
    const heapf32 = new Float32Array(heap);
    let nextPtr = 1024; // leave 0 as "null"

    const malloc = (size: number) => {
        const aligned = (size + 3) & ~3;
        const p = nextPtr;
        nextPtr += aligned;
        return p;
    };

    const writeRect = (ptr: number, x0: number, y0: number, x1: number, y1: number) => {
        const a = ptr >> 2;
        heapf32[a + 0] = x0;
        heapf32[a + 1] = y0;
        heapf32[a + 2] = x1;
        heapf32[a + 3] = y1;
    };

    const writeQuad = (ptr: number, q: number[]) => {
        const a = ptr >> 2;
        for (let i = 0; i < 8; i++) heapf32[a + i] = q[i];
    };

    const blockBBoxPtr = malloc(16);
    writeRect(blockBBoxPtr, 0, 0, 100, 20);

    const lineBBoxPtr = malloc(16);
    writeRect(lineBBoxPtr, 0, 0, 100, 20);

    const lineDirPtr = malloc(8);
    heapf32[(lineDirPtr >> 2) + 0] = 1;
    heapf32[(lineDirPtr >> 2) + 1] = 0;

    const charQuadPtr = malloc(32);

    const charPtrOf = (idx: number) => CHAR_BASE + idx;
    const charIndexOf = (ptr: number) => ptr - CHAR_BASE;

    return {
        HEAPU8: heapu8,
        HEAP32: heap32,
        HEAPF32: heapf32,
        lengthBytesUTF8: (s: string) => s.length + 1,
        stringToUTF8: () => {},
        UTF8ToString: () => "",
        _wasm_malloc: malloc,
        _wasm_free: () => {},
        _wasm_init_context: () => {},
        _wasm_new_buffer_from_data: () => 1,
        _wasm_drop_buffer: () => {},
        _wasm_buffer_get_data: () => 0,
        _wasm_buffer_get_len: () => 0,
        _wasm_open_document_with_buffer: () => DOC_PTR,
        _wasm_drop_document: () => {},
        _wasm_count_pages: () => 1,
        _wasm_lookup_metadata: () => 0,
        _wasm_load_page: () => PAGE_PTR,
        _wasm_drop_page: () => {},
        _wasm_bound_page: () => blockBBoxPtr,
        _wasm_page_label: () => 0,
        _wasm_needs_password: () => 0,
        _wasm_new_stext_page_from_page: () => STEXT_PTR,
        _wasm_drop_stext_page: () => {},
        _wasm_print_stext_page_as_json: () => 0,
        _wasm_print_stext_page_as_text: () => 0,
        _wasm_stext_page_get_first_block: () => BLOCK_PTR,
        _wasm_stext_block_get_type: () => 0, // text
        _wasm_stext_block_get_bbox: () => blockBBoxPtr,
        _wasm_stext_block_get_first_line: () => LINE_PTR,
        _wasm_stext_block_get_next: () => 0,
        _wasm_stext_line_get_bbox: () => lineBBoxPtr,
        _wasm_stext_line_get_wmode: () => 0,
        _wasm_stext_line_get_dir: () => lineDirPtr,
        _wasm_stext_line_get_first_char: () =>
            charCodepoints.length > 0 ? charPtrOf(0) : 0,
        _wasm_stext_line_get_next: () => 0,
        _wasm_stext_char_get_c: (chPtr: number) =>
            charCodepoints[charIndexOf(chPtr)],
        _wasm_stext_char_get_origin: () => lineDirPtr,
        _wasm_stext_char_get_font: () => FONT_PTR,
        _wasm_stext_char_get_size: () => 12,
        _wasm_stext_char_get_quad: (chPtr: number) => {
            const idx = charIndexOf(chPtr);
            writeQuad(charQuadPtr, [
                idx * 10, 0,
                idx * 10 + 10, 0,
                idx * 10, 20,
                idx * 10 + 10, 20,
            ]);
            return charQuadPtr;
        },
        _wasm_stext_char_get_argb: () => 0,
        _wasm_stext_char_get_next: (chPtr: number) => {
            const idx = charIndexOf(chPtr);
            return idx + 1 < charCodepoints.length ? charPtrOf(idx + 1) : 0;
        },
        _wasm_font_get_name: () => 0,
        _wasm_font_is_bold: () => 0,
        _wasm_font_is_italic: () => 0,
        _wasm_search_page: () => 0,
        _wasm_new_pixmap_from_page: () => 0,
        _wasm_new_pixmap_from_page_contents: () => 0,
        _wasm_new_buffer_from_pixmap_as_png: () => 0,
        _wasm_new_buffer_from_pixmap_as_jpeg: () => 0,
        _wasm_drop_pixmap: () => {},
        _wasm_pixmap_get_w: () => 0,
        _wasm_pixmap_get_h: () => 0,
        _wasm_pixmap_get_stride: () => 0,
        _wasm_pixmap_get_n: () => 0,
        _wasm_pixmap_get_alpha: () => 0,
        _wasm_pixmap_get_samples: () => 0,
        _wasm_device_gray: () => 0,
        _wasm_device_rgb: () => 0,
        _wasm_device_bgr: () => 0,
        _wasm_device_cmyk: () => 0,
    } as unknown as LibMuPdf;
}

function walkOneLine(codepoints: number[]) {
    const fake = makeFakeLibMuPdf(codepoints);
    const api = makeDocumentApi(fake);
    const doc = api.Document.openDocument(new Uint8Array(8));
    try {
        const page = doc.loadPage(0);
        try {
            const stext = page.toStructuredText("preserve-whitespace,preserve-ligatures");
            try {
                const onChar: string[] = [];
                const lineFonts: { fontPtr: number; size: number }[] = [];
                const walker: StructuredTextWalker = {
                    onLineFont: (fontPtr, size) => {
                        lineFonts.push({ fontPtr, size });
                    },
                    onChar: (rune) => {
                        onChar.push(rune);
                    },
                };
                stext.walk(walker);
                return { onChar, lineFonts };
            } finally {
                stext.destroy();
            }
        } finally {
            page.destroy();
        }
    } finally {
        doc.destroy();
    }
}

describe("StructuredText.walk rune decoding", () => {
    it("preserves a non-BMP emoji codepoint (U+1F600)", () => {
        const { onChar } = walkOneLine([0x1f600]);
        // Surrogate pair — 2 UTF-16 units, but a single Unicode scalar.
        expect(onChar).toEqual(["\u{1F600}"]);
        expect(onChar[0].length).toBe(2);
        expect(onChar[0].codePointAt(0)).toBe(0x1f600);
    });

    it("preserves U+1D400 mathematical bold A", () => {
        const { onChar } = walkOneLine([0x1d400]);
        expect(onChar).toEqual(["\u{1D400}"]);
        expect(onChar[0].codePointAt(0)).toBe(0x1d400);
    });

    it("passes BMP characters through unchanged", () => {
        const { onChar } = walkOneLine([0x41, 0x42, 0x43]); // "ABC"
        expect(onChar).toEqual(["A", "B", "C"]);
    });

    it("preserves a mixed BMP + non-BMP run", () => {
        const { onChar } = walkOneLine([0x48, 0x69, 0x20, 0x1f600]); // "Hi 😀"
        expect(onChar.join("")).toBe("Hi \u{1F600}");
        // chars-array length still tracks codepoints, not UTF-16 units.
        expect(onChar.length).toBe(4);
    });

    it("emits onLineFont exactly once per non-empty line", () => {
        const { lineFonts } = walkOneLine([0x41, 0x42, 0x43]);
        expect(lineFonts.length).toBe(1);
        expect(lineFonts[0]).toEqual({ fontPtr: FONT_PTR, size: 12 });
    });

    // `use-cid-for-unknown-unicode` can make MuPDF emit a raw CID that
    // sits in the surrogate range (e.g. U+D835, shared by the math
    // alphanumeric block) for an unmappable glyph. The walker must not
    // pass an unpaired surrogate through — it is invalid Unicode and
    // breaks strict UTF-8 serialization downstream.
    it("replaces an unpaired high surrogate (U+D835) with U+FFFD", () => {
        const { onChar } = walkOneLine([0xd835]);
        expect(onChar).toEqual(["�"]);
        // Single UTF-16 unit, so the text/chars lockstep invariant holds.
        expect(onChar[0].length).toBe(1);
    });

    it("replaces an unpaired low surrogate (U+DC00) with U+FFFD", () => {
        const { onChar } = walkOneLine([0xdc00]);
        expect(onChar).toEqual(["�"]);
    });

    it("keeps real text intact around a stray surrogate", () => {
        const { onChar } = walkOneLine([0x48, 0xd835, 0x69]); // "H? i"
        expect(onChar.join("")).toBe("H�i");
        expect(onChar.length).toBe(3);
    });
});

describe("sanitizeRune", () => {
    it("maps lone surrogate code points to U+FFFD", () => {
        expect(sanitizeRune(0xd800)).toBe("�");
        expect(sanitizeRune(0xd835)).toBe("�");
        expect(sanitizeRune(0xdc00)).toBe("�");
        expect(sanitizeRune(0xdfff)).toBe("�");
    });

    it("passes BMP code points through unchanged", () => {
        expect(sanitizeRune(0x41)).toBe("A");
        expect(sanitizeRune(0xd7ff)).toBe("\ud7ff"); // just below the range
        expect(sanitizeRune(0xe000)).toBe("\ue000"); // just above the range
    });

    it("preserves valid astral code points as surrogate pairs", () => {
        expect(sanitizeRune(0x1d400)).toBe("\u{1D400}");
        expect(sanitizeRune(0x1f600)).toBe("\u{1F600}");
        expect(sanitizeRune(0x1d400).length).toBe(2);
    });
});
