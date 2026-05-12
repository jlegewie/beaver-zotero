/**
 * MuPDF API wrappers (Document/Page/StructuredText/Pixmap/ColorSpace/Matrix).
 *
 * The worker is self-contained by design — these wrappers are the only
 * surface that touches libmupdf-wasm. Every routine used by orchestration
 * ops must be in this file.
 */

/**
 * Minimal type for the libmupdf WASM module. We declare only the symbols
 * actually invoked; everything else is reached through `(libmupdf as any)`
 * boundaries inside the wrappers. Full coverage of the WASM ABI is not
 * worth the engineering cost.
 */
export interface LibMuPdf {
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
    HEAPF32: Float32Array;
    lengthBytesUTF8(str: string): number;
    stringToUTF8(str: string, ptr: number, max: number): void;
    UTF8ToString(ptr: number): string;
    _wasm_malloc(size: number): number;
    _wasm_free(ptr: number): void;
    _wasm_init_context(): void;
    _wasm_new_buffer_from_data(ptr: number, len: number): number;
    _wasm_drop_buffer(ptr: number): void;
    _wasm_buffer_get_data(ptr: number): number;
    _wasm_buffer_get_len(ptr: number): number;
    _wasm_open_document_with_buffer(magic: number, buffer: number): number;
    _wasm_drop_document(ptr: number): void;
    _wasm_count_pages(ptr: number): number;
    _wasm_lookup_metadata(ptr: number, key: number): number;
    _wasm_load_page(ptr: number, index: number): number;
    _wasm_drop_page(ptr: number): void;
    _wasm_bound_page(ptr: number, boxIdx: number): number;
    _wasm_page_label(ptr: number): number;
    _wasm_needs_password?(ptr: number): number;
    _wasm_new_stext_page_from_page(page: number, opts: number): number;
    _wasm_drop_stext_page(ptr: number): void;
    _wasm_print_stext_page_as_json(ptr: number, scale: number): number;
    _wasm_print_stext_page_as_text(ptr: number): number;
    _wasm_stext_page_get_first_block(ptr: number): number;
    _wasm_stext_block_get_type(ptr: number): number;
    _wasm_stext_block_get_bbox(ptr: number): number;
    _wasm_stext_block_get_first_line(ptr: number): number;
    _wasm_stext_block_get_next(ptr: number): number;
    _wasm_stext_line_get_bbox(ptr: number): number;
    _wasm_stext_line_get_wmode(ptr: number): number;
    _wasm_stext_line_get_dir(ptr: number): number;
    _wasm_stext_line_get_first_char(ptr: number): number;
    _wasm_stext_line_get_next(ptr: number): number;
    _wasm_stext_char_get_c(ptr: number): number;
    _wasm_stext_char_get_origin(ptr: number): number;
    _wasm_stext_char_get_font(ptr: number): number;
    _wasm_stext_char_get_size(ptr: number): number;
    _wasm_stext_char_get_quad(ptr: number): number;
    _wasm_stext_char_get_argb(ptr: number): number;
    _wasm_stext_char_get_next(ptr: number): number;
    _wasm_font_get_name(ptr: number): number;
    _wasm_font_is_bold(ptr: number): number;
    _wasm_font_is_italic(ptr: number): number;
    _wasm_search_page(page: number, needle: number, marks: number, hits: number, max: number): number;
    _wasm_new_pixmap_from_page(page: number, matrix: number, cs: number, alpha: number): number;
    _wasm_new_pixmap_from_page_contents(page: number, matrix: number, cs: number, alpha: number): number;
    _wasm_new_buffer_from_pixmap_as_png(ptr: number): number;
    _wasm_new_buffer_from_pixmap_as_jpeg(ptr: number, q: number, invertCmyk: number): number;
    _wasm_drop_pixmap(ptr: number): void;
    _wasm_pixmap_get_w(ptr: number): number;
    _wasm_pixmap_get_h(ptr: number): number;
    _wasm_pixmap_get_stride(ptr: number): number;
    _wasm_pixmap_get_n(ptr: number): number;
    _wasm_pixmap_get_alpha(ptr: number): number;
    _wasm_pixmap_get_samples(ptr: number): number;
    _wasm_device_gray(): number;
    _wasm_device_rgb(): number;
    _wasm_device_bgr(): number;
    _wasm_device_cmyk(): number;
    [key: string]: unknown;
}

export type MatrixTuple = [number, number, number, number, number, number];
export type RectTuple = [number, number, number, number];
export type QuadTuple = [number, number, number, number, number, number, number, number];

export interface ColorSpaceLike {
    pointer: number;
}

export interface PixmapLike {
    pointer: number;
    getWidth(): number;
    getHeight(): number;
    getStride(): number;
    getNumberOfComponents(): number;
    getAlpha(): number;
    getSamples(): Uint8Array;
    asPNG(): Uint8Array;
    asJPEG(quality?: number, invertCmyk?: boolean): Uint8Array;
    destroy(): void;
}

export interface StructuredTextWalker {
    beginTextBlock?(bbox: RectTuple): void;
    endTextBlock?(): void;
    beginLine?(bbox: RectTuple, wmode: number, dir: [number, number]): void;
    /**
     * Fires once per non-empty line, before any `onChar` for that line.
     * Reports the first character's font pointer and size — emitted once
     * here instead of per-char because every consumer treats line-level
     * font as a property of the line, not the character.
     */
    onLineFont?(fontPtr: number, size: number): void;
    endLine?(): void;
    onChar?(rune: string, quad: QuadTuple): void;
    onImageBlock?(bbox: RectTuple, transform: unknown, image: unknown): void;
}

export interface StructuredTextLike {
    pointer: number;
    asJSON(scale?: number): string;
    asText(): string;
    walk(walker: StructuredTextWalker): void;
    destroy(): void;
}

export interface PageLike {
    pointer: number;
    getBounds(box?: "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox"): RectTuple;
    getLabel(): string | undefined;
    toStructuredText(options?: string): StructuredTextLike;
    toPixmap(matrix: MatrixTuple, colorspace: ColorSpaceLike, alpha?: boolean, showExtras?: boolean): PixmapLike;
    search(needle: string, maxHits?: number): QuadTuple[][];
    destroy(): void;
}

export interface DocumentLike {
    pointer: number;
    needsPassword(): boolean;
    countPages(): number;
    getMetadata(key: string): string | undefined;
    loadPage(index: number): PageLike;
    destroy(): void;
}

export interface DocumentStaticApi {
    openDocument(data: Uint8Array | ArrayBuffer, magic?: string): DocumentLike;
}

export interface MatrixApi {
    identity: MatrixTuple;
    scale(sx: number, sy: number): MatrixTuple;
    translate(tx: number, ty: number): MatrixTuple;
    rotate(degrees: number): MatrixTuple;
    concat(one: MatrixTuple, two: MatrixTuple): MatrixTuple;
}

export interface ColorSpacePalette {
    DeviceGray: ColorSpaceLike;
    DeviceRGB: ColorSpaceLike;
    DeviceBGR: ColorSpaceLike;
    DeviceCMYK: ColorSpaceLike;
}

/**
 * Direct accessors over a font pointer produced by the structured-text
 * walker. The walker passes `fontPtr` (a wasm pointer) to its `onChar`
 * callback; consumers that want family/weight/style without parsing the
 * full JSON serializer use these wrappers.
 */
export interface FontApi {
    getName(fontPtr: number): string;
    isBold(fontPtr: number): boolean;
    isItalic(fontPtr: number): boolean;
}

export interface MuPDFApi {
    Document: DocumentStaticApi;
    Matrix: MatrixApi;
    ColorSpace: ColorSpacePalette;
    Font: FontApi;
}

/**
 * Build the API wrappers around a libmupdf module. Allocates real WASM
 * heap (scratch UTF8/Matrix slots, ColorSpace pointers) — call once per
 * worker lifetime via `ensureApi()`.
 */
export function makeDocumentApi(libmupdf: LibMuPdf): MuPDFApi {
    const Malloc = (size: number) => libmupdf._wasm_malloc(size);
    const Free = (ptr: number) => libmupdf._wasm_free(ptr);

    const allocateUTF8 = (str: string) => {
        const size = libmupdf.lengthBytesUTF8(str) + 1;
        const ptr = Malloc(size);
        libmupdf.stringToUTF8(str, ptr, size);
        return ptr;
    };

    const fromString = (ptr: number) => libmupdf.UTF8ToString(ptr);
    const fromStringFree = (ptr: number) => {
        const str = libmupdf.UTF8ToString(ptr);
        Free(ptr);
        return str;
    };

    // Scratch UTF8 slot, freed and reallocated on every STRING() call so
    // we never accumulate per-op allocations beyond a single live slot.
    const _wasm_string: [number, number] = [0, 0];
    const STRING = (s: string): number => {
        if (_wasm_string[0]) {
            Free(_wasm_string[0]);
            _wasm_string[0] = 0;
        }
        return (_wasm_string[0] = allocateUTF8(s));
    };

    // Buffer helper — copies bytes into a fresh WASM buffer.
    const createBuffer = (data: Uint8Array | ArrayBuffer): number => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const data_len = bytes.byteLength;
        const data_ptr = Malloc(data_len);
        libmupdf.HEAPU8.set(bytes, data_ptr);
        return libmupdf._wasm_new_buffer_from_data(data_ptr, data_len);
    };

    const fromRect = (ptr: number): RectTuple => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
        ];
    };

    const fromQuad = (ptr: number): QuadTuple => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
            libmupdf.HEAPF32[a + 4],
            libmupdf.HEAPF32[a + 5],
            libmupdf.HEAPF32[a + 6],
            libmupdf.HEAPF32[a + 7],
        ];
    };

    // Matrix scratch (6 floats), reused across calls.
    const _wasm_matrix = Malloc(4 * 6) >> 2;
    const MATRIX = (m: MatrixTuple): number => {
        libmupdf.HEAPF32[_wasm_matrix + 0] = m[0];
        libmupdf.HEAPF32[_wasm_matrix + 1] = m[1];
        libmupdf.HEAPF32[_wasm_matrix + 2] = m[2];
        libmupdf.HEAPF32[_wasm_matrix + 3] = m[3];
        libmupdf.HEAPF32[_wasm_matrix + 4] = m[4];
        libmupdf.HEAPF32[_wasm_matrix + 5] = m[5];
        return _wasm_matrix << 2;
    };

    const Matrix: MatrixApi = {
        identity: [1, 0, 0, 1, 0, 0],
        scale(sx, sy) {
            return [sx, 0, 0, sy, 0, 0];
        },
        translate(tx, ty) {
            return [1, 0, 0, 1, tx, ty];
        },
        rotate(degrees) {
            let d = degrees;
            while (d < 0) d += 360;
            while (d >= 360) d -= 360;
            const s = Math.sin((d * Math.PI) / 180);
            const c = Math.cos((d * Math.PI) / 180);
            return [c, s, -s, c, 0, 0];
        },
        concat(one, two) {
            return [
                one[0] * two[0] + one[1] * two[2],
                one[0] * two[1] + one[1] * two[3],
                one[2] * two[0] + one[3] * two[2],
                one[2] * two[1] + one[3] * two[3],
                one[4] * two[0] + one[5] * two[2] + two[4],
                one[4] * two[1] + one[5] * two[3] + two[5],
            ];
        },
    };

    class ColorSpaceImpl implements ColorSpaceLike {
        constructor(public pointer: number) {}
    }
    const ColorSpace: ColorSpacePalette = {
        DeviceGray: new ColorSpaceImpl(libmupdf._wasm_device_gray()),
        DeviceRGB: new ColorSpaceImpl(libmupdf._wasm_device_rgb()),
        DeviceBGR: new ColorSpaceImpl(libmupdf._wasm_device_bgr()),
        DeviceCMYK: new ColorSpaceImpl(libmupdf._wasm_device_cmyk()),
    };

    class Pixmap implements PixmapLike {
        constructor(public pointer: number) {}
        getWidth() {
            return libmupdf._wasm_pixmap_get_w(this.pointer);
        }
        getHeight() {
            return libmupdf._wasm_pixmap_get_h(this.pointer);
        }
        getStride() {
            return libmupdf._wasm_pixmap_get_stride(this.pointer);
        }
        getNumberOfComponents() {
            return libmupdf._wasm_pixmap_get_n(this.pointer);
        }
        getAlpha() {
            return libmupdf._wasm_pixmap_get_alpha(this.pointer);
        }
        getSamples() {
            const stride = this.getStride();
            const height = this.getHeight();
            const ptr = libmupdf._wasm_pixmap_get_samples(this.pointer);
            return new Uint8Array(libmupdf.HEAPU8.buffer, ptr, stride * height);
        }
        asPNG() {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_png(this.pointer);
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        asJPEG(quality = 85, invertCmyk = false) {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_jpeg(
                this.pointer,
                quality,
                invertCmyk ? 1 : 0,
            );
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_pixmap(this.pointer);
                this.pointer = 0;
            }
        }
    }

    const runSearch = (
        searchFun: (this_: number, needle: number, marks: number, hits: number, max: number) => number,
        searchThis: number,
        needle: string,
        maxHits = 500,
    ): QuadTuple[][] => {
        let hits = 0;
        let marks = 0;
        try {
            hits = Malloc(32 * maxHits);
            marks = Malloc(4 * maxHits);
            const n = searchFun(searchThis, STRING(needle), marks, hits, maxHits);
            const outer: QuadTuple[][] = [];
            if (n > 0) {
                let inner: QuadTuple[] = [];
                for (let i = 0; i < n; i++) {
                    const mark = libmupdf.HEAP32[(marks >> 2) + i];
                    const quad = fromQuad(hits + i * 32);
                    if (i > 0 && mark) {
                        outer.push(inner);
                        inner = [];
                    }
                    inner.push(quad);
                }
                outer.push(inner);
            }
            return outer;
        } finally {
            Free(marks);
            Free(hits);
        }
    };

    class Page implements PageLike {
        constructor(public pointer: number) {}
        getBounds(box: "MediaBox" | "CropBox" | "BleedBox" | "TrimBox" | "ArtBox" = "CropBox") {
            const boxTypes: Record<string, number> = {
                MediaBox: 0,
                CropBox: 1,
                BleedBox: 2,
                TrimBox: 3,
                ArtBox: 4,
            };
            const boxIdx = boxTypes[box] ?? 1;
            return fromRect(libmupdf._wasm_bound_page(this.pointer, boxIdx));
        }
        getLabel() {
            const ptr = libmupdf._wasm_page_label(this.pointer);
            if (!ptr) return undefined;
            return fromString(ptr);
        }
        toStructuredText(options = ""): StructuredTextLike {
            const optionsPtr = STRING(options);
            const stextPtr = libmupdf._wasm_new_stext_page_from_page(this.pointer, optionsPtr);
            if (!stextPtr) {
                throw new Error("Failed to create structured text");
            }
            return new StructuredText(stextPtr);
        }
        toPixmap(matrix: MatrixTuple, colorspace: ColorSpaceLike, alpha = false, showExtras = true) {
            let result: number;
            if (showExtras) {
                result = libmupdf._wasm_new_pixmap_from_page(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            } else {
                result = libmupdf._wasm_new_pixmap_from_page_contents(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            }
            return new Pixmap(result);
        }
        search(needle: string, maxHits = 500) {
            return runSearch(
                libmupdf._wasm_search_page.bind(libmupdf) as (
                    a: number, b: number, c: number, d: number, e: number,
                ) => number,
                this.pointer,
                needle,
                maxHits,
            );
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class StructuredText implements StructuredTextLike {
        constructor(public pointer: number) {}
        asJSON(scale = 1) {
            const jsonPtr = libmupdf._wasm_print_stext_page_as_json(this.pointer, scale);
            return fromStringFree(jsonPtr);
        }
        asText() {
            const textPtr = libmupdf._wasm_print_stext_page_as_text(this.pointer);
            return fromStringFree(textPtr);
        }
        walk(walker: StructuredTextWalker) {
            let block = libmupdf._wasm_stext_page_get_first_block(this.pointer);
            while (block) {
                const blockType = libmupdf._wasm_stext_block_get_type(block);
                const blockBBox = fromRect(libmupdf._wasm_stext_block_get_bbox(block));
                if (blockType === 1) {
                    if (walker.onImageBlock) {
                        walker.onImageBlock(blockBBox, null, null);
                    }
                } else {
                    if (walker.beginTextBlock) {
                        walker.beginTextBlock(blockBBox);
                    }
                    let line = libmupdf._wasm_stext_block_get_first_line(block);
                    while (line) {
                        const lineBBox = fromRect(libmupdf._wasm_stext_line_get_bbox(line));
                        const lineWmode = libmupdf._wasm_stext_line_get_wmode(line);
                        const dirPtr = libmupdf._wasm_stext_line_get_dir(line) >> 2;
                        const lineDir: [number, number] = [
                            libmupdf.HEAPF32[dirPtr + 0],
                            libmupdf.HEAPF32[dirPtr + 1],
                        ];
                        if (walker.beginLine) {
                            walker.beginLine(lineBBox, lineWmode, lineDir);
                        }
                        if (walker.onChar || walker.onLineFont) {
                            let ch = libmupdf._wasm_stext_line_get_first_char(line);
                            // Font/size are line-level in every consumer
                            // today, so we read them only off the first
                            // char and skip the per-char WASM trampolines
                            // for the rest of the line.
                            if (ch && walker.onLineFont) {
                                const fontPtr = libmupdf._wasm_stext_char_get_font(ch);
                                const size = libmupdf._wasm_stext_char_get_size(ch);
                                walker.onLineFont(fontPtr, size);
                            }
                            if (walker.onChar) {
                                while (ch) {
                                    const runeCode = libmupdf._wasm_stext_char_get_c(ch);
                                    // fromCodePoint (not fromCharCode) so
                                    // non-BMP characters (emoji, U+1D400
                                    // math bold, extended CJK) survive
                                    // intact. Without this the rune is
                                    // truncated to a single UTF-16 unit
                                    // and the `text.length === chars.length`
                                    // invariant in ParagraphSentenceMapper
                                    // fails, forcing a degradation fallback.
                                    const rune = String.fromCodePoint(runeCode);
                                    const quad = fromQuad(libmupdf._wasm_stext_char_get_quad(ch));
                                    walker.onChar(rune, quad);
                                    ch = libmupdf._wasm_stext_char_get_next(ch);
                                }
                            }
                        }
                        if (walker.endLine) {
                            walker.endLine();
                        }
                        line = libmupdf._wasm_stext_line_get_next(line);
                    }
                    if (walker.endTextBlock) {
                        walker.endTextBlock();
                    }
                }
                block = libmupdf._wasm_stext_block_get_next(block);
            }
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_stext_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class Document implements DocumentLike {
        constructor(public pointer: number) {}

        static openDocument(data: Uint8Array | ArrayBuffer, magic = "application/pdf"): Document {
            const bufferPtr = createBuffer(data);
            const magicPtr = STRING(magic);
            const docPtr = libmupdf._wasm_open_document_with_buffer(magicPtr, bufferPtr);
            libmupdf._wasm_drop_buffer(bufferPtr);
            if (!docPtr) {
                throw new Error("Failed to open document");
            }
            return new Document(docPtr);
        }

        needsPassword() {
            if (typeof libmupdf._wasm_needs_password === "function") {
                return libmupdf._wasm_needs_password(this.pointer) !== 0;
            }
            const enc = this.getMetadata("encryption");
            return enc !== undefined && enc !== "" && enc !== "None";
        }

        countPages() {
            return libmupdf._wasm_count_pages(this.pointer);
        }

        getMetadata(key: string) {
            const valuePtr = libmupdf._wasm_lookup_metadata(this.pointer, STRING(key));
            if (!valuePtr) return undefined;
            return fromString(valuePtr);
        }

        loadPage(index: number) {
            const pagePtr = libmupdf._wasm_load_page(this.pointer, index);
            if (!pagePtr) {
                throw new Error(`Failed to load page ${index}`);
            }
            return new Page(pagePtr);
        }

        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_document(this.pointer);
                this.pointer = 0;
            }
        }
    }

    const Font: FontApi = {
        getName(fontPtr: number): string {
            if (!fontPtr) return "";
            const namePtr = libmupdf._wasm_font_get_name(fontPtr);
            if (!namePtr) return "";
            return fromString(namePtr);
        },
        isBold(fontPtr: number): boolean {
            if (!fontPtr) return false;
            return libmupdf._wasm_font_is_bold(fontPtr) !== 0;
        },
        isItalic(fontPtr: number): boolean {
            if (!fontPtr) return false;
            return libmupdf._wasm_font_is_italic(fontPtr) !== 0;
        },
    };

    return {
        Document: { openDocument: Document.openDocument.bind(Document) },
        Matrix,
        ColorSpace,
        Font,
    };
}
