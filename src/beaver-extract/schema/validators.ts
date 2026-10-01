import type {
    BeaverExtractResult,
    DocumentItem,
    MarkdownExtractResult,
    Rect,
    StructuredExtractResult,
} from "@beaver/agent-core/extract/schema";
import { SCHEMA_VERSION } from "@beaver/agent-core/extract/schema";

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
}

function assertResultBase(
    value: unknown,
    expectedMode: BeaverExtractResult["mode"],
    expectedSchemaVersion: string,
) {
    assertObject(value, "$");
    if (value.schemaVersion !== expectedSchemaVersion) {
        throw new Error(`$.schemaVersion must be "${expectedSchemaVersion}"`);
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

/** `expectedSchemaVersion` defaults to the current PDF schema version. */
export function validateMarkdownExtractResult(
    json: unknown,
    expectedSchemaVersion = SCHEMA_VERSION,
): MarkdownExtractResult {
    assertResultBase(json, "markdown", expectedSchemaVersion);
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

/** `expectedSchemaVersion` defaults to the current PDF schema version. */
export function validateStructuredExtractResult(
    json: unknown,
    expectedSchemaVersion = SCHEMA_VERSION,
): StructuredExtractResult {
    assertResultBase(json, "structured", expectedSchemaVersion);
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
            assertRect(item.bbox, `$.document.pages[${pageOffset}].items[${itemOffset}].bbox`);
            if ("sentences" in item && item.sentences) {
                item.sentences.forEach((sentence, sentenceOffset) => {
                    if (typeof sentence.id !== "string" || sentence.id.length === 0) {
                        throw new Error(
                            `$.document.pages[${pageOffset}].items[${itemOffset}].sentences[${sentenceOffset}].id must be a non-empty string`,
                        );
                    }
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
    return result;
}
