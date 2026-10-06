/**
 * Shared types of the export pipeline.
 *
 * The pipeline turns Beaver output (markdown with `<citation/>` tags, taken
 * from run history) into documents in other formats:
 *
 *   ExportSource ──parse──▶ ExportDoc ──host resolves + formats citations──▶
 *   FormattedCitations ──writer──▶ file bytes
 *
 * Everything in this package is client-agnostic. Resolving a citation against
 * a library and running a citation processor are host concerns; the host hands
 * the writers plain data (`FormattedCitations`).
 */

import type { Citation } from '@beaver/agent-core/types/citations';
import type { CitationRef } from '@beaver/agent-core/citations/citationGrammar';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { MdBlock } from './mdast';

// ---------------------------------------------------------------------------
// Source (renderer → host, plain JSON)
// ---------------------------------------------------------------------------

/** What the export covers. */
export type ExportSourceKind = 'note' | 'response' | 'thread';

/** One block of exported content, in document order. */
export type ExportSourceBlock =
    /** Assistant text. */
    | { type: 'markdown'; markdown: string }
    /** A note the agent wrote (`create_note` body or a `<note>` tag), exported as its own section. */
    | { type: 'note'; title: string; markdown: string }
    /** A user prompt as typed: plain text, not markdown (thread export). */
    | { type: 'user'; text: string }
    /** What the agent did between its messages: one display label per tool call (full-response export). */
    | { type: 'activity'; calls: string[] };

/**
 * How much of a response to export: the final answer (the text after the
 * agent's last tool call, with any notes it wrote there), or everything it
 * wrote, with its tool calls as activity lines.
 */
export type ExportContent = 'final' | 'full';

/**
 * Citation metadata the source's citation tags need, captured from the
 * client's render state so the export resolves the same pages and identities
 * the chat shows.
 */
export interface CitationSnapshot {
    /** Citation metadata keyed by every lookup key a tag may use (requested, base and invalid-fallback keys). */
    citationsByKey: Record<string, Citation>;
    /** External references by external id. */
    externalReferences: Record<string, ExternalReference>;
    /** External reference id → the library item it was imported as (null when checked and absent). */
    externalItemMapping: Record<string, ZoteroItemReference | null>;
    /** Page labels by the cited item's attachment id (0-based page index → label). */
    pageLabelsByAttachmentId: Record<number, Record<number, string>>;
}

export interface ExportSource {
    kind: ExportSourceKind;
    /** Document title (thread name, note title, …). */
    title: string;
    blocks: ExportSourceBlock[];
    citations: CitationSnapshot;
    provenance: { threadId?: string | null; runIds: string[] };
}

// ---------------------------------------------------------------------------
// Parsed document
// ---------------------------------------------------------------------------

/** One `<citation/>` tag as written. */
export interface CitationOccurrence {
    /** Parsed identity, or null when the tag names nothing usable. */
    ref: CitationRef | null;
    /** Metadata lookup key (includes the locator). */
    requestedKey: string;
    /** Fallback lookup key of a tag whose identity did not parse. */
    invalidKey?: string;
    /** The tag as written. */
    rawTag: string;
}

/**
 * Consecutive citation tags (only whitespace between them) form one cluster,
 * the way the chat and word processors treat adjacent citations.
 */
export interface CitationCluster {
    /** Position in document order; `citation` nodes point here. */
    index: number;
    items: CitationOccurrence[];
}

/** A section of the exported document. */
export interface ExportSection {
    kind: 'markdown' | 'note' | 'user' | 'activity';
    /** Section heading (notes). */
    title?: string;
    children: MdBlock[];
    /** Tool-call labels (activity sections). */
    calls?: string[];
    /**
     * Sections parsed as one markdown document (a response's text around its
     * tool activity) share a scope; footnote references resolve within it.
     */
    scope: number;
}

/** Format-neutral document model. */
export interface ExportDoc {
    title: string;
    sections: ExportSection[];
    clusters: CitationCluster[];
}

// ---------------------------------------------------------------------------
// Citation resolution (package → host)
// ---------------------------------------------------------------------------

/** Pages a citation points at, before the host adds attachment page labels. */
export interface LocatorSpec {
    /** 1-based physical pages, sorted and unique. */
    pages: number[];
    /** Page labels from the citation metadata (0-based index → label). */
    labels: Record<number, string> | null;
    /** True when a structural span supplied only its endpoint pages. */
    inclusiveRange: boolean;
    /** Only labelled pages are shown (EPUB section ordinals are not pages). */
    labelsOnly: boolean;
    /**
     * A page locator as written in the tag (`12-15, 18`), used when there is no
     * metadata. Kept as written so its ranges and gaps survive; its numbers are
     * physical pages translated to labels when formatted.
     */
    written?: string;
}

/** What a citation occurrence points at, from the snapshot alone. */
export type CitationTarget =
    | {
        kind: 'zotero';
        libraryId: number;
        libraryRef?: string;
        zoteroKey: string;
        locator: LocatorSpec | null;
        /** Display name from metadata, used when the item cannot be found. */
        displayName?: string;
    }
    | {
        kind: 'external';
        externalId: string;
        reference: ExternalReference | null;
        locator: LocatorSpec | null;
        displayName?: string;
    }
    | {
        kind: 'external_file';
        extKey: string;
        displayName: string;
        locator: LocatorSpec | null;
    }
    | { kind: 'unresolved'; displayName?: string };

// ---------------------------------------------------------------------------
// Formatted citations (host → writers)
// ---------------------------------------------------------------------------

/** One cited item as it enters the citation processor and the Word field. */
export interface FieldCitationItem {
    /** Processor id (library item id, or a string id for embedded items). */
    id: number | string;
    /** Zotero item URIs, or one stable URI per work for items without a library item. Never empty. */
    uris: string[];
    /** CSL-JSON of the item. */
    itemData: Record<string, unknown>;
    locator?: string;
    label?: string;
}

/** A cluster as formatted by the citation processor. */
export interface FormattedCluster {
    /** Citation processor output (HTML inline subset). Empty when nothing in the cluster could be formatted. */
    html: string;
    /** Visible text of `html`. */
    plain: string;
    /** RTF of the same citation, so a Zotero refresh finds nothing to change. */
    rtf?: string;
    /** Footnote number for note styles; 0 for in-text styles. */
    noteIndex: number;
    /** Items formatted by the processor. */
    items: FieldCitationItem[];
    /** Items the processor could not format (external files, missing items), as plain text. */
    fallbackTexts: string[];
}

/** Paragraph layout of the bibliography, in twentieths of a point (Zotero's own mapping of CSL parameters). */
export interface BibliographyLayout {
    indent: number;
    firstLineIndent: number;
    lineSpacing: number;
    entrySpacing: number;
    tabStops: number[];
}

export interface FormattedBibliography {
    /** One HTML entry per cited work (`<div class="csl-entry">…</div>`). */
    entries: string[];
    layout: BibliographyLayout;
}

export interface FormattedCitations {
    styleId: string;
    locale: string;
    styleClass: 'in-text' | 'note';
    /**
     * The style's citation format (CSL `citation-format`: `author-date`,
     * `numeric`, `note`, `label`, `author`), when known. Lets formats that cite
     * with their own machinery (LaTeX) pick a matching style.
     */
    citationFormat?: string;
    /** Aligned with `ExportDoc.clusters`. */
    clusters: FormattedCluster[];
    bibliography: FormattedBibliography | null;
    /**
     * Zotero document preferences (XML DocumentData) for live citations, or null
     * when the export has no live fields.
     */
    documentData: string | null;
}

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface DocxExportOptions {
    /** Write citations as Zotero fields the word processor plugin can refresh. */
    liveCitations: boolean;
    /** Link item references to `zotero://select/...`. */
    linkItems: boolean;
    /** Heading for the bibliography. */
    bibliographyTitle: string;
}

export interface HtmlExportOptions {
    /** Link item references to `zotero://select/...` (only useful where Zotero is installed). */
    linkItems: boolean;
    /** Heading for the bibliography. */
    bibliographyTitle: string;
    /** Heading for the endnotes (note-style citations and markdown footnotes). */
    notesTitle: string;
}

export interface MarkdownExportOptions {
    /** Link item references to `zotero://select/...` (only useful where Zotero is installed). */
    linkItems: boolean;
    /** Heading for the bibliography. */
    bibliographyTitle: string;
    /**
     * YAML front matter fields after the title (e.g. `date`, `source`), or null
     * for none. With front matter, the title is a front matter field instead of
     * a heading.
     */
    frontMatter: Record<string, string> | null;
}

/** Citation commands of a LaTeX export: biblatex (with Biber) or natbib (with BibTeX). */
export type LatexCitationPackage = 'biblatex' | 'natbib';

export interface LatexExportOptions {
    citationPackage: LatexCitationPackage;
    /** A complete document with preamble and bibliography, or only the body to paste into a project. */
    standalone: boolean;
    /** File name of the bibliography written next to the .tex file, or null when nothing is cited. */
    bibFileName: string | null;
    /** Link item references to `zotero://select/...`. */
    linkItems: boolean;
    /** Heading for the bibliography. */
    bibliographyTitle: string;
    /** Date under the title of a standalone document; omitted when empty. */
    date: string;
}

/** A non-fatal problem worth telling the user about. */
export interface ExportWarning {
    code: 'unresolved_citations' | 'math_as_text' | 'style_unavailable' | 'citations_as_text';
    message: string;
    count?: number;
}
