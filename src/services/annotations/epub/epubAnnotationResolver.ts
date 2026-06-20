import { logger } from "../../../utils/logger";
import {
    citationSearchTextCandidates,
    createContainingBlockRange,
    createElementContentsRange,
    createSentenceRange,
    findAnchorElement,
    normalizeHrefBasename,
} from "../../documentExtraction/epub/epubTextRange";
import EpubCFI from "./vendor/epubcfi";
import {
    buildEpubSortIndex,
    toEpubFragmentSelector,
    type EpubFragmentSelector,
} from "./epubAnnotationGeometry";

declare const Components: any;

// DOM node-type / position bit constants, as spec-fixed literals — a document
// parsed by DOMParser may have no live window providing the `Node` global.
const ELEMENT_NODE = 1;
const SHOW_ELEMENT = 0x1;
const DOCUMENT_POSITION_PRECEDING = 0x2;

/** Locator for a passage to annotate inside an EPUB, from citation metadata. */
export interface EpubAnnotationLocator {
    /** Section file href within the EPUB (matched by basename). */
    sectionHref?: string;
    /** 1-based extractor (compacted) section ordinal; used when no href matches. */
    sectionOrdinal?: number;
    /** DOM id of the cited element inside the section, when known. */
    anchorId?: string;
    /** Cited passage text used to anchor a precise range. */
    text?: string;
    /**
     * Anchor the stored CFI to the cited text's containing block instead of the
     * exact passage range. Used for note/point annotations so the reader renders
     * the comment icon in the margin beside the block (see
     * {@link createContainingBlockRange}); the cited passage still selects which
     * block. Highlights leave this unset and store the precise passage range.
     */
    anchorToBlock?: boolean;
}

/** A resolved EPUB annotation position + sortIndex, ready to persist. */
export interface ResolvedEpubAnnotation {
    position: EpubFragmentSelector;
    sortIndex: string;
    /** Text covered by the range (for highlight `annotationText`). */
    text: string;
    /** Raw spine itemref index the annotation lives in. */
    rawSectionIndex: number;
    /** Resolved section href (zip entry path). */
    sectionHref: string;
}

export type EpubAnnotationResolveErrorCode =
    | "epub_section_not_found"
    | "epub_text_not_found"
    | "epub_math_section_unsupported"
    | "epub_parse_failed";

export interface EpubAnnotationResolveError {
    error: EpubAnnotationResolveErrorCode;
    message?: string;
}

function isResolveError(value: unknown): value is EpubAnnotationResolveError {
    return typeof value === "object" && value !== null && "error" in value;
}

/** A raw spine `<itemref>` plus its resolved manifest data. */
export interface SpineItemref {
    idref: string;
    id: string | null;
    /** Resolved zip entry path (relative to the EPUB root). */
    href: string;
    mediaType: string;
    isXhtml: boolean;
    hasEntry: boolean;
}

export interface EpubSpine {
    /** Element index of `<spine>` among `<package>`'s element children (CFI base prefix). */
    spineNodeIndex: number;
    /** Itemrefs in raw spine order; the array index is the CFI `spinePos`. */
    itemrefs: SpineItemref[];
}

/** Element-only index of `node` among its parent's element children. */
function elementIndexOf(node: Element): number {
    const parent = node.parentNode;
    if (!parent) return -1;
    const children = parent.childNodes;
    let index = -1;
    for (let i = 0; i < children.length; i++) {
        const child = children.item(i);
        if (child && child.nodeType === ELEMENT_NODE) {
            index += 1;
            if (child === node) return index;
        }
    }
    return index;
}

/** Resolve an OPF-relative href against the OPF path, like Zotero's EPUB.mjs. */
function resolveRelativeToOpf(opfPath: string, href: string): string {
    // Phony zip: scheme resolves relative paths platform-independently.
    return new URL(href, "zip:/" + opfPath).pathname.substring(1);
}

/** Direct element children of `parent` whose local name matches (namespace-agnostic). */
function childrenByLocalName(parent: Element, name: string): Element[] {
    const out: Element[] = [];
    for (const child of Array.from(parent.children)) {
        if (child.localName.toLowerCase() === name) out.push(child);
    }
    return out;
}

/**
 * Parse the spine from a content.opf document. Returns the raw `<itemref>`
 * ordering (the array index is the reader's `spinePos`) and the spine element's
 * index in the package (the CFI base prefix). This raw ordering — counting
 * every itemref — is what the reader uses, and what the extractor's compacted
 * section index can drift from on EPUBs with non-XHTML spine items.
 */
export function parseOpfSpine(
    opfDoc: Document,
    opfPath: string,
    hasEntry: (path: string) => boolean,
): EpubSpine {
    const pkg = opfDoc.documentElement;
    const manifest = pkg ? childrenByLocalName(pkg, "manifest")[0] : undefined;
    const spine = pkg ? childrenByLocalName(pkg, "spine")[0] : undefined;
    if (!manifest || !spine) {
        throw new Error("content.opf does not contain <manifest> and <spine>");
    }

    const idToItem = new Map<string, { href: string; mediaType: string }>();
    for (const item of childrenByLocalName(manifest, "item")) {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");
        if (!id || !href) continue;
        idToItem.set(id, {
            href: resolveRelativeToOpf(opfPath, href),
            mediaType: item.getAttribute("media-type") || "",
        });
    }

    const itemrefs: SpineItemref[] = [];
    for (const itemref of childrenByLocalName(spine, "itemref")) {
        const idref = itemref.getAttribute("idref") || "";
        const manifestItem = idToItem.get(idref);
        const href = manifestItem?.href ?? "";
        const mediaType = manifestItem?.mediaType ?? "";
        itemrefs.push({
            idref,
            id: itemref.getAttribute("id"),
            href,
            mediaType,
            isXhtml: mediaType === "application/xhtml+xml",
            hasEntry: href ? hasEntry(href) : false,
        });
    }

    return { spineNodeIndex: elementIndexOf(spine as Element), itemrefs };
}

/**
 * Pick the target itemref. Primary match is href basename (drift-immune).
 * Fallback maps a compacted (extractor) ordinal back to the raw spine index by
 * counting only XHTML itemrefs with present entries — the same items EPUB.mjs
 * yields and the extractor numbers — never matching the ordinal against the raw
 * spine directly.
 */
export function resolveTargetItemref(
    spine: EpubSpine,
    target: EpubAnnotationLocator,
): { itemref: SpineItemref; rawIndex: number } | null {
    const { itemrefs } = spine;

    const targetBasename = normalizeHrefBasename(target.sectionHref);
    if (targetBasename) {
        for (let i = 0; i < itemrefs.length; i++) {
            if (normalizeHrefBasename(itemrefs[i].href) === targetBasename) {
                return { itemref: itemrefs[i], rawIndex: i };
            }
        }
        logger(`[EpubAnnotation] No spine itemref matches href ${targetBasename}`, 1);
    }

    if (
        typeof target.sectionOrdinal === "number"
        && Number.isInteger(target.sectionOrdinal)
        && target.sectionOrdinal >= 1
    ) {
        let compacted = 0;
        for (let i = 0; i < itemrefs.length; i++) {
            if (!itemrefs[i].isXhtml || !itemrefs[i].hasEntry) continue;
            compacted += 1;
            if (compacted === target.sectionOrdinal) {
                return { itemref: itemrefs[i], rawIndex: i };
            }
        }
        logger(`[EpubAnnotation] Section ordinal ${target.sectionOrdinal} out of range`, 1);
    }

    return null;
}

/**
 * Strip `<style>`, stylesheet `<link>`, and `<title>` elements document-wide,
 * mirroring the reader's sanitizer (`reader/src/dom/epub/lib/sanitize-and-render.ts`).
 * A body-level `<style>`/`<link>` before the target would otherwise shift the
 * reader's element indices but not a raw parse, diverging the CFI. `renderMath`
 * is intentionally NOT run (see the MathML guard in {@link buildAnnotationFromDocument}).
 */
export function sanitizeSectionDocument(doc: Document): void {
    const root = doc.documentElement;
    if (!root) return;
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT);
    const toRemove: Element[] = [];
    let current = walker.nextNode() as Element | null;
    while (current) {
        const name = current.localName.toLowerCase();
        if (name === "style" || name === "title") {
            toRemove.push(current);
        } else if (name === "link") {
            const rel = current.getAttribute("rel") || "";
            if (/\bstylesheet\b/i.test(rel)) toRemove.push(current);
        }
        current = walker.nextNode() as Element | null;
    }
    for (const node of toRemove) node.remove();
}

/** True when a MathML element precedes (or contains) `node` in document order. */
function nodePrecededByMath(doc: Document, node: Node): boolean {
    const maths = doc.getElementsByTagNameNS("*", "math");
    for (const math of Array.from(maths)) {
        const position = node.compareDocumentPosition(math);
        if (position & DOCUMENT_POSITION_PRECEDING) return true;
    }
    return false;
}

/** Character count from the section root to the range start (reader's sortIndex offset). */
function computeCharOffset(doc: Document, range: Range): number {
    const root = doc.documentElement;
    if (!root) return 0;
    const measure = doc.createRange();
    measure.setStart(root, 0);
    measure.setEnd(range.startContainer, range.startOffset);
    const length = measure.toString().length;
    measure.detach();
    return length;
}

/**
 * Build the CFI position + sortIndex from a sanitized section document. Locates
 * the range (anchor-scoped, then body-wide, then anchor contents — mirroring the
 * live reader path), refuses math-preceded ranges, and emits the reader-matching
 * CFI via the vendored EpubCFI with `toString(true)` (assertions excluded).
 */
export function buildAnnotationFromDocument(
    doc: Document,
    rawSectionIndex: number,
    spineNodeIndex: number,
    target: EpubAnnotationLocator,
): { position: EpubFragmentSelector; sortIndex: string; text: string } | EpubAnnotationResolveError {
    const body = doc.body ?? doc.querySelector("body") ?? doc.documentElement;
    if (!body) return { error: "epub_text_not_found" };

    const anchorElement = target.anchorId
        ? findAnchorElement(body, target.anchorId)
        : undefined;
    const searchTexts = citationSearchTextCandidates(target.text);

    let range: Range | undefined;
    if (anchorElement) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(anchorElement, searchText);
            if (range) break;
        }
    }
    if (!range) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(body, searchText);
            if (range) break;
        }
    }
    if (!range && anchorElement) {
        range = createElementContentsRange(anchorElement);
    }
    if (!range) return { error: "epub_text_not_found" };

    // Highlights store the precise passage range. Notes anchor to the cited
    // text's containing block so the reader's comment icon lands in the margin
    // beside the block instead of inline on the text (see
    // createContainingBlockRange); the cited passage still selects the block.
    // Falls back to the passage range when there is no block ancestor.
    const text = range.toString();
    const cfiRange = target.anchorToBlock
        ? (createContainingBlockRange(range) ?? range)
        : range;

    // renderMath mutates math subtrees in the reader; a CFI past that point
    // could diverge and we cannot detect it headlessly, so fail observably.
    // Both highlights and block-anchored notes persist a range, so the END
    // boundary is the strictest check: it subsumes the start and catches math
    // sitting between the cited text and the block's last text node — which a
    // start-only check would miss, since a note's stored end path runs past it.
    const mathBoundary = cfiRange.endContainer;
    if (nodePrecededByMath(doc, mathBoundary)) {
        return { error: "epub_math_section_unsupported" };
    }

    const charOffset = computeCharOffset(doc, cfiRange);

    const base = new EpubCFI().generateChapterComponent(spineNodeIndex, rawSectionIndex);
    const cfi = new EpubCFI(cfiRange, base);
    const position = toEpubFragmentSelector(cfi.toString(true));
    const sortIndex = buildEpubSortIndex(rawSectionIndex, charOffset);

    return { position, sortIndex, text };
}

// ---------------------------------------------------------------------------
// Zip-coupled orchestration (requires the Zotero runtime).
// ---------------------------------------------------------------------------

function openZipReader(filePath: string): any {
    const ZipReader = (Components as any).Constructor(
        "@mozilla.org/libjar/zip-reader;1",
        "nsIZipReader",
        "open",
    );
    return new ZipReader((Zotero as any).File.pathToFile(filePath));
}

async function readEntryToDocument(zip: any, entry: string, type: string): Promise<Document> {
    const parser = new DOMParser();
    const stream = zip.getInputStream(entry);
    let xml: string;
    try {
        xml = await (Zotero as any).File.getContentsAsync(stream);
    } finally {
        stream.close();
    }
    return parser.parseFromString(xml, type as DOMParserSupportedType) as unknown as Document;
}

/**
 * Resolve an EPUB annotation locator to a persistable `{ position, sortIndex }`
 * by parsing the EPUB headlessly — no reader instance. Reads `container.xml` →
 * OPF for the raw spine, parses + sanitizes the target section, and computes the
 * reader-matching CFI. Returns a typed error on any failure.
 */
export async function resolveEpubAnnotationTarget(
    filePath: string,
    target: EpubAnnotationLocator,
): Promise<ResolvedEpubAnnotation | EpubAnnotationResolveError> {
    let zip: any;
    try {
        zip = openZipReader(filePath);
    } catch (error) {
        return { error: "epub_parse_failed", message: `Could not open EPUB: ${error}` };
    }

    try {
        if (!zip.hasEntry("META-INF/container.xml")) {
            return { error: "epub_parse_failed", message: "EPUB has no container.xml" };
        }
        const containerDoc = await readEntryToDocument(zip, "META-INF/container.xml", "text/xml");
        const rootfile = containerDoc.documentElement
            ? childrenByLocalName(
                childrenByLocalName(containerDoc.documentElement, "rootfiles")[0]
                    ?? containerDoc.documentElement,
                "rootfile",
            )[0]
            : undefined;
        const opfPath = rootfile?.getAttribute("full-path");
        if (!opfPath) {
            return { error: "epub_parse_failed", message: "EPUB container.xml has no rootfile" };
        }

        const opfDoc = await readEntryToDocument(zip, opfPath, "text/xml");
        const spine = parseOpfSpine(opfDoc, opfPath, (path) => zip.hasEntry(path));

        const match = resolveTargetItemref(spine, target);
        if (!match || !match.itemref.href || !zip.hasEntry(match.itemref.href)) {
            return { error: "epub_section_not_found" };
        }

        const sectionDoc = await readEntryToDocument(
            zip,
            match.itemref.href,
            "application/xhtml+xml",
        );
        sanitizeSectionDocument(sectionDoc);

        const built = buildAnnotationFromDocument(
            sectionDoc,
            match.rawIndex,
            spine.spineNodeIndex,
            target,
        );
        if (isResolveError(built)) return built;

        return {
            ...built,
            rawSectionIndex: match.rawIndex,
            sectionHref: match.itemref.href,
        };
    } catch (error) {
        logger(`[EpubAnnotation] resolveEpubAnnotationTarget failed: ${error}`, 1);
        return { error: "epub_parse_failed", message: String(error) };
    } finally {
        try {
            zip?.close?.();
        } catch {
            // best-effort
        }
    }
}
