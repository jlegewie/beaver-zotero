import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { projectTracePage } from "../../src/beaver-extract/debug/traceProjection";
import { extractPdf, structuredExtractWithDebug } from "../../src/beaver-extract/node/api";
import { sharedPdfPath } from "../../src/beaver-extract/cli/fixture/fixtureFile";
import { post } from "../helpers/zoteroHttpClient";
import { isZoteroAvailable, skipIfNoZotero } from "../helpers/zoteroAvailability";

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe("pdf-extract-trace parity (live)", () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it("matches the full-document structured result for the requested page", async () => {
        const root = join(process.cwd(), "tests/fixtures/pdfs/extract-public");
        const fixture = JSON.parse(
            readFileSync(join(root, "legewie-fagan__p0/fixture.json"), "utf8"),
        );
        const pdf = new Uint8Array(readFileSync(sharedPdfPath(root, fixture.pdfSha256)));
        const pageIndex = fixture.config.pageIndices[0];
        const local = await extractPdf({
            pdfData: pdf,
            mode: "structured",
            structured: { splitterConfig: fixture.config.splitterConfig },
        });
        if (local.mode !== "structured") throw new Error("expected structured result");
        const live = await post<any>("/beaver/test/pdf-extract-trace", {
            raw_bytes_base64: Buffer.from(pdf).toString("base64"),
            page_index: pageIndex,
            mode: "full",
            options: { splitter: fixture.config.splitterConfig },
        }, { timeout: 60000 });

        expect(live.ok).toBe(true);
        expect(live.result.document.pages.find((p: any) => p.index === pageIndex)).toEqual(
            local.document.pages.find((p) => p.index === pageIndex),
        );

        const debug = await structuredExtractWithDebug({
            pdfData: pdf,
            capturePages: [pageIndex],
            debugMode: "full",
            structured: { splitterConfig: fixture.config.splitterConfig },
        });
        const projected = projectTracePage(debug.result, debug.debug, pageIndex, "full");
        expect(live.page.counts).toEqual(projected.page.counts);
    });
});
