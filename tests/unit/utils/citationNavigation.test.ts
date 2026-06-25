import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoordOrigin, type BoundingBox } from '../../../react/types/citations';
import { flashHighlightBoundingBoxes } from '../../../react/utils/citationNavigation';

vi.mock('../../../react/utils/pdfUtils', () => ({
    getPageViewportInfo: vi.fn(async () => ({
        viewBox: [0, 0, 400, 600],
        rotation: 0,
        width: 400,
        height: 600,
    })),
}));

function box(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, coord_origin: CoordOrigin.TOPLEFT };
}

describe('flashHighlightBoundingBoxes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('aggregates all cited rects on the target page before navigating', async () => {
        const navigate = vi.fn();
        const reader = { _internalReader: {}, navigate };

        const navigated = await flashHighlightBoundingBoxes(reader as any, [
            { pageIndex: 0, boxes: [box(10, 20, 110, 50)] },
            { pageIndex: 0, boxes: [box(20, 60, 120, 80)] },
            { pageIndex: 1, boxes: [box(30, 40, 130, 70)] },
        ]);

        expect(navigated).toBe(true);
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledWith({
            position: {
                pageIndex: 0,
                rects: [
                    [10, 550, 110, 580],
                    [20, 520, 120, 540],
                ],
                nextPageRects: [
                    [30, 530, 130, 560],
                ],
            },
        });
    });

    it('returns false when navigation throws', async () => {
        const reader = {
            _internalReader: {},
            navigate: vi.fn(() => {
                throw new Error('navigation failed');
            }),
        };

        await expect(
            flashHighlightBoundingBoxes(reader as any, [
                { pageIndex: 0, boxes: [box(10, 20, 110, 50)] },
            ]),
        ).resolves.toBe(false);
    });
});
