/**
 * Entry point of the export runtime: the parts of the pipeline that carry
 * sizeable dependencies (remark, KaTeX, the docx writer) and the writers
 * (Word, HTML for PDF, Markdown, LaTeX). A host may load this lazily,
 * separately from its main bundle.
 */

export { parseExportSource } from './parse/parseExportDoc';
// This bundle carries its own copy of agent-core, so the host registers its
// library identity resolvers here too (legacy `<libraryID>-KEY` citations).
export { setLibraryRefResolver, setObjectIdResolver } from '@beaver/agent-core/identity/libraryRef';
export { writeDocx } from './docx/writeDocx';
export type { WriteDocxInput, WriteDocxResult } from './docx/writeDocx';
export { writeHtml } from './html/writeHtml';
export type { HtmlPageSetup, WriteHtmlInput, WriteHtmlResult } from './html/writeHtml';
export { writeMarkdown } from './markdown/writeMarkdown';
export type { WriteMarkdownInput, WriteMarkdownResult } from './markdown/writeMarkdown';
export { writeLatex } from './latex/writeLatex';
export type { WriteLatexInput, WriteLatexResult } from './latex/writeLatex';
