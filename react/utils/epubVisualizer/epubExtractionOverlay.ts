import { ITEM_KIND_STYLE, OVERLAY_COLORS } from "../../../src/beaver-extract/debug/overlayBuilders";
import type { EpubDocument } from "../../../src/services/documentExtraction/epub";
import type {
    DomItem,
    DomItemKind,
    DomSentence,
} from "../../../src/services/documentExtraction/dom";

export type EpubDescriptorKind = "item" | "sentence";

export interface EpubSentenceDescriptor {
    text: string;
    color: string;
    label: string;
    sentenceId: string;
    annotationComment: string;
}

export interface EpubDrawDescriptor {
    sectionIndex: number;
    itemIndexInSection: number;
    itemId: string;
    kind: EpubDescriptorKind;
    itemKind: DomItemKind;
    color: string;
    label: string;
    annotationComment: string;
    type: "highlight" | "underline";
    text?: string;
    sentences?: EpubSentenceDescriptor[];
}

export interface EpubOverlayResult {
    descriptors: EpubDrawDescriptor[];
    stats: {
        items: number;
        sentences: number;
        unsupportedPictures: number;
    };
}

/** Build item-level draw descriptors for an extracted EPUB document. */
export function buildEpubItemOverlay(document: EpubDocument): EpubOverlayResult {
    const descriptors: EpubDrawDescriptor[] = [];
    let unsupportedPictures = 0;

    for (const section of document.sections) {
        section.items.forEach((item, itemIndexInSection) => {
            if (item.kind === "picture") {
                unsupportedPictures += 1;
                return;
            }
            descriptors.push({
                sectionIndex: section.index,
                itemIndexInSection,
                itemId: item.id,
                kind: "item",
                itemKind: item.kind,
                color: colorForItemKind(item.kind),
                label: itemLabel(item),
                annotationComment: itemAnnotationComment(section.index, item),
                type: "highlight",
                text: item.text,
            });
        });
    }

    return {
        descriptors,
        stats: {
            items: descriptors.length,
            sentences: 0,
            unsupportedPictures,
        },
    };
}

/** Build sentence-level draw descriptors for an extracted EPUB document. */
export function buildEpubSentenceOverlay(document: EpubDocument): EpubOverlayResult {
    const descriptors: EpubDrawDescriptor[] = [];
    let unsupportedPictures = 0;
    let sentenceIndex = 0;

    for (const section of document.sections) {
        section.items.forEach((item, itemIndexInSection) => {
            if (item.kind === "picture") {
                unsupportedPictures += 1;
                return;
            }

            const sentences = (item.sentences ?? []).filter((sentence) => sentence.text.trim());
            if (sentences.length === 0) {
                descriptors.push({
                    sectionIndex: section.index,
                    itemIndexInSection,
                    itemId: item.id,
                    kind: "sentence",
                    itemKind: item.kind,
                    color: colorForItemKind(item.kind),
                    label: itemLabel(item),
                    annotationComment: itemAnnotationComment(section.index, item),
                    type: "highlight",
                    text: item.text,
                    sentences: [],
                });
                return;
            }

            descriptors.push({
                sectionIndex: section.index,
                itemIndexInSection,
                itemId: item.id,
                kind: "sentence",
                itemKind: item.kind,
                color: colorForItemKind(item.kind),
                label: itemLabel(item),
                annotationComment: itemAnnotationComment(section.index, item),
                type: "highlight",
                text: item.text,
                sentences: sentences.map((sentence) => {
                    const label = `S${sentenceIndex + 1}`;
                    const color = OVERLAY_COLORS.sentence[
                        sentenceIndex % OVERLAY_COLORS.sentence.length
                    ];
                    sentenceIndex += 1;
                    return sentenceDescriptor(section.index, item, sentence, color, label);
                }),
            });
        });
    }

    return {
        descriptors,
        stats: {
            items: descriptors.length,
            sentences: sentenceIndex,
            unsupportedPictures,
        },
    };
}

export function colorForItemKind(kind: DomItemKind): string {
    return ITEM_KIND_STYLE[kind].color;
}

function itemLabel(item: DomItem): string {
    const style = ITEM_KIND_STYLE[item.kind];
    return `${style.prefix}${item.order + 1}`;
}

function sentenceDescriptor(
    sectionIndex: number,
    item: DomItem,
    sentence: DomSentence,
    color: string,
    label: string,
): EpubSentenceDescriptor {
    return {
        text: sentence.text,
        color,
        label,
        sentenceId: sentence.id,
        annotationComment:
            `section ${sectionIndex + 1}, item ${item.id}, ${sentence.id}\n` +
            sentence.text,
    };
}

function itemAnnotationComment(sectionIndex: number, item: DomItem): string {
    const text = item.text ?? item.kind;
    return `section ${sectionIndex + 1}, item ${item.id}, ${item.kind}\n${text}`;
}
