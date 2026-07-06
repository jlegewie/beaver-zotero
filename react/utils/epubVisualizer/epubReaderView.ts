import { BEAVER_VISUALIZER_ANNOTATION_AUTHOR } from "../../../src/constants/annotations";
import { logger } from "../../../src/utils/logger";
import { libraryRefForLibraryID } from "../../../src/utils/libraryIdentity";
import type { ZoteroItemReference } from "../../types/zotero";
import { ZoteroReader } from "../annotationUtils";
import { getCurrentReaderAndWaitForView } from "../readerUtils";

export type EpubAnnotationType = "highlight" | "underline";

export interface EpubSectionRenderer {
    mounted?: boolean;
    body?: HTMLElement;
    container?: Element;
    section?: {
        index?: number;
        href?: string;
    };
    mount?: () => void;
}

export interface EpubPrimaryView {
    _iframeWindow?: Window;
    _iframeDocument?: Document;
    _sectionRenderers?: EpubSectionRenderer[];
    renderers?: EpubSectionRenderer[];
    getAnnotationFromRange?: (
        range: Range,
        type: EpubAnnotationType,
        color?: string,
    ) => EpubRangeAnnotation | null;
}

export interface EpubRangeAnnotation {
    type: EpubAnnotationType;
    color?: string;
    sortIndex: string;
    pageLabel?: string;
    position: unknown;
    text?: string;
    comment?: string;
}

export interface ActiveEpubView {
    reader: ZoteroReader;
    primaryView: EpubPrimaryView;
    item: Zotero.Item;
}

/** Resolve the active Zotero EPUB reader and its primary DOM view. */
export async function getActiveEpubView(): Promise<ActiveEpubView | { error: string }> {
    const reader = await getCurrentReaderAndWaitForView(undefined, false);
    if (!reader || !reader._internalReader) return { error: "No active EPUB reader found" };
    if (reader.type !== "epub") return { error: "Current reader is not an EPUB" };

    const primaryView = reader._internalReader._primaryView as EpubPrimaryView | undefined;
    if (!primaryView) return { error: "Could not access EPUB reader view" };
    if (typeof primaryView.getAnnotationFromRange !== "function") {
        return { error: "EPUB reader does not support range annotations" };
    }

    const item = Zotero.Items.get(reader.itemID);
    if (!item) return { error: "Could not find Zotero item" };

    return { reader: reader as ZoteroReader, primaryView, item };
}

/** Return reader section indexes whose mounted containers intersect the viewport. */
export function getVisibleSectionIndexes(primaryView: EpubPrimaryView): number[] {
    const iframeWindow = primaryView._iframeWindow;
    if (!iframeWindow) {
        logger("[EpubVisualizer] EPUB iframe window is unavailable", 1);
        return [];
    }

    const visible: number[] = [];
    for (const renderer of getRenderers(primaryView)) {
        if (!renderer?.mounted || !renderer.container) continue;
        if (!isPageRectVisible(getBoundingPageRect(renderer.container), iframeWindow)) continue;

        const sectionIndex = renderer.section?.index;
        if (typeof sectionIndex === "number") visible.push(sectionIndex);
    }
    return visible;
}

/** Return the live section body for a reader spine section index. */
export function getSectionBody(
    primaryView: EpubPrimaryView,
    sectionIndex: number,
): HTMLElement | undefined {
    return getRenderers(primaryView)[sectionIndex]?.body;
}

/** Return the reader's href for a rendered spine section index. */
export function getSectionHref(
    primaryView: EpubPrimaryView,
    sectionIndex: number,
): string | undefined {
    return getRenderers(primaryView)[sectionIndex]?.section?.href;
}

/** Return the number of spine sections known to the reader. */
export function getSectionCount(primaryView: EpubPrimaryView): number {
    return getRenderers(primaryView).length;
}

/**
 * Ensure a spine section's container is attached to the live DOM. Section
 * bodies are rendered at load time, but the reader keeps off-screen sections
 * unmounted; the reader itself force-mounts on CFI navigation, so doing the
 * same here is safe. Returns true when the section body is available.
 */
export function ensureSectionMounted(
    primaryView: EpubPrimaryView,
    sectionIndex: number,
): boolean {
    const renderer = getRenderers(primaryView)[sectionIndex];
    if (!renderer) return false;
    if (!renderer.mounted && typeof renderer.mount === "function") {
        try {
            renderer.mount();
        } catch (error) {
            logger(`[EpubReaderView] Failed to mount section ${sectionIndex}: ${error}`, 1);
        }
    }
    return !!renderer.body;
}

/** Create a Zotero EPUB annotation descriptor from a DOM range. */
export function annotationFromRange(
    primaryView: EpubPrimaryView,
    range: Range,
    type: EpubAnnotationType,
    color: string,
): EpubRangeAnnotation | null {
    const getAnnotation = primaryView.getAnnotationFromRange;
    if (typeof getAnnotation !== "function") return null;
    return getAnnotation.call(primaryView, range, type, color);
}

/**
 * Push temporary EPUB annotations into the reader and return tracking refs.
 */
export function setTemporaryAnnotations(
    reader: ZoteroReader,
    annotations: EpubRangeAnnotation[],
    options: { authorName?: string; idPrefix?: string } = {},
): ZoteroItemReference[] {
    if (annotations.length === 0) return [];

    const libraryId = (reader as any)._item?.libraryID;
    if (typeof libraryId !== "number") {
        logger("[EpubVisualizer] Reader item libraryID is unavailable", 1);
        return [];
    }

    const authorName = options.authorName ?? BEAVER_VISUALIZER_ANNOTATION_AUTHOR;
    const idPrefix = options.idPrefix ?? "epub_visualizer";
    const now = new Date().toISOString();
    const tempAnnotations: any[] = [];
    const refs: ZoteroItemReference[] = [];

    annotations.forEach((annotation, index) => {
        const tempId = `${idPrefix}_${Date.now()}_${index}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;
        const annotationColor = annotation.color ?? "#ffcc00";
        const annotationText = annotation.text ?? "";
        const annotationComment = annotation.comment ?? annotationText;
        const pageLabel = annotation.pageLabel ?? "";
        const annotationPosition = JSON.stringify(annotation.position);

        tempAnnotations.push({
            id: tempId,
            key: tempId,
            libraryID: libraryId,
            type: annotation.type,
            color: annotationColor,
            sortIndex: annotation.sortIndex,
            position: annotation.position,
            tags: [],
            comment: annotationComment,
            text: annotationText,
            authorName,
            pageLabel,
            isExternal: false,
            readOnly: false,
            lastModifiedByUser: "",
            dateModified: now,
            annotationType: annotation.type,
            annotationAuthorName: authorName,
            annotationText,
            annotationComment,
            annotationColor,
            annotationPageLabel: pageLabel,
            annotationSortIndex: annotation.sortIndex,
            annotationPosition,
            annotationIsExternal: false,
            isTemporary: true,
        });
        refs.push({
            zotero_key: tempId,
            library_id: libraryId,
            library_ref: libraryRefForLibraryID(libraryId) ?? undefined,
        });
    });

    (reader as any)._internalReader.setAnnotations(
        Components.utils.cloneInto(tempAnnotations, (reader as any)._iframeWindow),
    );
    return refs;
}

function getRenderers(primaryView: EpubPrimaryView): EpubSectionRenderer[] {
    return primaryView.renderers ?? primaryView._sectionRenderers ?? [];
}

function getBoundingPageRect(element: Element): DOMRectReadOnly {
    const rect = element.getBoundingClientRect();
    const win = element.ownerDocument?.defaultView;
    return {
        x: rect.x + (win?.scrollX ?? 0),
        y: rect.y + (win?.scrollY ?? 0),
        width: rect.width,
        height: rect.height,
        top: rect.top + (win?.scrollY ?? 0),
        right: rect.right + (win?.scrollX ?? 0),
        bottom: rect.bottom + (win?.scrollY ?? 0),
        left: rect.left + (win?.scrollX ?? 0),
        toJSON: () => rect.toJSON(),
    };
}

function isPageRectVisible(rect: DOMRectReadOnly, win: Window, margin = 50): boolean {
    if (rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0) {
        return false;
    }

    const viewport = {
        left: win.scrollX - margin,
        top: win.scrollY - margin,
        right: win.scrollX + win.innerWidth + margin,
        bottom: win.scrollY + win.innerHeight + margin,
    };
    return (
        rect.left < viewport.right
        && rect.right > viewport.left
        && rect.top < viewport.bottom
        && rect.bottom > viewport.top
    );
}
