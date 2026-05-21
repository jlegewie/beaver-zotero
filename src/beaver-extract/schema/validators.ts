import type {
    BeaverExtractResult,
    DocumentItem,
    MarkdownExtractResult,
    Rect,
    StructuredExtractResult,
} from "./schema";
import { SCHEMA_VERSION } from "./schema";

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
}

function assertResultBase(value: unknown, expectedMode: BeaverExtractResult["mode"]) {
    assertObject(value, "$");
    if (value.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`$.schemaVersion must be "${SCHEMA_VERSION}"`);
    }
    if (value.mode !== expectedMode) {
        throw new Error(`$.mode must be "${expectedMode}"`);
    }
    assertObject(value.document, "$.document");
    const pageCount = value.document.pageCount;
    if (!Number.isInteger(pageCount) || (pageCount as number) < 0) {
        throw new Error("$.document.pageCount must be a non-negative integer");
    }
    if (!Array.isArray(value.document.pages)) {
        throw new Error("$.document.pages must be an array");
    }
}

function assertRect(value: unknown, path: string): asserts value is Rect {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        !value.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
        throw new Error(`${path} must be a finite [l,t,r,b] tuple`);
    }
}

export function validateMarkdownExtractResult(
    json: unknown,
): MarkdownExtractResult {
    assertResultBase(json, "markdown");
    const result = json as MarkdownExtractResult;
    result.document.pages.forEach((page, index) => {
        if (!Number.isInteger(page.index)) {
            throw new Error(`$.document.pages[${index}].index must be an integer`);
        }
        if (typeof page.markdown !== "string") {
            throw new Error(`$.document.pages[${index}].markdown must be a string`);
        }
    });
    return result;
}

export function validateStructuredExtractResult(
    json: unknown,
): StructuredExtractResult {
    assertResultBase(json, "structured");
    const result = json as StructuredExtractResult;
    if (result.document.bboxOrigin !== "top-left") {
        throw new Error('$.document.bboxOrigin must be "top-left"');
    }
    if (
        !Number.isInteger(result.document.bboxPrecision) ||
        result.document.bboxPrecision < 0
    ) {
        throw new Error("$.document.bboxPrecision must be a non-negative integer");
    }
    assertObject(result.document.citationIndex, "$.document.citationIndex");
    const itemIds = new Set<string>();
    const sentenceIds = new Set<string>();
    result.document.pages.forEach((page, pageOffset) => {
        if (page.index !== pageOffset) {
            throw new Error(`$.document.pages[${pageOffset}].index must match its array position`);
        }
        if (!Array.isArray(page.items)) {
            throw new Error(`$.document.pages[${pageOffset}].items must be an array`);
        }
        page.items.forEach((item, itemOffset) => {
            if (typeof item.id !== "string" || item.id.length === 0) {
                throw new Error(
                    `$.document.pages[${pageOffset}].items[${itemOffset}].id must be a non-empty string`,
                );
            }
            itemIds.add(item.id);
            assertRect(item.bbox, `$.document.pages[${pageOffset}].items[${itemOffset}].bbox`);
            if ("sentences" in item && item.sentences) {
                item.sentences.forEach((sentence, sentenceOffset) => {
                    if (typeof sentence.id !== "string" || sentence.id.length === 0) {
                        throw new Error(
                            `$.document.pages[${pageOffset}].items[${itemOffset}].sentences[${sentenceOffset}].id must be a non-empty string`,
                        );
                    }
                    sentenceIds.add(sentence.id);
                    sentence.bboxes.forEach((bbox, bboxOffset) =>
                        assertRect(
                            bbox,
                            `$.document.pages[${pageOffset}].items[${itemOffset}].sentences[${sentenceOffset}].bboxes[${bboxOffset}]`,
                        ),
                    );
                });
            }
        });
    });
    for (const [id, entry] of Object.entries(result.document.citationIndex)) {
        if (entry.id !== id) {
            throw new Error(`$.document.citationIndex.${id}.id must match its key`);
        }
        if (!itemIds.has(entry.itemId)) {
            throw new Error(`$.document.citationIndex.${id}.itemId does not resolve to an item`);
        }
        if (entry.kind === "sentence" && (!entry.sentenceId || !sentenceIds.has(entry.sentenceId))) {
            throw new Error(`$.document.citationIndex.${id}.sentenceId does not resolve to a sentence`);
        }
        if (entry.kind === "item" && entry.sentenceId) {
            throw new Error(`$.document.citationIndex.${id}.sentenceId must be absent for item entries`);
        }
    }
    return result;
}
