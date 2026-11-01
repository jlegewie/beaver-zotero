/**
 * Chat citations assembled from a table row and one piece of its evidence.
 *
 * An evidence entry says which document a passage is in and where, and the row
 * says which work it is and how it is cited. Joining the two gives a citation the chat's `Citation`
 * component renders and navigates, with nothing loaded from Zotero — the table
 * view and the static document's reference list build their citations here. Surfaces hand the assembled citation to the
 * component directly: a tag names only a work and a locator, so it cannot
 * tell two quotes of one work apart.
 */

import type { Citation, ContentKind } from "../types/citations";
import {
    locatorValues,
    parseLoc,
    type Locator,
    type ZoteroCitationRef,
} from "../citations/citationGrammar";
import { parseExtractIdValue } from "../extract/ids";
import { UNRESOLVED_LIBRARY_ID } from "../identity/libraryRef";
import { documentReference } from "./rowActions";
import {
    REFERENCE_COLUMN_ID,
    type CellValue,
    type Evidence,
    type Row,
    type ZoteroRowReference,
} from "./table";

type ReferenceValue = Extract<CellValue, { kind: "reference" }>;

/** The row's reference cell value: the `_reference` column, else any reference cell. */
export function rowReference(row: Row): ReferenceValue | undefined {
    const named = row.cells[REFERENCE_COLUMN_ID]?.value;
    if (named?.kind === "reference") return named;
    for (const cell of Object.values(row.cells)) {
        if (cell.value?.kind === "reference") return cell.value;
    }
    return undefined;
}

/**
 * The 1-based page a locator names: a page locator, or the page of a
 * page-scoped extraction id (`s5.6` is on page 5). Undefined otherwise.
 */
function pageOfLocator(raw: string | undefined): number | undefined {
    const loc = parseLoc(raw);
    if (!loc) return undefined;
    const first = loc.kind === "page" ? loc.value : locatorValues(loc)[0];
    const page =
        loc.kind === "page"
            ? parseInt(first, 10)
            : parseExtractIdValue(first.split("-")[0])?.page;
    return page && page > 0 ? page : undefined;
}

function zoteroRef(ref: ZoteroRowReference, loc?: Locator): ZoteroCitationRef {
    return {
        kind: "zotero",
        library_id: ref.library_id ?? UNRESOLVED_LIBRARY_ID,
        library_ref: ref.library_ref,
        zotero_key: ref.zotero_key,
        ...(loc ? { loc } : {}),
    };
}

/** The cited attachment, and the item above it when the row has one. */
interface Target {
    resolved: ZoteroCitationRef;
    parent?: ZoteroCitationRef;
}

/**
 * The local rowid the row already knows for a document's library: the row's
 * item names the same library (`library_ref`) on this device.
 */
function knownLibraryId(
    ref: ZoteroRowReference | undefined,
    file: { library_ref?: string; zotero_key: string },
): number | undefined {
    return ref && file.library_ref && ref.library_ref === file.library_ref
        ? ref.library_id
        : undefined;
}

/**
 * What the evidence points into: the document it names (`evidence.document`),
 * not whichever document the row names now, so a citation still opens the
 * file its passage came from after the row moved on.
 */
function targetOf(row: Row, evidence: Evidence): Target | undefined {
    if (!row.ref) return undefined;
    // The work above the document: the row's item. An external work has none.
    const item = row.ref.kind === "item" ? row.ref : undefined;
    const file = documentReference(evidence.document ?? row.documents?.[0]);
    if (!file) return undefined;
    // Page-only evidence still names its page, so its tag stays its own.
    const loc = parseLoc(
        evidence.locator ??
            (evidence.page != null ? `page${evidence.page + 1}` : undefined),
    );
    return {
        resolved: {
            kind: "zotero",
            library_id: knownLibraryId(item, file) ?? file.library_id,
            ...(file.library_ref ? { library_ref: file.library_ref } : {}),
            zotero_key: file.zotero_key,
            ...(loc ? { loc } : {}),
        },
        ...(item ? { parent: zoteroRef(item) } : {}),
    };
}

/**
 * The citation tag that names `ref`, as the model would write it. A renderer
 * that resolves tags against a citation store finds the assembled citation
 * under it, so table evidence can render through the chat's own markers.
 */
export function citationTagFor(ref: ZoteroCitationRef): string {
    const loc = ref.loc ? ` loc="${ref.loc.raw}"` : "";
    return `<citation id="${sourceKeyOf(ref)}"${loc}/>`;
}

/** The cited source, so ids from different tables that share a row id stay apart. */
function sourceKeyOf(ref: ZoteroCitationRef): string {
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

/** FNV-1a 32 over UTF-16 code units, as hex: tells evidence at one place apart. */
function quoteHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * A deterministic id from what the evidence cites, so the same evidence always
 * yields the same citation and different evidence never shares one.
 */
function citationIdFor(row: Row, target: Target, evidence: Evidence): string {
    const where =
        evidence.locator ??
        (evidence.page != null ? `page${evidence.page + 1}` : "doc");
    const what = JSON.stringify([
        evidence.quote,
        evidence.page,
        evidence.boxes,
    ]);
    return `table:${row.id}:${sourceKeyOf(target.resolved)}:${where}:${quoteHash(what)}`;
}

/** What the caller knows about the evidence's document beyond the row. */
export interface EvidenceCitationOptions {
    /**
     * The kind of document the passage is in (`pdf`, `epub`, `snapshot`, …),
     * when the caller has looked it up. A table stores no kind, and a citation
     * without one is read as a PDF, so an EPUB or snapshot passage opens
     * through its own reader only when this is given.
     */
    contentKind?: ContentKind;
}

/**
 * The chat citation for one evidence entry of a row, or null when the row has
 * no reference to cite.
 */
export function citationForEvidence(
    row: Row,
    evidence: Evidence,
    options: EvidenceCitationOptions = {},
): Citation | null {
    const target = targetOf(row, evidence);
    if (!target) return null;
    const reference = rowReference(row);
    const citation: Citation = {
        citation_id: citationIdFor(row, target, evidence),
        requested_ref: target.resolved,
        resolved_ref: target.resolved,
        citation_type: "attachment",
        preview: evidence.quote,
        raw_tag: citationTagFor(target.resolved),
    };
    if (target.parent) citation.parent_ref = target.parent;
    if (reference?.display_name) citation.display_name = reference.display_name;
    if (reference?.formatted_citation)
        citation.formatted_citation = reference.formatted_citation;
    if (reference?.item_type) citation.item_type = reference.item_type;
    const contentKind = options.contentKind;
    if (contentKind) citation.content_kind = contentKind;
    // The locator's page (`page12`, `s5.6`) when the evidence names no other.
    // A snapshot has no pages: its passage is found by its text.
    const locatedPage =
        evidence.page == null && contentKind !== "snapshot"
            ? pageOfLocator(evidence.locator)
            : undefined;
    // 0-based, like `Evidence.page`.
    const pageIndex =
        evidence.page ?? (locatedPage ? locatedPage - 1 : undefined);
    if (pageIndex != null) citation.pages = [pageIndex + 1];
    const partId =
        evidence.locator ??
        (pageIndex != null && evidence.boxes?.length
            ? `page${pageIndex + 1}`
            : undefined);
    if (partId) {
        citation.locations = [
            {
                part_id: partId,
                ...(pageIndex != null ? { page_idx: pageIndex } : {}),
                ...(evidence.boxes?.length ? { boxes: evidence.boxes } : {}),
            },
        ];
    }
    return citation;
}

/** Every citation a cell's evidence yields, in order. */
export function cellCitations(
    row: Row,
    columnId: string,
    options: EvidenceCitationOptions = {},
): Citation[] {
    const evidence = row.cells[columnId]?.evidence ?? [];
    const citations: Citation[] = [];
    evidence.forEach((entry) => {
        const citation = citationForEvidence(row, entry, options);
        if (citation) citations.push(citation);
    });
    return citations;
}
