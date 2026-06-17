import type { ZoteroItemReference } from '../types/zotero';
import type { CitationRef } from '../utils/citationGrammar';
import type { Citation } from '../types/citations';
import type { PageLabelsByAttachmentId } from '../atoms/citations';

/**
 * Everything the host needs to activate (navigate to / open) a cited location.
 *
 * The render layer derives this from the client-agnostic citation view model and
 * hands it to the host; the host performs the client-specific side effects
 * (open reader at a locator, open a note, launch a file, show an external
 * reference, ...). Only ever passed for a "ready" citation, so `metadata` is
 * always present.
 */
export interface CitationActivation {
    /** Self-contained citation metadata (content kind, locations, pages, preview, ...). */
    metadata: Citation;
    isExternal: boolean;
    isExternalFile: boolean;
    externalFileKey: string | null;
    externalSourceId?: string;
    /** Whether an external reference has been mapped to a library item. */
    hasMappedItem: boolean;
    /** Effective library identity, accounting for mapped external references. */
    effectiveLibraryID: number;
    effectiveItemKey: string;
    /** Stripped preview text (used as the temporary-annotation label). */
    previewText: string;
    /** Document the click originated from (targets the right reader window). */
    ownerDocument: Document;
}

/**
 * Client host capability slices.
 *
 * The chat-history render surface (citations, cited-sources, toolcall results,
 * notes, ...) is presentational and client-agnostic. The handful of operations
 * that *are* client-specific — navigating to items, opening files, and a few
 * legacy data lookups — are injected through the slices below so the UI can be
 * reused across clients.
 *
 * Each slice on {@link ClientHost} is optional and namespaced; a client supplies
 * only the capabilities it has, and renderers degrade gracefully when a slice is
 * absent.
 */

/**
 * Navigation actions a rendered chat surface can trigger on the host.
 *
 * These are inherently client-specific: where "reveal in library" or "open the
 * file" means something different per client. This subsumes the verbs the
 * citation click handler needs today; future toolcall-result and source-list
 * components consume the same slice.
 */
export interface NavigationHost {
    /** Reveal/select the referenced item in the library view. */
    revealInLibrary(ref: ZoteroItemReference): void;
    /**
     * Reveal/select the referenced collection in the library view. The ref's
     * `zotero_key` is the collection key (not an item key).
     */
    revealCollection(ref: ZoteroItemReference): void;
    /** Open a local file (e.g. a PDF/text attachment) in the host's default handler. */
    launchFile(filePath: string): void;
    /** Open an external URL. */
    openExternalUrl(url: string): void;
    /**
     * Activate a cited location: open the reader at the locator, open a note,
     * launch an external file, reveal an external reference, etc. Encapsulates
     * all client-specific citation-click behavior so the render layer stays
     * client-agnostic. Only called for "ready" citations.
     */
    activateCitation(activation: CitationActivation): void | Promise<void>;
    /** Open a library item's best attachment (PDF/etc.) or note in the host viewer. */
    openSource(ref: ZoteroItemReference): void | Promise<void>;
    /** Open the referenced annotation in the reader, scrolled to its location. */
    openAnnotation(ref: ZoteroItemReference): void | Promise<void>;
    /** Open a locally stored external-file copy by its ext key (no-op if no local copy). */
    launchExternalFile(extKey: string): void | Promise<void>;
}

/**
 * Display metadata for a library item, resolved by the host for source/result
 * lists. Currently minimal; grows as more list surfaces are decoupled.
 */
export interface ResolvedItemDisplay {
    /** Zotero item type, for icon rendering. */
    itemType?: string;
    /** Whether the item has a readable attachment (enables an "open" action). */
    hasReadableAttachment: boolean;
}

/**
 * Fallback data lookups for legacy (pre-v2) rendering data.
 *
 * Citation v2 metadata is self-contained, so this slice is deliberately minimal
 * and shrinking: it only covers data that older stored rows did not persist.
 */
export interface ItemDataHost {
    /**
     * Resolve printed page labels for a citation when the metadata does not
     * already carry them. Returns a sparse 0-based page index -> printed label
     * map, or null when unavailable (renderer then falls back to raw page
     * numbers).
     *
     * The label map is passed in from the active render store (rather than read
     * from a module-global store) so this works under the isolated store that
     * `renderToHTML` populates during note export.
     */
    resolvePageLabels(
        ref: CitationRef,
        pageLabelsByAttachmentId: PageLabelsByAttachmentId,
    ): Record<number, string> | null;
    /**
     * Resolve display metadata (icon type + attachment availability) for a
     * library item in a source/result list. Async because it may load the item;
     * returns null when the item can't be resolved.
     */
    resolveItemDisplay(ref: ZoteroItemReference): Promise<ResolvedItemDisplay | null>;
}

/**
 * What the host needs to render a citation as host-native formatted output for
 * document export (e.g. a Zotero note). Derived from the citation view model.
 */
export interface CitationExportRequest {
    effectiveLibraryID: number;
    effectiveItemKey: string;
    /** Identity as cited by the model, for page-locator fallback. */
    requestedRef: CitationRef | null;
    /** 1-based cited page numbers. */
    pages: number[];
    /** Self-contained metadata, for the page-label fallback. */
    metadata?: Citation;
    /**
     * Page-label map from the active render store. Passed in (rather than read
     * from a module-global store) so note export uses the isolated store that
     * `renderToHTML` populates with preloaded labels.
     */
    pageLabelsByAttachmentId: PageLabelsByAttachmentId;
}

/**
 * Host-native rendered citation for export. `html` is inserted via
 * `dangerouslySetInnerHTML`; the `citation` variant also carries the serialized
 * citation payload for the editor's `data-citation` attribute.
 */
export type CitationExportRender =
    | { kind: 'html'; html: string }
    | { kind: 'citation'; html: string; citationData: string };

/**
 * What the host needs to render an external-file citation (a user-attached,
 * non-Zotero file) as host-native output for document export.
 */
export interface ExternalFileCitationExportRequest {
    /** Ext key of the cited external file, or null when unknown. */
    externalFileKey: string | null;
    /** Display label (filename / cited name). */
    displayName: string;
    /** Cited page/section locator suffix (e.g. ", p.3"), already formatted; empty when none. */
    locatorSuffix: string;
    /**
     * Absolute local paths for external files present on this computer, keyed by
     * ext key. Passed in from the active render store (rather than read from a
     * module-global store) so note export uses the isolated store that
     * `renderToHTML` populates.
     */
    localPathsByExtKey: Record<string, string>;
}

/**
 * Render content into the host's native document format. For Zotero this is a
 * note (CSL-formatted HTML); other clients format
 * differently. Clients that don't support document export omit this slice.
 */
export interface DocumentExportHost {
    /** Render a Zotero/library citation for export. Returns null when the item is unavailable. */
    renderCitation(request: CitationExportRequest): CitationExportRender | null;
    /**
     * Render an external-file citation as host-native output. Returns null when
     * the host has no richer representation than plain text (e.g. no local copy
     * of the file on this computer), in which case the render layer falls back to
     * its client-agnostic plain-text form. Optional — clients without local
     * external-file storage omit it.
     */
    renderExternalFileCitation?(request: ExternalFileCitationExportRequest): CitationExportRender | null;
}

/**
 * Display configuration the render layer needs. Typed, named accessors (rather
 * than a generic `getPref`) so the render layer never couples to a client's
 * preference system. Read on each render — no reactivity is implied.
 */
export interface ConfigHost {
    /** Citation display format. */
    citationFormat(): 'author-year' | 'numeric';
    /** Whether to render printed page labels instead of raw page numbers. */
    usePageLabels(): boolean;
}

/**
 * Aggregate client host. Registered once per client at bundle init via
 * {@link setHost}. Slices are optional — check before use.
 */
export interface ClientHost {
    navigation?: NavigationHost;
    itemData?: ItemDataHost;
    documentExport?: DocumentExportHost;
    config?: ConfigHost;
}
