/**
 * Chat citations assembled from a table row and one piece of its evidence.
 *
 * Evidence is item-less: an entry says where in the row's attachment (or in
 * which metadata field) an answer was found, and the row says which work it is
 * and how it is cited. Joining the two gives a citation the chat's `Citation`
 * component renders and navigates, with nothing loaded from Zotero — the table
 * view, the reader enhancement and the static document's reference list all
 * build their citations here. Surfaces hand the assembled citation to the
 * component directly: a tag names only a work and a locator, so it cannot
 * tell two quotes of one work apart.
 */

import type { Citation, CitationType } from "../types/citations";
import {
    locatorValues,
    parseLoc,
    type CitationRef,
    type Locator,
    type ZoteroCitationRef,
} from "../citations/citationGrammar";
import { parseExtractIdValue } from "../extract/ids";
import { UNRESOLVED_LIBRARY_ID } from "../identity/libraryRef";
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

/** The source label an annotation row's anchor carries, when it has one. */
function annotationSource(row: Row): string | undefined {
    for (const cell of Object.values(row.cells)) {
        if (cell.value?.kind === "annotation" && cell.value.source_display_name)
            return cell.value.source_display_name;
    }
    return undefined;
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

interface Target {
    resolved: CitationRef;
    parent?: ZoteroCitationRef;
    type: CitationType;
}

/** What the evidence points into: the attachment that was read, or the work itself for metadata. */
function targetOf(row: Row, evidence: Evidence): Target | undefined {
    const ref = row.ref;
    if (!ref) return undefined;
    const fromDocument = !evidence.field;
    // Page-only evidence still names its page, so its tag stays its own.
    const loc = fromDocument
        ? parseLoc(
              evidence.locator ??
                  (evidence.page != null
                      ? `page${evidence.page + 1}`
                      : undefined),
          )
        : undefined;
    switch (ref.kind) {
        case "item":
            if (fromDocument && ref.attachment)
                return {
                    resolved: zoteroRef(ref.attachment, loc),
                    parent: zoteroRef(ref),
                    type: "attachment",
                };
            return { resolved: zoteroRef(ref, loc), type: "item" };
        case "attachment":
            // Metadata (title, abstract) is the parent item's record.
            if (!fromDocument && ref.parent_item)
                return { resolved: zoteroRef(ref.parent_item), type: "item" };
            return {
                resolved: zoteroRef(ref, loc),
                ...(ref.parent_item
                    ? { parent: zoteroRef(ref.parent_item) }
                    : {}),
                type: "attachment",
            };
        case "annotation":
            if (!fromDocument && ref.parent_item)
                return { resolved: zoteroRef(ref.parent_item), type: "item" };
            return {
                resolved: zoteroRef(ref.attachment, loc),
                ...(ref.parent_item
                    ? { parent: zoteroRef(ref.parent_item) }
                    : {}),
                type: "attachment",
            };
        case "external":
            return {
                resolved: {
                    kind: "external",
                    external_id: ref.source_id,
                    source: ref.source,
                    ...(loc ? { loc } : {}),
                },
                type: "external_reference",
            };
        case "file":
            return {
                resolved: {
                    kind: "external_file",
                    ext_key: ref.ext_key,
                    ...(loc ? { loc } : {}),
                },
                type: "external_file",
            };
    }
}

/**
 * The citation tag that names `ref`, as the model would write it. A renderer
 * that resolves tags against a citation store finds the assembled citation
 * under it, so table evidence can render through the chat's own markers.
 */
export function citationTagFor(ref: CitationRef): string {
    const loc = ref.loc ? ` loc="${ref.loc.raw}"` : "";
    if (ref.kind === "zotero")
        return `<citation id="${ref.library_ref ?? ref.library_id}-${ref.zotero_key}"${loc}/>`;
    if (ref.kind === "external")
        return `<citation external_id="${ref.external_id}"${loc}/>`;
    return `<citation id="ext-${ref.ext_key}"${loc}/>`;
}

/** The cited source, so ids from different tables that share a row id stay apart. */
function sourceKeyOf(ref: CitationRef): string {
    if (ref.kind === "zotero")
        return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
    if (ref.kind === "external") return `${ref.source}:${ref.external_id}`;
    return `ext-${ref.ext_key}`;
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
        evidence.field ??
        (evidence.page != null ? `page${evidence.page + 1}` : "doc");
    const what = JSON.stringify([
        evidence.quote,
        evidence.page,
        evidence.boxes,
    ]);
    return `table:${row.id}:${sourceKeyOf(target.resolved)}:${where}:${quoteHash(what)}`;
}

/**
 * The chat citation for one evidence entry of a row, or null when the row has
 * no reference to cite.
 */
export function citationForEvidence(
    row: Row,
    evidence: Evidence,
): Citation | null {
    const target = targetOf(row, evidence);
    if (!target) return null;
    const reference = rowReference(row);
    const citation: Citation = {
        citation_id: citationIdFor(row, target, evidence),
        requested_ref: target.resolved,
        resolved_ref: target.resolved,
        citation_type: target.type,
        preview: evidence.quote,
        raw_tag: citationTagFor(target.resolved),
    };
    if (target.parent) citation.parent_ref = target.parent;
    // Without a reference cell, the row's own label: an annotation's source,
    // a file's name (or its key), so the marker always has something to show.
    const displayName =
        reference?.display_name ??
        annotationSource(row) ??
        (row.ref?.kind === "file"
            ? (row.ref.label ?? row.ref.ext_key)
            : undefined);
    if (displayName) citation.display_name = displayName;
    if (reference?.formatted_citation)
        citation.formatted_citation = reference.formatted_citation;
    // A metadata citation of an attachment row names the parent item, so the
    // attachment's own type and content kind would send it into the file.
    const citesRowAttachment = !(
        target.type === "item" && row.ref?.kind !== "item"
    );
    if (reference?.item_type && citesRowAttachment)
        citation.item_type = reference.item_type;
    if (reference?.content_kind && citesRowAttachment)
        citation.content_kind =
            reference.content_kind as Citation["content_kind"];
    // The locator's page (`page12`, `s5.6`) when the evidence names no other.
    const locatedPage =
        !evidence.field && evidence.page == null
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
    if (partId && !evidence.field) {
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
export function cellCitations(row: Row, columnId: string): Citation[] {
    const evidence = row.cells[columnId]?.evidence ?? [];
    const citations: Citation[] = [];
    evidence.forEach((entry) => {
        const citation = citationForEvidence(row, entry);
        if (citation) citations.push(citation);
    });
    return citations;
}
