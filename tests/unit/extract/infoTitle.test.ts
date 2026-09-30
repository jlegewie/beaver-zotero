import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { readFixture, readSharedPdf } from "../../../src/beaver-extract/cli/fixture/fixtureFile";
import { extractPdf, getMetadata } from "../../../src/beaver-extract/node/api";
import { computeStructuredDocumentHash } from "../../../src/services/documentExtraction/structuredDocumentHash";
import { toBackendDocumentPayload } from "../../../src/services/documentExtraction/backendDocumentPayload";

describe("PDF Info title on structured extraction", () => {
    it("comes with the extraction and stays out of index identity and the backend payload", async () => {
        const fixtureRoot = join(process.cwd(), "tests/fixtures/pdfs/extract-public");
        const pdfData = readSharedPdf(fixtureRoot, readFixture(fixtureRoot, "legewie-fagan__p0").pdfSha256);

        const structured = await extractPdf({ pdfData, mode: "structured" });
        if (structured.mode !== "structured") throw new Error("expected structured result");
        expect(structured.infoTitle).toBe("Aggressive Policing and the Educational Performance of Minority Youth");
        expect(structured.infoTitle).toBe((await getMetadata(pdfData)).title?.trim());

        const { infoTitle: _infoTitle, ...withoutTitle } = { ...structured, infoTitle: "Any title" };
        expect(await computeStructuredDocumentHash("pdf", { ...withoutTitle, infoTitle: "Any title" } as any))
            .toBe(await computeStructuredDocumentHash("pdf", withoutTitle as any));
        expect("infoTitle" in toBackendDocumentPayload({ ...structured, infoTitle: "Any title" })).toBe(false);
    });
});
