import type {
    DebugLine,
    DebugSentence,
    ExtractionDebug,
    PageDebugData,
    StructuredExtractResult,
} from "../schema";

export type TraceVerbosity = "triage" | "full";

export interface TraceProjection {
    mode: TraceVerbosity;
    page_index: number;
    page_width: number;
    page_height: number;
    raw_lines: DebugLine[];
    smart_removal: {
        candidates: unknown[];
    };
    style_profile?: unknown;
    columns: NonNullable<PageDebugData["columns"]>;
    lines_dropped_by_columns: string[];
    paragraphs: NonNullable<PageDebugData["items"]>;
    sentences: DebugSentence[];
    sentence_stats: {
        count: number;
        degraded: number;
        fragments: number;
    };
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
    const fullProjection = buildProjection(mode, page, result);
    if (mode === "full") return fullProjection;
    const {
        columns,
        lines,
        sentenceFragments,
        styleProfile,
        marginDecisions,
        ...triagePage
    } = page;
    return {
        ...fullProjection,
        raw_lines: [],
        style_profile: undefined,
        columns: [],
        page: triagePage,
    };
}

function buildProjection(
    mode: TraceVerbosity,
    page: PageDebugData,
    result: StructuredExtractResult,
): TraceProjection {
    const sentences = page.sentences ?? [];
    return {
        mode,
        page_index: page.pageIndex,
        page_width: page.width,
        page_height: page.height,
        raw_lines: page.lines ?? [],
        smart_removal: {
            candidates: page.marginCandidates ?? [],
        },
        style_profile: page.styleProfile,
        columns: page.columns ?? [],
        lines_dropped_by_columns: page.droppedLineIds ?? [],
        paragraphs: page.items ?? [],
        sentences,
        sentence_stats: {
            count: sentences.length,
            degraded: page.degradation?.count ?? 0,
            fragments: page.sentenceFragments?.length ?? 0,
        },
        page,
        result,
    };
}
