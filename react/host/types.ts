import type { ReactNode } from 'react';
import type { ZoteroItemReference } from '../types/zotero';
import type { CitationRef } from '../utils/citationGrammar';
import type { Citation, PartLocation } from '../types/citations';
import type { PageLabelsByAttachmentId } from '../atoms/citations';
import type { ExternalReference } from '../types/externalReferences';
import type { ToolCallPart, AgentRun, AgentRunStatus } from '../agents/types';
import type { PendingApproval } from '../agents/agentActions';
import type { EditNoteResolvedTarget } from '../components/agentRuns/editNoteShared';

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
 * One find_in_attachments match to navigate to in the reader. Assembled by the
 * render layer from an attachment-search row and match.
 */
export interface AttachmentMatchNavigation {
    library_id: number;
    zotero_key: string;
    content_kind: 'pdf' | 'epub' | 'text' | 'snapshot';
    /** 1-based page number (EPUB: 1-based section ordinal). */
    page_number?: number | null;
    /** Printed page label for the matched page, when known. */
    page_label?: string | null;
    /** Compact part location used for reader navigation. */
    target?: PartLocation | null;
    /** Match preview text, used for temporary-annotation comments and EPUB search. */
    snippet?: string;
    /** Owning document of the clicked row, so the host targets the right window. */
    ownerDocument?: Document;
}

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
    /** Open the reader at a find_in_attachments match and highlight it. */
    navigateToAttachmentMatch(match: AttachmentMatchNavigation): void | Promise<void>;
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
    /**
     * Bibliographic display name for the referenced item, used by tool-call
     * header labels (e.g. "Smith 2005"; a note's title for note references).
     * For attachments this is the parent item's display name. Absent when it
     * can't be resolved.
     */
    displayName?: string;
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
     * Resolve display metadata (icon type + attachment availability + display
     * name) for a library item in a source/result list. Async because it may
     * load the item; returns null when the item can't be resolved.
     */
    resolveItemDisplay(ref: ZoteroItemReference): Promise<ResolvedItemDisplay | null>;
    /**
     * Resolve a library's display name for a tool-call header label. Accepts the
     * raw `library` arg (numeric id or name). Returns null when unavailable.
     */
    resolveLibraryName(libraryParam: number | string): Promise<string | null>;
    /**
     * Resolve a collection's display name for a tool-call header label. Accepts
     * the raw collection key/id/name arg and an optional scoping library id.
     * Returns null when unavailable.
     */
    resolveCollectionName(keyOrName: string | number, libraryId?: number): Promise<string | null>;
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
 * Display mode for a single host-rendered action button.
 *
 * - `full`     — icon + label.
 * - `icon-only`— compact icon button.
 * - `none`     — button is omitted.
 */
export type ExternalReferenceActionMode = 'full' | 'icon-only' | 'none';

/**
 * Visual variant the render layer can request for host-rendered buttons.
 */
export type HostButtonVariant =
    | 'solid'
    | 'surface'
    | 'outline'
    | 'subtle'
    | 'ghost'
    | 'surface-light'
    | 'ghost-secondary'
    | 'ghost-tertiary'
    | 'error';

/**
 * Render inputs for the external-reference action buttons (details / web / PDF /
 * reveal / import). The shared render layer assembles these from a client-agnostic
 * {@link ExternalReference}; the host owns the actual buttons and their
 * client-specific behavior (importing into the library, revealing, opening PDFs).
 */
export interface ExternalReferenceActionsProps {
    /** The external reference whose actions are rendered. */
    item: ExternalReference;
    /** Visual variant for the rendered buttons. */
    buttonVariant?: HostButtonVariant;
    /** Extra class names applied to each button. */
    className?: string;
    /** Display mode for the Reveal button (shown when the item exists in the library). */
    revealButtonMode?: ExternalReferenceActionMode;
    /** Display mode for the Import button (shown when the item is not in the library). */
    importButtonMode?: ExternalReferenceActionMode;
    /** Display mode for the Details button. */
    detailsButtonMode?: ExternalReferenceActionMode;
    /** Display mode for the Web button. */
    webButtonMode?: ExternalReferenceActionMode;
    /** Display mode for the PDF button. */
    pdfButtonMode?: ExternalReferenceActionMode;
    /** Whether to show the citation count. */
    showCitationCount?: boolean;
}

/**
 * Host-provided, client-specific UI components.
 *
 * Unlike the other slices (which inject *behavior*), this slice injects *UI* for
 * surfaces that are inherently client-specific — chiefly the agent-action
 * approve/apply/undo controls and item-mutation buttons that only make sense for
 * a Zotero library. Shared dispatchers ask the host for these renderers instead
 * of importing the client components directly, so the dependency arrow stays
 * shared → host-interface, never shared → client UI.
 *
 * Each method returns a {@link ReactNode}, or `null` when the client has no UI
 * for that surface (the shared caller then renders nothing). The slice grows as
 * more action UIs move behind the host seam.
 */
/**
 * Inputs for the in-stream agent-action UI, discriminated by `kind` to cover the
 * three render situations: a single action tool-call (`tool-action`), a bulk
 * annotation tool-call (`annotation`), and a grouped edit_note run
 * (`edit-note-group`). The shared dispatchers classify and pass these; the host
 * owns the rich apply/undo rendering. Mirrors the props the Zotero components
 * (`AgentActionView` / `AnnotationToolCallView` / `EditNoteGroupView`) take today.
 */
export type AgentActionInStreamProps =
    | {
        kind: 'tool-action';
        part: ToolCallPart;
        runId: string;
        responseIndex: number;
        runStatus: AgentRunStatus;
        toolName: string;
        pendingApproval: PendingApproval | null;
        hasToolReturn: boolean;
        streamingArgs?: Record<string, unknown> | null;
    }
    | { kind: 'annotation'; part: ToolCallPart; runId: string; runStatus: AgentRunStatus }
    | {
        kind: 'edit-note-group';
        parts: ToolCallPart[];
        target: EditNoteResolvedTarget | null;
        runId: string;
        responseIndex: number;
        runStatus: AgentRunStatus;
    };

export interface ComponentsHost {
    /**
     * Render the action buttons for an external (non-library) reference —
     * details / web / open-PDF plus reveal-in-library / import-to-library. The
     * import and reveal actions write to / navigate the Zotero library, so the
     * whole control is client-specific. Returns null when the host has no such UI.
     */
    externalReferenceActions(props: ExternalReferenceActionsProps): ReactNode;
    /**
     * Render the rich in-stream agent-action / mutation UI for one tool-call part
     * or edit-note group (approve/apply/undo controls, bulk-annotation panel, the
     * edit_note group). Return null to fall back to the shared generic summary.
     */
    agentActionInStream(props: AgentActionInStreamProps): ReactNode;
    /**
     * Render the post-run pending-approval review block (create-item / note /
     * annotation mutation summaries). Return null when the client has nothing to
     * approve.
     */
    pendingActionsReview(props: { run: AgentRun }): ReactNode;
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
    components?: ComponentsHost;
}
