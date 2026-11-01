import { describe, expect, it } from 'vitest';
import type { PageDebugData } from '@beaver/agent-core/extract/schema';
import {
    buildColumnViewPage,
    buildLineViewPage,
} from '../../../src/modules/agentPageView/stageViewModel';

function page(overrides: Partial<PageDebugData>): PageDebugData {
    return {
        pageIndex: 2,
        width: 600,
        height: 800,
        counts: { items: 0, sentences: 0 },
        ...overrides,
    };
}

const lines: PageDebugData['lines'] = [
    { text: 'Left one', bbox: [10, 10, 290, 20], columnIndex: 0 },
    { text: 'Left two', bbox: [10, 22, 290, 32], columnIndex: 0 },
    { text: 'Right one', bbox: [310, 10, 590, 20], columnIndex: 1 },
];

describe('buildColumnViewPage', () => {
    it('draws each column with the text of its lines on hover', () => {
        const view = buildColumnViewPage(page({
            columns: [[10, 10, 290, 790], [310, 10, 590, 790]],
            lines,
        }));

        expect(view.pageIndex).toBe(2);
        expect(view.boxes.map((box) => [box.kind, box.id, box.title, box.text])).toEqual([
            ['column', 'C1', 'Column C1 · 2 lines', 'Left one\nLeft two'],
            ['column', 'C2', 'Column C2 · 1 lines', 'Right one'],
        ]);
    });

    it('draws nothing for a page without detected columns', () => {
        expect(buildColumnViewPage(page({})).boxes).toEqual([]);
    });
});

describe('buildLineViewPage', () => {
    it('draws lines in reading order with alternating shades', () => {
        const view = buildLineViewPage(page({ lines }));

        expect(view.boxes.map((box) => [box.id, box.shade, box.title, box.text])).toEqual([
            ['L1', 0, 'Line L1 · column C1', 'Left one'],
            ['L2', 1, 'Line L2 · column C1', 'Left two'],
            ['L3', 0, 'Line L3 · column C2', 'Right one'],
        ]);
        expect(view.boxes[2].rects).toEqual([[310, 10, 590, 20]]);
    });
});
