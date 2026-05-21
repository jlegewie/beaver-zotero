import { describe, expect, it } from "vitest";

import {
    FIXTURE_SCHEMA_VERSION,
    FixtureValidationError,
    validateFixture,
} from "../../../src/beaver-extract/cli/fixture/fixtureSchema";

function fixture(): Record<string, any> {
    return {
        schema: FIXTURE_SCHEMA_VERSION,
        id: "synth__p0",
        capturedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pdfSha256: "a".repeat(64),
        pdfBytes: 8,
        config: {
            pageIndices: [0],
            analysisScope: "document",
            splitterConfig: { type: "sentencex" },
            settings: {},
            paragraphSettings: {},
        },
        fingerprints: {
            extractorGitSha: null,
            extractorVersion: null,
            mupdfWasmSha256: "0".repeat(64),
            sentencexWasmSha256: "0".repeat(64),
        },
        tolerance: { bboxAbsPt: 0.5 },
        expected: {
            structured: { pages: [structuredPage(0)] },
            markdown: { pages: [markdownPage(0)] },
        },
    };
}

function structuredPage(index: number): Record<string, any> {
    return {
        index,
        width: 100,
        height: 200,
        items: [
            {
                id: `p${index}`,
                kind: "text",
                pageIndex: index,
                order: 0,
                bbox: [1, 2, 3, 4],
                text: "Hello.",
                sentences: [
                    {
                        id: `s${index}`,
                        order: 0,
                        text: "Hello.",
                        bboxes: [[1, 2, 3, 4]],
                    },
                ],
            },
        ],
    };
}

function markdownPage(index: number): Record<string, any> {
    return {
        index,
        width: 100,
        height: 200,
        markdown: "Hello.",
    };
}

function expectFixtureError(value: unknown, pattern: RegExp): void {
    expect(() => validateFixture(value)).toThrow(FixtureValidationError);
    expect(() => validateFixture(value)).toThrow(pattern);
}

describe("fixture schema validator", () => {
    it("requires structured page indices to equal config.pageIndices", () => {
        const f = fixture();
        f.config.pageIndices = [0, 2];
        f.expected.structured.pages = [structuredPage(0), structuredPage(1)];
        f.expected.markdown.pages = [markdownPage(0), markdownPage(2)];
        expectFixtureError(f, /expected\.structured\.pages: page indices/);
    });

    it("requires markdown page indices to equal config.pageIndices", () => {
        const f = fixture();
        f.config.pageIndices = [0, 2];
        f.expected.structured.pages = [structuredPage(0), structuredPage(2)];
        f.expected.markdown.pages = [markdownPage(0), markdownPage(1)];
        expectFixtureError(f, /expected\.markdown\.pages: page indices/);
    });

    it("forbids sentences on section headers", () => {
        const f = fixture();
        f.expected.structured.pages[0].items[0] = {
            id: "heading1",
            kind: "section_header",
            pageIndex: 0,
            order: 0,
            bbox: [1, 2, 3, 4],
            text: "Heading",
            level: 1,
            sentences: [],
        };
        expectFixtureError(f, /items\[0\]\.sentences: forbidden/);
    });

    it("rejects text on table and picture items", () => {
        const f = fixture();
        f.expected.structured.pages[0].items[0] = {
            id: "table1",
            kind: "table",
            pageIndex: 0,
            order: 0,
            bbox: [1, 2, 3, 4],
            text: "not allowed",
        };
        expectFixtureError(f, /items\[0\]\.text: forbidden for table/);
    });

    it("requires numeric section-header level", () => {
        const missing = fixture();
        missing.expected.structured.pages[0].items[0] = {
            id: "heading1",
            kind: "section_header",
            pageIndex: 0,
            order: 0,
            bbox: [1, 2, 3, 4],
            text: "Heading",
        };
        expectFixtureError(missing, /items\[0\]\.level: expected finite number/);

        const nonNumeric = fixture();
        nonNumeric.expected.structured.pages[0].items[0] = {
            ...missing.expected.structured.pages[0].items[0],
            level: "1",
        };
        expectFixtureError(nonNumeric, /items\[0\]\.level: expected finite number/);
    });

    it("rejects explicit joinWithNext false", () => {
        const f = fixture();
        f.expected.structured.pages[0].items[0].sentences[0].joinWithNext = false;
        expectFixtureError(f, /joinWithNext: expected omitted or true/);
    });
});
