import { describe, expect, it, vi } from "vitest";
import {
    makeDocumentApi,
    type LibMuPdf,
    type PageLike,
} from "../../../src/beaver-extract/worker/mupdfApi";
import { collectPagesData } from "../../../src/beaver-extract/worker/docHelpers";
import type { DocumentLike } from "../../../src/beaver-extract/worker/mupdfApi";

const DOC_PTR = 7;
const PAGE_PTR = 11;
const PAGE_OBJ = 13;
const ROTATE_OBJ = 17;
const CROP_BOX_OBJ = 19;
const MEDIA_BOX_OBJ = 23;

type BoxValue = number[] | "non-array" | null;

function makeGeometryLib(options: {
    rotate?: number | "non-number" | null;
    cropBox?: BoxValue;
    mediaBox?: BoxValue;
}): LibMuPdf {
    const heap = new ArrayBuffer(64 * 1024);
    const heapu8 = new Uint8Array(heap);
    const heap32 = new Int32Array(heap);
    const heapf32 = new Float32Array(heap);
    let nextPtr = 1024;
    const strings = new Map<number, string>();
    const arrays = new Map<number, number[]>();
    const numbers = new Map<number, number>();

    if (Array.isArray(options.cropBox)) arrays.set(CROP_BOX_OBJ, options.cropBox);
    if (Array.isArray(options.mediaBox)) arrays.set(MEDIA_BOX_OBJ, options.mediaBox);
    if (typeof options.rotate === "number") numbers.set(ROTATE_OBJ, options.rotate);

    const malloc = (size: number) => {
        const ptr = nextPtr;
        nextPtr += (size + 3) & ~3;
        return ptr;
    };

    const objectForKey = (keyPtr: number) => {
        switch (strings.get(keyPtr)) {
            case "Rotate":
                return options.rotate == null ? 0 : ROTATE_OBJ;
            case "CropBox":
                return options.cropBox == null ? 0 : CROP_BOX_OBJ;
            case "MediaBox":
                return options.mediaBox == null ? 0 : MEDIA_BOX_OBJ;
            default:
                return 0;
        }
    };

    return {
        HEAPU8: heapu8,
        HEAP32: heap32,
        HEAPF32: heapf32,
        lengthBytesUTF8: (s: string) => s.length,
        stringToUTF8: (s: string, ptr: number) => {
            strings.set(ptr, s);
        },
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
        _wasm_bound_page: () => 0,
        _wasm_pdf_page_get_obj: () => PAGE_OBJ,
        _wasm_pdf_dict_gets_inheritable: (_dict: number, key: number) => objectForKey(key),
        _wasm_pdf_is_array: (obj: number) => arrays.has(obj) ? 1 : 0,
        _wasm_pdf_array_len: (obj: number) => arrays.get(obj)?.length ?? 0,
        _wasm_pdf_array_get: (obj: number, index: number) => {
            const value = arrays.get(obj)?.[index];
            if (value === undefined) return 0;
            const numberObj = obj * 100 + index + 1;
            numbers.set(numberObj, value);
            return numberObj;
        },
        _wasm_pdf_is_number: (obj: number) => numbers.has(obj) ? 1 : 0,
        _wasm_pdf_to_real: (obj: number) => numbers.get(obj) ?? Number.NaN,
        _wasm_page_label: () => 0,
        _wasm_needs_password: () => 0,
        _wasm_new_stext_page_from_page: () => 0,
        _wasm_drop_stext_page: () => {},
        _wasm_print_stext_page_as_json: () => 0,
        _wasm_print_stext_page_as_text: () => 0,
        _wasm_stext_page_get_first_block: () => 0,
        _wasm_stext_block_get_type: () => 0,
        _wasm_stext_block_get_bbox: () => 0,
        _wasm_stext_block_get_first_line: () => 0,
        _wasm_stext_block_get_next: () => 0,
        _wasm_stext_line_get_bbox: () => 0,
        _wasm_stext_line_get_wmode: () => 0,
        _wasm_stext_line_get_dir: () => 0,
        _wasm_stext_line_get_first_char: () => 0,
        _wasm_stext_line_get_next: () => 0,
        _wasm_stext_char_get_c: () => 0,
        _wasm_stext_char_get_origin: () => 0,
        _wasm_stext_char_get_font: () => 0,
        _wasm_stext_char_get_size: () => 0,
        _wasm_stext_char_get_quad: () => 0,
        _wasm_stext_char_get_argb: () => 0,
        _wasm_stext_char_get_next: () => 0,
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
        _wasm_new_js_device: () => 0,
        _wasm_run_page_contents: () => {},
        _wasm_walk_path: () => {},
        _wasm_close_device: () => {},
        _wasm_drop_device: () => {},
        _wasm_colorspace_get_type: () => 0,
        _wasm_colorspace_get_n: () => 0,
    };
}

function loadPage(options: Parameters<typeof makeGeometryLib>[0]): PageLike {
    const api = makeDocumentApi(makeGeometryLib(options));
    const doc = api.Document.openDocument(new Uint8Array([1, 2, 3]));
    return doc.loadPage(0);
}

describe("MuPDF page geometry", () => {
    it.each([
        [0, 0],
        [90, 90],
        [180, 180],
        [270, 270],
        [-90, 270],
        [450, 90],
        [89, 0],
        [89.6, 0],
        [271, 0],
        [Number.NaN, 0],
        [Number.POSITIVE_INFINITY, 0],
        [1.5, 0],
    ] as const)("normalizes /Rotate %s with PDF.js semantics", (value, expected) => {
        const page = loadPage({ rotate: value });
        expect(page.getRotation()).toBe(expected);
    });

    it.each([
        [{ cropBox: [0, 0, 612, 792], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: [36, 36, 576, 756], mediaBox: [0, 0, 612, 792] }, [36, 36, 576, 756]],
        [{ cropBox: [612, 792, 0, 0], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: [-10, -10, 700, 800], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: [700, 700, 800, 800], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: [36, 36, 576, 756], mediaBox: null }, [36, 36, 576, 756]],
        [{ cropBox: null, mediaBox: null }, [0, 0, 612, 792]],
        [{ cropBox: [0, 0, 0, 792], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: "non-array", mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
        [{ cropBox: [0, 0, Number.NaN, 792], mediaBox: [0, 0, 612, 792] }, [0, 0, 612, 792]],
    ] as const)("returns the effective unrotated viewBox", (options, expected) => {
        const page = loadPage({ ...options, rotate: 0 });
        expect(page.getViewBox()).toEqual(expected);
    });
});

describe("collectPagesData", () => {
    it("keeps dense geometry entries when one page is unresolvable", () => {
        const pages = [
            {
                getLabel: () => "i",
                getViewBox: () => [0, 0, 100, 200] as [number, number, number, number],
                getRotation: () => 0 as const,
                destroy: vi.fn(),
            },
            null,
            {
                getLabel: () => "3",
                getViewBox: () => [10, 20, 110, 220] as [number, number, number, number],
                getRotation: () => 90 as const,
                destroy: vi.fn(),
            },
        ];
        const doc = {
            countPages: () => pages.length,
            loadPage: (index: number) => {
                const page = pages[index];
                if (!page) throw new Error("malformed page tree");
                return page as PageLike;
            },
        } as DocumentLike;

        const result = collectPagesData(doc);

        expect(result.pageLabels).toEqual({ 0: "i", 2: "3" });
        expect(result.pages).toEqual([
            { viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 },
            null,
            { viewBox: [10, 20, 110, 220], width: 100, height: 200, rotation: 90 },
        ]);
    });
});
