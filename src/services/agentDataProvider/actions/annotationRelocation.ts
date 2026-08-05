import {
    parseLoc,
    citationIndexCandidateIdsForLocator,
} from "@beaver/agent-core/citations/citationGrammar";
import type { BoundingBox } from "@beaver/agent-core/types/citations";
import { CoordOrigin } from "@beaver/agent-core/types/citations";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { getReadableContentKind } from "../../documentExtraction/attachmentResolution";
import {
    createEpubHighlightAnnotation,
    createEpubNoteAnnotation,
    createHighlightAnnotation,
    createNoteAnnotation,
    createSnapshotHighlightAnnotation,
    createSnapshotNoteAnnotation,
    getPageGeometryForAttachment,
    prepareEpubAnnotationTarget,
    prepareSnapshotAnnotationDocument,
} from "../../annotations/createAnnotation";
import {
    extractAndCacheDocument,
    extractAndCacheEpubDocument,
    extractAndCacheSnapshotDocument,
} from "../../documentExtractionCore";

export type RelocatableAnnotationType = "highlight" | "note";

export interface ResolvedRelocationTarget {
    attachment: Zotero.Item;
    annotationType: RelocatableAnnotationType;
    locator: string;
    create: (metadata: {
        color: string;
        comment: string;
        tags: string[];
    }) => Promise<ZoteroItemReference>;
}

function locatorCandidates(raw: string): string[] {
    const parsed = parseLoc(raw);
    if (!parsed || parsed.kind === "unknown") {
        throw new Error(`Unsupported annotation locator '${raw}'`);
    }
    return citationIndexCandidateIdsForLocator(parsed);
}

function pdfEntries(
    document: any,
    raw: string,
): Array<{ entry: any; item: any; sentence?: any }> {
    const parsed = parseLoc(raw)!;
    let entry: any;
    if (parsed.kind === "page") {
        const pageIndex = /^\d+$/.test(parsed.value)
            ? Number(parsed.value) - 1
            : -1;
        const page = document.pages.find(
            (candidate: any) =>
                candidate.label === parsed.value ||
                candidate.index === pageIndex,
        );
        const item = page?.items?.find(
            (candidate: any) => candidate.text || candidate.sentences?.length,
        );
        if (!page || !item)
            throw new Error(`Locator '${raw}' has no annotatable text`);
        return [
            {
                entry: {
                    pageIndex: page.index,
                    pageLabel: page.label,
                    itemId: item.id,
                },
                item,
            },
        ];
    }
    const resolved: Array<{ entry: any; item: any; sentence?: any }> = [];
    for (const id of locatorCandidates(raw)) {
        entry = document.citationIndex[id];
        if (!entry) continue;
        const page = document.pages[entry.pageIndex];
        const item = page?.items?.find(
            (candidate: any) => candidate.id === entry.itemId,
        );
        const sentence = entry.sentenceId
            ? item?.sentences?.find(
                  (candidate: any) => candidate.id === entry.sentenceId,
              )
            : undefined;
        if (item) resolved.push({ entry, item, sentence });
    }
    if (!resolved.length)
        throw new Error(`Locator '${raw}' was not found in the attachment`);
    if (new Set(resolved.map(({ entry }) => entry.pageIndex)).size > 1) {
        throw new Error(
            `Locator '${raw}' spans pages; relocation requires one page`,
        );
    }
    return resolved;
}

function domEntry(
    document: any,
    raw: string,
): { section: any; item: any; text: string; anchorId?: string } {
    const parsed = parseLoc(raw)!;
    let entry: any;
    if (parsed.kind === "page") {
        const pageNumber = /^\d+$/.test(parsed.value)
            ? Number(parsed.value)
            : -1;
        for (const section of document.sections) {
            const item = section.items.find(
                (candidate: any) =>
                    candidate.pageLabel === parsed.value ||
                    candidate.pageNumber === pageNumber,
            );
            if (item)
                return {
                    section,
                    item,
                    text: item.text ?? "",
                    anchorId: item.anchorId,
                };
        }
        throw new Error(`Locator '${raw}' has no annotatable text`);
    }
    for (const id of locatorCandidates(raw)) {
        entry = document.citationIndex[id];
        if (entry) break;
    }
    if (!entry)
        throw new Error(`Locator '${raw}' was not found in the attachment`);
    const section = document.sections.find(
        (candidate: any) => candidate.index === entry.sectionIndex,
    );
    const item = section?.items?.find(
        (candidate: any) => candidate.id === entry.itemId,
    );
    const sentence = entry.sentenceId
        ? item?.sentences?.find(
              (candidate: any) => candidate.id === entry.sentenceId,
          )
        : undefined;
    if (!section || !item)
        throw new Error(`Locator '${raw}' could not be resolved safely`);
    return {
        section,
        item,
        text: sentence?.text ?? item.text ?? "",
        anchorId: entry.anchorId ?? item.anchorId,
    };
}

/**
 * Resolve a compact, human-readable locator into a closure over client-derived
 * annotation inputs. No model-supplied position or geometry crosses this seam.
 */
export async function resolveAnnotationRelocation(
    attachment: Zotero.Item,
    annotationType: RelocatableAnnotationType,
    locator: string,
    signal?: AbortSignal,
): Promise<ResolvedRelocationTarget> {
    const contentKind = getReadableContentKind(attachment);
    const contentType =
        attachment.attachmentContentType || "application/octet-stream";
    const resolvedKey = `${attachment.libraryID}-${attachment.key}`;

    if (contentKind === "pdf") {
        const result = await extractAndCacheDocument({
            libraryId: attachment.libraryID,
            zoteroKey: attachment.key,
            mode: "structured",
            maxPages: null,
            maxFileSizeMB: 100,
            timeoutSeconds: 25,
            externalAbortSignal: signal,
        });
        if (
            result.kind !== "ok" ||
            !result.result ||
            result.result.mode !== "structured"
        ) {
            throw new Error(
                `Could not resolve locator '${locator}' in the PDF`,
            );
        }
        const located = pdfEntries(result.result.document, locator);
        const entry = located[0].entry;
        const boxes = located.flatMap(({ item, sentence }) =>
            (sentence?.bboxes?.length ? sentence.bboxes : [item.bbox]).map(
                ([l, t, r, b]: number[]) =>
                    ({
                        l,
                        t,
                        r,
                        b,
                        coord_origin: CoordOrigin.TOPLEFT,
                    }) as BoundingBox,
            ),
        );
        const text = located
            .map(({ item, sentence }) => sentence?.text ?? item.text ?? "")
            .filter(Boolean)
            .join(" ");
        if (!boxes.length || (annotationType === "highlight" && !text)) {
            throw new Error(`Locator '${locator}' has no annotatable text`);
        }
        // Resolve page geometry now, outside any DB transaction. The extract
        // above normally leaves it cached, but on a miss the lookup runs a full
        // PDF analysis — which the writers would otherwise do from inside
        // relocation's transaction, holding Zotero's global write lock.
        const geometry = await getPageGeometryForAttachment(
            attachment,
            entry.pageIndex,
        );
        return {
            attachment,
            annotationType,
            locator,
            create: (metadata) =>
                annotationType === "highlight"
                    ? createHighlightAnnotation(attachment, {
                          pageIndex: entry.pageIndex,
                          boxes,
                          text,
                          color: metadata.color,
                          comment: metadata.comment,
                          pageLabel: entry.pageLabel,
                          tags: metadata.tags,
                      }, geometry)
                    : createNoteAnnotation(attachment, {
                          notePosition: {
                              page_index: entry.pageIndex,
                              side: "left",
                              x: boxes[0].l,
                              y: (boxes[0].t + boxes[0].b) / 2,
                              coord_origin: CoordOrigin.TOPLEFT,
                          },
                          comment: metadata.comment,
                          color: metadata.color,
                          pageLabel: entry.pageLabel,
                          tags: metadata.tags,
                      }, geometry),
        };
    }

    if (contentKind !== "epub" && contentKind !== "snapshot") {
        throw new Error(
            "Only PDF, EPUB, and snapshot annotations can be relocated",
        );
    }
    const common = {
        source: { kind: "zotero" as const, item: attachment },
        resolvedKey,
        contentType,
        maxPages: null,
        maxFileSizeMB: 100,
        externalAbortSignal: signal,
    };
    const result =
        contentKind === "epub"
            ? await extractAndCacheEpubDocument(common)
            : await extractAndCacheSnapshotDocument(common);
    if (result.kind !== "ok")
        throw new Error(
            `Could not resolve locator '${locator}' in the attachment`,
        );
    const target = domEntry(result.document, locator);
    if (annotationType === "highlight" && !target.text) {
        throw new Error(`Locator '${locator}' has no annotatable text`);
    }

    // Resolve the write target NOW, while no DB transaction is open. The EPUB
    // and snapshot writers otherwise re-open and re-parse the source file from
    // inside `create()`, which relocation calls while holding Zotero's global
    // write lock — stalling every other Zotero write for the duration, and
    // failing them outright at the 30s transaction timeout.
    const epubPrepared =
        contentKind === "epub"
            ? await prepareEpubAnnotationTarget(attachment, {
                  sectionHref: target.section.rawHref,
                  sectionOrdinal: target.section.index + 1,
                  anchorId: target.anchorId,
                  text: target.text,
                  ...(annotationType === "note" ? { anchorToBlock: true } : {}),
              })
            : undefined;
    const snapshotPrepared =
        contentKind === "snapshot"
            ? await prepareSnapshotAnnotationDocument(attachment)
            : undefined;

    return {
        attachment,
        annotationType,
        locator,
        create: (metadata) => {
            if (contentKind === "epub") {
                const input = {
                    sectionHref: target.section.rawHref,
                    sectionOrdinal: target.section.index + 1,
                    anchorId: target.anchorId,
                    text: target.text,
                    comment: metadata.comment,
                    color: metadata.color,
                    pageLabel: target.item.pageLabel ?? null,
                    tags: metadata.tags,
                };
                return annotationType === "highlight"
                    ? createEpubHighlightAnnotation(attachment, input, epubPrepared)
                    : createEpubNoteAnnotation(attachment, input, epubPrepared);
            }
            const input = {
                anchorId: target.anchorId,
                text: target.text,
                comment: metadata.comment,
                color: metadata.color,
                tags: metadata.tags,
            };
            return annotationType === "highlight"
                ? createSnapshotHighlightAnnotation(
                      attachment,
                      input,
                      snapshotPrepared,
                  )
                : createSnapshotNoteAnnotation(attachment, input, snapshotPrepared);
        },
    };
}
