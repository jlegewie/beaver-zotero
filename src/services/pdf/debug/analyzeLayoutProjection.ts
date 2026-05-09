/**
 * Wire-shape projection for `LayoutAnalysisResult`.
 *
 * `LayoutAnalysisResult.analysis` carries `Map`s and `Set`s that
 * `JSON.stringify` would silently flatten to `{}`. This module flattens
 * them to plain objects/arrays for both the `/beaver/test/pdf-analyze-layout`
 * HTTP handler and the `beaver-extract analyze-layout` CLI command.
 *
 * No DOM, no fs, no Node-only imports — safe to consume from React or
 * Node code paths.
 */
import type { LayoutAnalysisResult } from "../types";

export interface AnalyzeLayoutWire {
    page_count: number;
    analysis_page_indices: number[];
    pages: LayoutAnalysisResult["pages"];
    page_labels?: LayoutAnalysisResult["pageLabels"];
    analysis: {
        style_profile: {
            primaryBodyStyle: LayoutAnalysisResult["analysis"]["styleProfile"]["primaryBodyStyle"];
            bodyStyles: LayoutAnalysisResult["analysis"]["styleProfile"]["bodyStyles"];
            styleCounts: Record<string, { count: number; style: unknown }>;
        };
        margin_analysis: {
            elements: Record<string, unknown[]>;
            counts: LayoutAnalysisResult["analysis"]["marginAnalysis"]["counts"];
        };
        margin_removal: {
            candidates: LayoutAnalysisResult["analysis"]["marginRemoval"]["candidates"];
            removalsByPage: Record<string, string[]>;
            textsToRemove: string[];
        };
    };
    metadata: LayoutAnalysisResult["metadata"];
}

export function projectAnalyzeLayout(
    result: LayoutAnalysisResult,
): AnalyzeLayoutWire {
    const styleCounts: Record<string, { count: number; style: unknown }> = {};
    for (const [key, value] of result.analysis.styleProfile.styleCounts) {
        styleCounts[key] = value;
    }
    const elements: Record<string, unknown[]> = {};
    for (const [pos, list] of result.analysis.marginAnalysis.elements) {
        elements[pos] = list;
    }
    const removalsByPage: Record<string, string[]> = {};
    for (const [pageIdx, texts] of result.analysis.marginRemoval.removalsByPage) {
        removalsByPage[String(pageIdx)] = Array.from(texts);
    }
    const textsToRemove = Array.from(result.analysis.marginRemoval.textsToRemove);

    return {
        page_count: result.pageCount,
        analysis_page_indices: result.analysisPageIndices,
        pages: result.pages,
        page_labels: result.pageLabels,
        analysis: {
            style_profile: {
                primaryBodyStyle: result.analysis.styleProfile.primaryBodyStyle,
                bodyStyles: result.analysis.styleProfile.bodyStyles,
                styleCounts,
            },
            margin_analysis: {
                elements,
                counts: result.analysis.marginAnalysis.counts,
            },
            margin_removal: {
                candidates: result.analysis.marginRemoval.candidates,
                removalsByPage,
                textsToRemove,
            },
        },
        metadata: result.metadata,
    };
}
