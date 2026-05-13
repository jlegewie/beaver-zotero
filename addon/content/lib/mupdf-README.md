# MuPDF (custom build)

The `mupdf-wasm.wasm` and `mupdf-wasm.mjs` files in this directory are a custom WebAssembly build of [MuPDF](https://mupdf.com), used by Beaver for PDF text and image extraction.

The build is produced from a small fork of upstream MuPDF maintained at <https://github.com/jlegewie/mupdf>. The fork sits on top of an upstream release tag and adds a single 5-line patch — see [`FORK.md`](https://github.com/jlegewie/mupdf/blob/fork/FORK.md) on the fork for the exact upstream tag, the patch, and instructions to reproduce the build.

## Why a fork?

Upstream MuPDF's glyph-name decoder does not recognise the `C<n>` glyph naming convention used by older Acrobat Distiller (3.x) embedded fonts. On affected PDFs (older Elsevier, Wiley, and similar academic articles from circa 2000–2003), text extraction returns `U+FFFD` replacement characters for every glyph.

The patch adds a conservative `C<n>` branch alongside the existing `a<n>` branch in `source/fitz/encodings.c`, before the replacement-character fallback. Both PDF.js (`src/core/fonts.js`) and Poppler (`poppler/GfxFont.cc parseNumericName`) already handle this convention; the patch brings MuPDF in line.

## License

MuPDF is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). The license text is included alongside this README as `mupdf-LICENSE`.

If you cannot meet the requirements of the AGPL, contact [Artifex](https://artifex.com/contact/mupdf-inquiry.php) regarding a commercial license.

## Links

- Upstream project: <https://github.com/ArtifexSoftware/mupdf>
- Upstream documentation: <https://mupdf.readthedocs.io>
- Fork used for this build: <https://github.com/jlegewie/mupdf> (branch `fork`)
