import type { ZoteroItemReference } from '../types/zotero';
import type { CitationRef } from '../utils/citationGrammar';
import type { Citation } from '../types/citations';

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
     */
    resolvePageLabels(ref: CitationRef): Record<number, string> | null;
}

/**
 * Aggregate client host. Registered once per client at bundle init via
 * {@link setHost}. Slices are optional — check before use.
 */
export interface ClientHost {
    navigation?: NavigationHost;
    itemData?: ItemDataHost;
}
