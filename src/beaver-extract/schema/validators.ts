import type {
    BeaverExtractResult,
    MarkdownExtractResult,
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
    if (!Number.isInteger(result.document.bboxPrecision)) {
        throw new Error("$.document.bboxPrecision must be an integer");
    }
    assertObject(result.document.citationIndex, "$.document.citationIndex");
    result.document.pages.forEach((page, pageOffset) => {
        if (!Array.isArray(page.items)) {
            throw new Error(`$.document.pages[${pageOffset}].items must be an array`);
        }
        page.items.forEach((item, itemOffset) => {
            if (typeof item.id !== "string" || item.id.length === 0) {
                throw new Error(
                    `$.document.pages[${pageOffset}].items[${itemOffset}].id must be a non-empty string`,
                );
            }
            if (!Array.isArray(item.bboxes)) {
                throw new Error(
                    `$.document.pages[${pageOffset}].items[${itemOffset}].bboxes must be an array`,
                );
            }
        });
    });
    return result;
}
