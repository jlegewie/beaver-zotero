import type { EpubItemKind } from "./schema";

const EPUB_TYPE_NS = "http://www.idpf.org/2007/ops";

export interface EpubElementMapping {
    kind: EpubItemKind;
    level?: number;
}

export interface EpubDomItemCandidate extends EpubElementMapping {
    element: Element;
    text: string;
    anchorId?: string;
}

/** Normalize DOM text into a compact single-line string. */
export function normalizeEpubText(text: string | null | undefined): string {
    return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Return the nearest stable element id at or above the current element. */
export function findNearestAnchorId(element: Element): string | undefined {
    let current: Element | null = element;
    while (current) {
        const id = current.getAttribute("id");
        if (id) return id;
        current = current.parentElement;
    }
    return undefined;
}

/** Detect EPUB footnote semantics without namespace-prefixed CSS selectors. */
export function isEpubFootnoteElement(element: Element): boolean {
    const epubType = element.getAttributeNS(EPUB_TYPE_NS, "type");
    const plainType = element.getAttribute("type");
    const className = element.getAttribute("class");
    return hasToken(epubType, "footnote")
        || hasToken(plainType, "footnote")
        || hasToken(className, "footnote");
}

/** Map an EPUB DOM element to the geometry-free item kind Beaver stores. */
export function mapEpubElement(element: Element): EpubElementMapping | undefined {
    if (isEpubFootnoteElement(element)) {
        return { kind: "footnote" };
    }

    const name = element.localName.toLowerCase();
    if (name === "p" || name === "blockquote") return { kind: "text" };
    if (/^h[1-6]$/.test(name)) {
        return { kind: "section_header", level: Number(name.slice(1)) };
    }
    if (name === "li") return { kind: "list_item" };
    if (name === "figcaption") return { kind: "caption" };
    if (name === "table") return { kind: "table" };
    if (name === "img" || name === "svg") return { kind: "picture" };
    return undefined;
}

/** Walk an EPUB section body and emit owned, non-duplicated item candidates. */
export function collectEpubDomItems(body: Element): EpubDomItemCandidate[] {
    const candidates: EpubDomItemCandidate[] = [];

    const visit = (element: Element): void => {
        const mapping = mapEpubElement(element);
        if (mapping) {
            const candidate = buildCandidate(element, mapping);
            if (candidate) {
                candidates.push(candidate);
            }
            if (ownsSubtree(element, mapping.kind)) return;
        }

        for (const child of Array.from(element.children)) {
            visit(child);
        }
    };

    for (const child of Array.from(body.children)) {
        visit(child);
    }

    return candidates;
}

function buildCandidate(
    element: Element,
    mapping: EpubElementMapping,
): EpubDomItemCandidate | undefined {
    const text = textForMappedElement(element, mapping.kind);
    if (!text) return undefined;
    return {
        element,
        kind: mapping.kind,
        level: mapping.level,
        text,
        anchorId: findNearestAnchorId(element),
    };
}

function textForMappedElement(element: Element, kind: EpubItemKind): string {
    if (kind === "picture") {
        return normalizeEpubText(
            element.getAttribute("alt")
            || element.getAttribute("title"),
        );
    }
    return normalizeEpubText(element.textContent);
}

function ownsSubtree(element: Element, kind: EpubItemKind): boolean {
    if (kind === "text") {
        const name = element.localName.toLowerCase();
        return name === "blockquote" || name === "p";
    }
    return kind !== "picture";
}

function hasToken(value: string | null, token: string): boolean {
    if (!value) return false;
    return value.split(/\s+/).some((part) => part.toLowerCase() === token);
}
