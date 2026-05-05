/**
 * Sentence-extraction regression-test fixtures.
 *
 * Captures the current sentence-mapper output for the active reader page
 * and writes a fixture folder under the dev-fixture root (controlled by
 * the `extensions.beaver.devFixtureRoot` Zotero pref). The pref must
 * point at the developer's `tests/fixtures/pdfs/sentences/` directory.
 *
 * Mirrors `visualizeCurrentPageSentences` in `extractionVisualizer.ts`
 * exactly so the captured `expected` matches what the visualizer / live
 * pipeline produce.
 *
 * Dev-only: callers gate behind `process.env.NODE_ENV === 'development'`.
 */

import {
    detectFilteredParagraphs,
    extractPageSentenceBBoxes,
    getMuPDFWorkerClient,
    getSentenceSplitterWithFallback,
    normalizeLanguageCode,
    PageSentenceBBoxResult,
    RawBBox,
    resolveAnalysisPageIndices,
    SentenceBBox,
    SentenceRange,
    SentenceSplitter,
} from "../../src/services/pdf";
import { getItemLanguage } from "../../src/utils/zoteroUtils";
import { logger } from "../../src/utils/logger";
import { resolveActiveReaderContext } from "./extractionVisualizer";
import { pagesForFilter } from "./extractionOverlay";

const FIXTURE_ROOT_PREF = "extensions.beaver.devFixtureRoot";
const DEFAULT_BBOX_TOL_PT = 0.5;

interface FixtureSentenceExpected {
    index: number;
    paragraphIndex: number;
    kind: "text" | "heading";
    text: string;
    bboxes: Array<{ x: number; y: number; w: number; h: number }>;
}

interface FixtureExpected {
    paragraphCount: number;
    stats: {
        degradedParagraphs: number;
        unmappedParagraphs: number;
    };
    sentences: FixtureSentenceExpected[];
}

interface FixtureSourceMeta {
    libraryID: number;
    itemKey: string;
    title: string;
    pageIndex: number;
    pageLabel: string | null;
    language: string | null;
    splitterId: string;
    pdfSha256: string;
    pdfBytes: number;
    pageWidth: number;
    pageHeight: number;
}

interface FixtureFile {
    schema: 1;
    createdAt: string;
    source: FixtureSourceMeta;
    extractor: {
        gitSha: string | null;
        marginsPreset: "default";
    };
    artifacts: {
        sharedPdfSha: string;
        pagePng: string;
        rawExtraction: string;
    };
    tolerance: { bboxAbsPt: number };
    expected: FixtureExpected;
}

export interface CreateSentenceFixtureResult {
    ok: boolean;
    message: string;
    folder?: string;
}

/**
 * Capture (or recapture) a sentence-extraction fixture for the active
 * reader page. Always overwrites any existing fixture for the same
 * (libraryID, key, pageIndex).
 */
export async function createSentenceFixture(): Promise<CreateSentenceFixtureResult> {
    try {
        const fixtureRoot = readFixtureRootPref();
        if (!fixtureRoot) {
            return {
                ok: false,
                message:
                    `Set the pref "${FIXTURE_ROOT_PREF}" to your ` +
                    `tests/fixtures/pdfs/sentences/ directory and try again.`,
            };
        }

        const ctx = await resolveActiveReaderContext();
        if ("error" in ctx) return { ok: false, message: ctx.error };
        const { reader, item, filePath, pageIndex } = ctx;

        const folderName = `${item.libraryID}__${item.key}__p${pageIndex}`;
        const folderPath = PathUtils.join(fixtureRoot, folderName);
        const sharedDir = PathUtils.join(fixtureRoot, "_shared");
        const fixtureJsonPath = PathUtils.join(folderPath, "fixture.json");
        const isUpdate = await IOUtils.exists(fixtureJsonPath);

        logger(
            `[SentenceFixture] ${isUpdate ? "Updating" : "Capturing"} ${folderName}…`,
        );

        const pdfData = await IOUtils.read(filePath);
        const pdfSha256 = await sha256Hex(pdfData);

        const client = getMuPDFWorkerClient();
        const { count: pageCount, labels: pageLabels } =
            await client.getPageCountAndLabels(pdfData);
        const pageLabel = pageLabels[pageIndex] ?? null;

        const analysisIndices = resolveAnalysisPageIndices(pageIndex, pageCount);
        const rawDoc = await client.extractRawPages(pdfData, analysisIndices);
        const detailedPage = await client.extractRawPageDetailed(
            pdfData,
            pageIndex,
        );
        const rawPage = rawDoc.pages.find((p) => p.pageIndex === pageIndex);
        if (!rawPage) {
            return {
                ok: false,
                message: `Page ${pageIndex + 1} not in analysis window`,
            };
        }

        let language: string | undefined;
        try {
            const raw = await getItemLanguage(item.libraryID, item.key);
            if (raw) language = raw;
        } catch {
            // Best effort; splitter falls back to "en".
        }
        const normalizedLang = normalizeLanguageCode(language);
        const realSplitter = await getSentenceSplitterWithFallback(normalizedLang);

        // Wrap the splitter so we can persist its (text → ranges) outputs
        // for hermetic unit-tier replay (sentencex needs chrome:// URLs
        // that don't resolve in node Vitest).
        const splitterRecording: Array<{ text: string; ranges: SentenceRange[] }> = [];
        const recordingSplitter: SentenceSplitter = (text: string) => {
            const ranges = realSplitter(text);
            splitterRecording.push({ text, ranges });
            return ranges;
        };

        // Mirror `getSentenceOverlay` exactly so captured output matches
        // what the visualizer renders.
        const filtered = detectFilteredParagraphs({
            pages: pagesForFilter(rawDoc.pages, pageIndex, detailedPage),
            pageIndex,
        });
        const result = extractPageSentenceBBoxes(detailedPage, {
            splitter: recordingSplitter,
            precomputed: { paragraphResult: filtered.paragraphResult },
        });

        const expected = buildExpectedFromResult(result);

        // Render preview PNG.
        const pageImage = await client.renderPageToImage(pdfData, pageIndex, {
            scale: 1.5,
            format: "png",
        });

        // Ensure folders.
        await IOUtils.makeDirectory(folderPath, {
            createAncestors: true,
            ignoreExisting: true,
        });
        await IOUtils.makeDirectory(sharedDir, {
            createAncestors: true,
            ignoreExisting: true,
        });

        // Write shared PDF (skip if already there — sha-keyed dedup).
        const sharedPdfPath = PathUtils.join(sharedDir, `${pdfSha256}.pdf`);
        if (!(await IOUtils.exists(sharedPdfPath))) {
            await IOUtils.write(sharedPdfPath, pdfData);
        }

        // Write page PNG.
        await IOUtils.write(
            PathUtils.join(folderPath, "page.png"),
            pageImage.data,
        );

        // Write raw-extraction.json (hermetic input for unit tests).
        await IOUtils.writeJSON(
            PathUtils.join(folderPath, "raw-extraction.json"),
            {
                rawPages: rawDoc.pages,
                detailedPage,
                pageIndex,
                language: language ?? null,
                splitterLanguage: normalizedLang,
                splitterRecording,
            },
        );

        // Build fixture.json.
        const fixture: FixtureFile = {
            schema: 1,
            createdAt: new Date().toISOString(),
            source: {
                libraryID: item.libraryID,
                itemKey: item.key,
                title: item.getDisplayTitle?.() ?? "",
                pageIndex,
                pageLabel,
                language: language ?? null,
                splitterId: normalizedLang,
                pdfSha256,
                pdfBytes: pdfData.byteLength,
                pageWidth: rawPage.width,
                pageHeight: rawPage.height,
            },
            extractor: {
                gitSha: null,
                marginsPreset: "default",
            },
            artifacts: {
                sharedPdfSha: pdfSha256,
                pagePng: "page.png",
                rawExtraction: "raw-extraction.json",
            },
            tolerance: { bboxAbsPt: DEFAULT_BBOX_TOL_PT },
            expected,
        };

        await writeFixtureJsonAtomic(fixtureJsonPath, fixture);

        const verb = isUpdate ? "Updated" : "Created";
        const msg =
            `${verb} fixture ${folderName} ` +
            `(${expected.sentences.length} sentences in ` +
            `${expected.paragraphCount} paragraphs)`;
        logger(`[SentenceFixture] ${msg}`);
        return { ok: true, message: msg, folder: folderPath };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger(`[SentenceFixture] Capture failed: ${msg}`, 1);
        return { ok: false, message: `Capture failed: ${msg}` };
    }
}

function readFixtureRootPref(): string | null {
    try {
        const value = Zotero.Prefs.get(FIXTURE_ROOT_PREF, true);
        if (typeof value === "string" && value.length > 0) return value;
    } catch {
        // Pref not set yet.
    }
    return null;
}

function buildExpectedFromResult(
    result: PageSentenceBBoxResult,
): FixtureExpected {
    // Map each flat sentence index to its paragraph index by walking
    // paragraphs and consuming sentences in lockstep — same shape the
    // mapper uses for `result.sentences`.
    const paragraphIndexBySentence: number[] = [];
    let cursor = 0;
    result.paragraphs.forEach((pws, pIdx) => {
        for (let i = 0; i < pws.sentences.length; i++) {
            paragraphIndexBySentence[cursor++] = pIdx;
        }
    });

    const sentences: FixtureSentenceExpected[] = result.sentences.map(
        (s: SentenceBBox, idx) => ({
            index: idx,
            paragraphIndex: paragraphIndexBySentence[idx] ?? -1,
            kind: s.kind ?? "text",
            text: s.text,
            bboxes: s.bboxes.map(roundBBox),
        }),
    );

    return {
        paragraphCount: result.paragraphs.length,
        stats: {
            degradedParagraphs: result.degradedParagraphs,
            unmappedParagraphs: result.unmappedParagraphs,
        },
        sentences,
    };
}

function roundBBox(b: RawBBox): { x: number; y: number; w: number; h: number } {
    return {
        x: round3(b.x),
        y: round3(b.y),
        w: round3(b.w),
        h: round3(b.h),
    };
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    // Copy into a fresh ArrayBuffer-backed view; `IOUtils.read` returns a
    // `Uint8Array<SharedArrayBuffer | ArrayBuffer>` union which is wider
    // than `BufferSource`'s `ArrayBuffer`-only constraint.
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const arr = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < arr.length; i++) {
        out += arr[i].toString(16).padStart(2, "0");
    }
    return out;
}

async function writeFixtureJsonAtomic(
    targetPath: string,
    fixture: FixtureFile,
): Promise<void> {
    const tmp = `${targetPath}.tmp`;
    await IOUtils.writeJSON(tmp, fixture);
    await IOUtils.move(tmp, targetPath, { noOverwrite: false });
}
