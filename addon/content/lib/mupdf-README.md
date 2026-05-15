# MuPDF WASM

The `mupdf-wasm.wasm` and `mupdf-wasm.mjs` files in this directory are a custom WebAssembly build of [MuPDF](https://mupdf.com), used by Beaver for PDF text and image extraction.

This build is produced from a public fork of upstream MuPDF:

<https://github.com/jlegewie/mupdf/tree/fork>

The fork is based on an upstream MuPDF release tag and carries Beaver-specific fixes for PDF extraction and WASM stability. See the fork's `FORK.md` for the exact upstream base, local patches, and build notes:

<https://github.com/jlegewie/mupdf/blob/fork/FORK.md>

The bundled `.wasm` and `.mjs` files are generated build artifacts; the corresponding source changes and build notes are documented in the fork.

## License

MuPDF is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html). The license text is included alongside this README as `mupdf-LICENSE`.

If you cannot meet the requirements of the AGPL, contact [Artifex](https://artifex.com/contact/mupdf-inquiry.php) regarding a commercial license.

## Links

- Upstream project: <https://github.com/ArtifexSoftware/mupdf>
- Upstream documentation: <https://mupdf.readthedocs.io>
- Fork used for this build: <https://github.com/jlegewie/mupdf/tree/fork>
