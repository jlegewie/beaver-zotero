import type { StructuredExtractResult, StructuredPage } from '@beaver/agent-core/extract/schema';

export interface CitablePageSpec {
    index: number;
    label?: string;
    /** Citable items on the page, each with optional sentence ids. */
    items: Array<{ id: string; sentences?: string[] }>;
}

/**
 * Structured PDF extraction result whose pages hold the given citable ids,
 * so the derived citation index resolves each id to its page and label.
 * Pages not listed are empty.
 */
export function structuredResultWithCitablePages(
    pageCount: number,
    specs: CitablePageSpec[],
): StructuredExtractResult {
    const byIndex = new Map(specs.map(spec => [spec.index, spec]));
    const pages: StructuredPage[] = Array.from({ length: pageCount }, (_, index) => {
        const spec = byIndex.get(index);
        return {
            index,
            ...(spec?.label ? { label: spec.label } : {}),
            width: 612,
            height: 792,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            items: (spec?.items ?? []).map((item, order) => ({
                id: item.id,
                kind: 'text' as const,
                pageIndex: index,
                order,
                bbox: [0, 0, 10, 10],
                text: '',
                sentences: (item.sentences ?? []).map((id, sentenceOrder) => ({
                    id,
                    order: sentenceOrder,
                    text: '',
                    bboxes: [[0, 0, 10, 10]],
                })),
            })),
        } as StructuredPage;
    });
    return {
        mode: 'structured',
        schemaVersion: '4',
        document: {
            pageCount,
            bboxOrigin: 'top-left',
            bboxPrecision: 1,
            pages,
        },
    };
}
