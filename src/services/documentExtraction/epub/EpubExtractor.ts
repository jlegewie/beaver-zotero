import {
    appendSyntheticSectionMarkers,
    buildContentOffsetIndex,
    buildDomCitationIndex,
    buildDomDiagnostics,
    createDomCounters,
    emptyContentOffsetIndex,
    ensureSentencexLoaded,
    itemCharOffset,
    measureSectionSourceText,
    pageOrdinalForPosition,
    parseDomSection,
    stampSyntheticPageNumbers,
    type DomSection,
    type ItemPagePosition,
    type PageMapping,
    type PageMarker,
} from "../dom";
import {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
    type EpubDocument,
    type ExtractEpubResult,
} from "@beaver/agent-core/extract/document/epub/schema";
import {
    epubPageLabelForPosition,
    extractSectionPageMarkers,
    scorePageMarkers,
    type PageMappingSectionMarkers,
} from "./epubPageMapping";
import { effectiveMaxFileSizeMB } from "@beaver/agent-core/transport/attachmentLimits";
import { isRemoteAccessAvailable } from "../attachmentSource";
import { logger } from "@beaver/agent-core/platform/logger";

// Coverage below this fraction means the walk dropped a meaningful share of the
// book's visible text (an unrecognized container/table structure) and warrants a
// warning so low-quality EPUB extractions are surfaced rather than silent.
const LOW_COVERAGE_WARN_THRESHOLD = 0.85;

// Synthetic EPUB pagination cadence used for marker-less books.
const SYNTHETIC_PAGE_CHAR_INTERVAL = 1800;

// Reject sparse physical markers that would create very large pages.
const MAX_PHYSICAL_PAGE_CHARS = 6000;

declare const Components: any;

interface EpubSectionDocument {
    href: string;
    doc: XMLDocument | Document;
}

interface ZoteroEpub {
    getSectionDocuments(): AsyncIterable<EpubSectionDocument>;
    close(): void;
}

interface ZoteroEpubModule {
    EPUB: new (filePath: string) => ZoteroEpub;
}

export interface ExtractEpubDocumentOptions {
    onFileNotSyncedLocally?: () => void;
}

type EpubResponseError = Extract<ExtractEpubResult, { kind: "response_error" }>;
export type EpubPreflightResult =
    | { kind: "ok"; filePath: string }
    | {
          kind: "response_error";
          code: EpubResponseError["code"];
          message: string;
      };

function responseError(
    code: EpubResponseError["code"],
    message: string,
): ExtractEpubResult {
    return { kind: "response_error", code, message };
}

function preflightResponseError(
    code: EpubResponseError["code"],
    message: string,
): EpubPreflightResult {
    return { kind: "response_error", code, message };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function formatMB(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Extract a local Zotero EPUB attachment into Beaver's section-based schema. */
export async function extractEpubDocument(item: Zotero.Item): Promise<EpubDocument> {
    if (!isEpubAttachment(item)) {
        throw new Error("Item is not an EPUB attachment");
    }

    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        throw new Error("EPUB attachment has no local file");
    }

    return extractEpubDocumentFromFile(filePath);
}

export interface ExtractEpubFromFileOptions {
    /** Language code for sentence splitting; defaults to the EPUB's own `<html lang>`. */
    language?: string | null;
    /** Cooperative cancellation signal checked between EPUB section operations. */
    abortSignal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new Error("Operation aborted");
    }
}

/**
 * The EPUB's container or OPF is structurally invalid (unreadable archive, no
 * `META-INF/container.xml`, no `<rootfile>`, no `<manifest>`/`<spine>`).
 * Distinct from an ordinary extraction failure because it can never succeed on
 * a retry — the bytes are simply not a usable EPUB.
 *
 * Raised only when {@link probeEpubStructure} has positively determined the
 * container is broken, never inferred from when a failure happened: Zotero's
 * `EPUB.mjs` resolves the OPF *and* reads the first spine section inside the
 * same first `next()` call, so a transient read error and a malformed OPF are
 * indistinguishable by timing alone.
 */
export class EpubStructureError extends Error {
    override readonly name = "EpubStructureError";

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.cause = cause;
    }
}

/**
 * Whether an EPUB's container and OPF are readable.
 *
 * `unknown` is the fail-open answer — the probe could not reach a verdict, so
 * the caller must assume the failure was transient.
 */
export type EpubStructureVerdict = "valid" | "broken" | "unknown";

function openEpubZipReader(filePath: string): any {
    const ZipReader = (Components as any).Constructor(
        "@mozilla.org/libjar/zip-reader;1",
        "nsIZipReader",
        "open",
    );
    return new ZipReader((Zotero as any).File.pathToFile(filePath));
}

async function readZipEntryToDocument(
    zip: any,
    entry: string,
    type: string,
): Promise<Document> {
    const stream = zip.getInputStream(entry);
    let xml: string;
    try {
        xml = await (Zotero as any).File.getContentsAsync(stream);
    } finally {
        stream.close();
    }
    return new DOMParser().parseFromString(
        xml,
        type as DOMParserSupportedType,
    ) as unknown as Document;
}

/** First direct child with this local name, ignoring namespaces. */
function firstChildByLocalName(parent: Element | null, name: string): Element | null {
    if (!parent) return null;
    for (const child of Array.from(parent.children)) {
        if (child.localName.toLowerCase() === name) return child;
    }
    return null;
}

/**
 * Re-walk the container chain an extraction failure may have tripped over:
 * `META-INF/container.xml` -> `<rootfile full-path>` -> OPF -> `<manifest>` and
 * `<spine>`. These are exactly the checks `EPUB.mjs` performs, and the only
 * failures in the EPUB path that cannot be fixed by trying again.
 *
 * Runs only after an extraction has already failed, so its cost never lands on
 * the happy path. Anything it cannot decide — including its own failure to open
 * the archive, which may simply mean the file moved — is `unknown`, so the
 * caller keeps treating the original error as retryable.
 */
export async function probeEpubStructure(filePath: string): Promise<EpubStructureVerdict> {
    let zip: any;
    try {
        zip = openEpubZipReader(filePath);
    } catch {
        // Could be a corrupt archive or a vanished/locked file; not decidable.
        return "unknown";
    }
    try {
        if (!zip.hasEntry("META-INF/container.xml")) return "broken";
        let containerDoc: Document;
        try {
            containerDoc = await readZipEntryToDocument(zip, "META-INF/container.xml", "text/xml");
        } catch {
            return "unknown";
        }
        const rootfiles = firstChildByLocalName(containerDoc.documentElement, "rootfiles");
        const rootfile = firstChildByLocalName(rootfiles ?? containerDoc.documentElement, "rootfile");
        const opfPath = rootfile?.getAttribute("full-path");
        if (!opfPath) return "broken";
        if (!zip.hasEntry(opfPath)) return "broken";

        let opfDoc: Document;
        try {
            opfDoc = await readZipEntryToDocument(zip, opfPath, "text/xml");
        } catch {
            return "unknown";
        }
        const pkg = opfDoc.documentElement;
        if (!pkg) return "broken";
        const hasManifest = firstChildByLocalName(pkg, "manifest") !== null;
        const hasSpine = firstChildByLocalName(pkg, "spine") !== null;
        return hasManifest && hasSpine ? "valid" : "broken";
    } catch {
        return "unknown";
    } finally {
        try {
            zip.close();
        } catch {
            // Closing a reader that failed to open fully is not interesting.
        }
    }
}

/**
 * Reclassify an extraction failure as {@link EpubStructureError} when the book's
 * container is provably broken. Aborts pass through untouched — they are
 * cancellation, not a defect in the file.
 */
async function classifyExtractionFailure(
    filePath: string,
    error: unknown,
): Promise<unknown> {
    if (error instanceof EpubStructureError) return error;
    if (error instanceof Error && /abort/i.test(error.message)) return error;
    return (await probeEpubStructure(filePath)) === "broken"
        ? new EpubStructureError(error)
        : error;
}

/**
 * Extract an EPUB into Beaver's section-based schema directly from a file path.
 *
 * Path-based core shared by the item-based extractor and dev tooling that runs
 * over corpus files that are not Zotero attachments. Throws raw errors; callers
 * that need request-safe error shapes use {@link extractEpubDocumentSafe}.
 */
export async function extractEpubDocumentFromFile(
    filePath: string,
    options?: ExtractEpubFromFileOptions,
): Promise<EpubDocument> {
    try {
        return await extractEpubDocumentFromOpenFile(filePath, options);
    } catch (error) {
        // Callers need to know whether trying again could ever help. Decided by
        // re-reading the container, not by where in the pipeline the throw came
        // from — see `classifyExtractionFailure`.
        throw await classifyExtractionFailure(filePath, error);
    }
}

async function extractEpubDocumentFromOpenFile(
    filePath: string,
    options?: ExtractEpubFromFileOptions,
): Promise<EpubDocument> {
    throwIfAborted(options?.abortSignal);
    const { EPUB } = (globalThis as any).ChromeUtils.importESModule(
        "chrome://zotero/content/EPUB.mjs",
    ) as ZoteroEpubModule;
    const epub = new EPUB(filePath);
    const counters = createDomCounters();
    const sections: DomSection[] = [];
    const sectionMarkers: PageMappingSectionMarkers[] = [];
    // Build synthetic markers while section body text nodes are available.
    const syntheticMarkers: PageMarker[] = [];
    const itemPositions: ItemPagePosition[] = [];
    let sourceTextChars = 0;

    // Load the sentencex WASM once (best-effort; sentence splitting degrades to
    // a regex fallback if unavailable).
    await ensureSentencexLoaded();
    let documentLanguage: string | null | undefined;

    try {
        // Section indexes are assigned sequentially over the documents that
        // EPUB.mjs yields. EPUB.mjs skips spine items whose manifest media-type
        // is not XHTML (or whose zip entry is missing), while the Zotero
        // reader's spine indexes count every itemref — so for EPUBs with
        // non-XHTML spine items, extraction indexes are compacted and sit
        // below the reader's section indexes from the skipped entry onward.
        // Consumers that map a reader position or section ordinal onto these
        // indexes (reader state, progressive reads, the citation ordinal
        // fallback) inherit that drift; href-based matching is unaffected.
        // All-XHTML spines — the overwhelmingly common case — are 1:1.
        let sectionIndex = 0;
        for await (const { href, doc } of epub.getSectionDocuments()) {
            throwIfAborted(options?.abortSignal);
            const body = findSectionBody(doc);
            const rawOffsets = body ? buildContentOffsetIndex(body) : emptyContentOffsetIndex();
            appendSyntheticSectionMarkers(
                rawOffsets.contentNodes,
                sectionIndex,
                SYNTHETIC_PAGE_CHAR_INTERVAL,
                syntheticMarkers,
            );
            if (documentLanguage === undefined) {
                // Prefer an explicit language; otherwise use the EPUB's own
                // declared language from the first section's <html lang>.
                // A future content-based language detector slots in here:
                // compute once per document and it flows down as a parameter
                // (same shape as the PDF path's `structured.language`).
                documentLanguage = options?.language
                    ?? doc.documentElement?.getAttribute("lang")
                    ?? null;
            }
            sourceTextChars += measureSectionSourceText(doc);
            if (body) {
                sectionMarkers.push(extractSectionPageMarkers(
                    body,
                    sectionIndex,
                    (element) => rawOffsets.elementOffsets.get(element) ?? 0,
                ));
            } else {
                sectionMarkers.push({ sectionIndex, markersByMatcher: [] });
            }
            sections.push(parseDomSection({
                doc,
                sectionIndex,
                rawHref: href,
                counters,
                language: documentLanguage ?? undefined,
                onItem: (item, candidate) => {
                    itemPositions.push({
                        item,
                        sectionIndex,
                        charOffset: itemCharOffset(candidate, rawOffsets),
                    });
                },
            }));
            sectionIndex += 1;
            await Zotero.Promise.delay(0);
            throwIfAborted(options?.abortSignal);
        }
    } finally {
        epub.close();
    }

    throwIfAborted(options?.abortSignal);
    const pageMapping = scorePageMarkers(sectionMarkers, sections.length);
    stampEpubPageLabels(itemPositions, pageMapping);
    const pageCount = stampEpubPageNumbers(itemPositions, pageMapping, syntheticMarkers);
    const diagnostics = buildDomDiagnostics(sections, sourceTextChars);
    if (diagnostics.textCoverage !== null && diagnostics.textCoverage < LOW_COVERAGE_WARN_THRESHOLD) {
        logger(
            `extractEpubDocument: low text coverage ${diagnostics.textCoverage} `
            + `(${diagnostics.extractedTextChars}/${diagnostics.sourceTextChars} chars) for ${filePath} `
            + `— body text may be in an unsupported structure (e.g. data tables)`,
            2,
        );
    }

    return {
        content_kind: EPUB_CONTENT_KIND,
        schemaVersion: EPUB_SCHEMA_VERSION,
        sectionCount: sections.length,
        pageCount,
        sections,
        citationIndex: buildDomCitationIndex(sections),
        diagnostics,
    };
}

function findSectionBody(doc: XMLDocument | Document): Element | null {
    return doc.body ?? doc.querySelector("body");
}

function stampEpubPageLabels(
    itemPositions: ItemPagePosition[],
    mapping: PageMapping,
): void {
    if (!mapping.isPhysical) return;
    for (const { item, sectionIndex, charOffset } of itemPositions) {
        const label = epubPageLabelForPosition(mapping, sectionIndex, charOffset);
        if (!label) continue;
        item.pageLabel = label;
        for (const sentence of item.sentences ?? []) {
            sentence.pageLabel = label;
        }
    }
}

/**
 * Stamp a 1-based `pageNumber` on every item and return the max page number.
 * Uses physical marker ordinals when reliable; otherwise uses synthetic pages.
 */
function stampEpubPageNumbers(
    itemPositions: ItemPagePosition[],
    mapping: PageMapping,
    syntheticMarkers: PageMarker[],
): number {
    if (itemPositions.length === 0) return 0;
    if (mapping.isPhysical) {
        const physicalCount = stampPhysicalPageNumbers(itemPositions, mapping);
        if (physicalCount !== null) return physicalCount;
    }
    return stampSyntheticPageNumbers(itemPositions, syntheticMarkers);
}

/**
 * Assign marker-ordinal pages, or return `null` when the marker map is too
 * sparse to use as the document page coordinate.
 */
function stampPhysicalPageNumbers(
    itemPositions: ItemPagePosition[],
    mapping: PageMapping,
): number | null {
    const provisional = itemPositions.map(({ sectionIndex, charOffset }) =>
        pageOrdinalForPosition(mapping, sectionIndex, charOffset));

    // Sparse marker maps can otherwise create chapter-sized pages.
    const charsByPage = new Map<number, number>();
    for (let i = 0; i < itemPositions.length; i++) {
        const chars = itemPositions[i].item.text?.length ?? 0;
        charsByPage.set(provisional[i], (charsByPage.get(provisional[i]) ?? 0) + chars);
    }
    for (const total of charsByPage.values()) {
        if (total > MAX_PHYSICAL_PAGE_CHARS) return null;
    }

    let maxPage = 1;
    for (let i = 0; i < itemPositions.length; i++) {
        itemPositions[i].item.pageNumber = provisional[i];
        if (provisional[i] > maxPage) maxPage = provisional[i];
    }
    return maxPage;
}

/** Extract an EPUB attachment with request-safe preflight and error responses. */
export async function extractEpubDocumentSafe(
    item: Zotero.Item,
    options?: ExtractEpubDocumentOptions,
): Promise<ExtractEpubResult> {
    const preflight = await preflightEpubFile(item, options);
    if (preflight.kind === "response_error") {
        return responseError(preflight.code, preflight.message);
    }

    try {
        return { kind: "ok", document: await extractEpubDocumentFromFile(preflight.filePath) };
    } catch (error) {
        return responseError("extraction_failed", `Failed to extract EPUB content: ${getErrorMessage(error)}`);
    }
}

/** Resolve and validate a local EPUB attachment path before extraction. */
export async function preflightEpubFile(
    item: Zotero.Item,
    options?: ExtractEpubDocumentOptions,
): Promise<EpubPreflightResult> {
    let isEpub = false;
    try {
        isEpub = isEpubAttachment(item);
    } catch (error) {
        return preflightResponseError(
            "unsupported_type",
            `Unable to determine whether the attachment is an EPUB: ${getErrorMessage(error)}`,
        );
    }

    if (!isEpub) {
        return preflightResponseError("unsupported_type", "Attachment is not an EPUB file.");
    }

    let filePath: string | null = null;
    try {
        filePath = await item.getFilePathAsync() || null;
    } catch (error) {
        return preflightResponseError(
            "extraction_failed",
            `Failed to resolve the EPUB attachment file path: ${getErrorMessage(error)}`,
        );
    }

    if (!filePath) {
        let remoteAvailable = false;
        try {
            remoteAvailable = isRemoteAccessAvailable(item);
        } catch {
            remoteAvailable = false;
        }

        if (remoteAvailable) {
            try {
                options?.onFileNotSyncedLocally?.();
            } catch {
                // Notification callbacks must never change extraction results.
            }
            return preflightResponseError(
                "file_missing",
                "The EPUB file is available remotely but is not synced locally. Sync it in Zotero so Beaver can read it.",
            );
        }

        return preflightResponseError("file_missing", "The EPUB file is not available locally.");
    }

    const maxFileSizeMB = effectiveMaxFileSizeMB();
    try {
        const stat = await IOUtils.stat(filePath);
        const sizeMB = typeof stat.size === "number" ? stat.size / 1024 / 1024 : null;
        if (sizeMB != null && sizeMB > maxFileSizeMB) {
            return preflightResponseError(
                "file_too_large",
                `The EPUB file is ${formatMB(sizeMB)} MB, which exceeds the ${formatMB(maxFileSizeMB)} MB limit.`,
            );
        }
    } catch (error) {
        if ((error as { name?: string } | null)?.name === "NotFoundError") {
            return preflightResponseError("file_missing", "The EPUB file is no longer available locally.");
        }
        return preflightResponseError(
            "extraction_failed",
            `Failed to inspect the EPUB file: ${getErrorMessage(error)}`,
        );
    }

    return { kind: "ok", filePath };
}

function isEpubAttachment(item: Zotero.Item): boolean {
    const maybeItem = item as Zotero.Item & {
        isEPUBAttachment?: () => boolean;
        attachmentContentType?: string;
    };
    if (typeof maybeItem.isEPUBAttachment === "function") {
        return maybeItem.isEPUBAttachment();
    }
    return maybeItem.attachmentContentType === "application/epub+zip";
}
