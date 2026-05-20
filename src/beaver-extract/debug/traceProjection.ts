import type {
    ExtractionDebug,
    PageDebugData,
    StructuredExtractResult,
} from "../schema";

export type TraceVerbosity = "triage" | "full";

export interface TraceProjection {
    mode: TraceVerbosity;
    page: PageDebugData;
    result: StructuredExtractResult;
}

/** Project full-document structured debug data down to one requested page. */
export function projectTracePage(
    result: StructuredExtractResult,
    debug: ExtractionDebug,
    pageIndex: number,
    mode: TraceVerbosity = "triage",
): TraceProjection {
    const page = debug.pages?.[String(pageIndex)];
    if (!page) {
        throw new Error(`trace: page ${pageIndex} missing from debug projection`);
    }
    if (mode === "full") {
        return { mode, page, result };
    }
    const {
        columns,
        lines,
        sentenceFragments,
        styleProfile,
        marginDecisions,
        ...triagePage
    } = page;
    return { mode, page: triagePage, result };
}
