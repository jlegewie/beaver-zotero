import { describe, expect, it } from 'vitest';
import type { DocumentItem, StructuredPage } from '@beaver/agent-core/extract/schema';
import {
    buildAgentViewPage,
    totalAgentViewCounts,
} from '../../../src/modules/agentPageView/agentPageViewModel';

function page(items: DocumentItem[]): StructuredPage {
    return {
        index: 3,
        label: '12',
        width: 600,
        height: 800,
        viewBox: [0, 0, 600, 800],
        rotation: 0,
        items,
    };
}

const base = { pageIndex: 3, bbox: [10, 10, 590, 100] as [number, number, number, number] };

describe('buildAgentViewPage', () => {
    it('shows prose as its sentences, not as the paragraph', () => {
        const view = buildAgentViewPage(page([
            {
                ...base,
                id: 'p4.1',
                kind: 'text',
                order: 0,
                text: 'One. Two.',
                sentences: [
                    { id: 's4.2', order: 1, text: 'Two.', bboxes: [[50, 10, 90, 20]] },
                    { id: 's4.1', order: 0, text: 'One.', bboxes: [[10, 10, 40, 20]] },
                ],
            },
        ]));

        expect(view.boxes.map((box) => [box.kind, box.id, box.shade])).toEqual([
            ['sentence', 's4.1', 0],
            ['sentence', 's4.2', 1],
        ]);
        expect(view.boxes[0].text).toBe('<s4.1>One.</s4.1>');
        expect(view.counts.sentences).toBe(2);
    });

    it('shows a table as a region whose rows are citable sentences', () => {
        const view = buildAgentViewPage(page([
            {
                ...base,
                id: 'table4.1',
                kind: 'table',
                order: 0,
                text: 'a | b\n1 | <2',
                sentences: [
                    { id: 's4.1', order: 0, text: 'a | b', bboxes: [[10, 10, 50, 20], [60, 10, 90, 20]] },
                    { id: 's4.2', order: 1, text: '1 | <2', bboxes: [[10, 30, 50, 40]] },
                ],
            },
        ]));

        expect(view.boxes.map((box) => [box.kind, box.id])).toEqual([
            ['table', 'table4.1'],
            ['table_row', 's4.1'],
            ['table_row', 's4.2'],
        ]);
        expect(view.boxes[0].text).toBe(
            '<table4.1>\n  <s4.1>a | b</s4.1>\n  <s4.2>1 | &lt;2</s4.2>\n</table4.1>',
        );
        expect(view.boxes[1].rects).toHaveLength(2);
        expect(view.counts).toMatchObject({ tables: 1, tableRows: 2, sentences: 0 });
    });

    it('shows figures, equations and unsplit items as one tagged element', () => {
        const view = buildAgentViewPage(page([
            { ...base, id: 'heading4.1', kind: 'section_header', order: 0, text: 'Results', level: 1 },
            { ...base, id: 'fig4.1', kind: 'picture', order: 1, text: 'Wage\nYear' },
            { ...base, id: 'fig4.2', kind: 'picture', order: 2 },
            { ...base, id: 'eq4.1', kind: 'formula', order: 3, text: 'y = x (1)' },
            { ...base, id: 'table4.1', kind: 'table', order: 4, text: '' },
        ]));

        expect(view.boxes.map((box) => [box.kind, box.id, box.text])).toEqual([
            ['item', 'heading4.1', '<heading4.1>Results</heading4.1>'],
            ['figure', 'fig4.1', '<fig4.1>Wage\nYear</fig4.1>'],
            ['figure', 'fig4.2', '<fig4.2></fig4.2>'],
            ['equation', 'eq4.1', '<eq4.1>y = x (1)</eq4.1>'],
            ['table', 'table4.1', '<table4.1></table4.1>'],
        ]);
        expect(view.counts).toMatchObject({ items: 1, figures: 2, equations: 1, tables: 1 });
    });

    it('leaves out margin items, which never reach the model', () => {
        const view = buildAgentViewPage(page([
            { ...base, id: 'margin4.1', kind: 'margin', order: 0, text: 'Journal of X' },
            { ...base, id: 'p4.1', kind: 'text', order: 1, text: 'Unsplit.' },
        ]));

        expect(view.boxes.map((box) => box.id)).toEqual(['p4.1']);
    });

    it('counts citable sentences without geometry instead of drawing them', () => {
        const view = buildAgentViewPage(page([
            {
                ...base,
                id: 'p4.1',
                kind: 'text',
                order: 0,
                text: 'One.',
                sentences: [{ id: 's4.1', order: 0, text: 'One.', bboxes: [] }],
            },
        ]));

        expect(view.boxes).toEqual([]);
        expect(view.counts.unlocatedSentences).toBe(1);
        expect(totalAgentViewCounts([view, view]).unlocatedSentences).toBe(2);
    });
});
