// @vitest-environment jsdom

/**
 * A remembered place in a thread is taken from one layout and put back in
 * another: the library and reader sidebars show the same thread at different
 * widths, so the same text wraps to different heights in each.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { captureScrollAnchor, resolveScrollAnchor } from '../../../react/utils/scrollAnchor';

interface Box { top: number; height: number }

/** Fake the layout jsdom does not compute. Boxes are in viewport coordinates. */
function setBox(el: Element, box: Box) {
    el.getBoundingClientRect = () => ({
        top: box.top, bottom: box.top + box.height, height: box.height,
        left: 0, right: 0, width: 0, x: 0, y: box.top, toJSON: () => ({}),
    }) as DOMRect;
}

function setScroll(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: {
    scrollTop: number; scrollHeight: number; clientHeight: number;
}) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

let container: HTMLDivElement;

/**
 * The thread's shape: a scrolling container whose first child holds one element
 * per run. Each run holds a user request and a response.
 */
function buildThread() {
    document.body.innerHTML = `
        <div id="beaver-thread-view">
            <div class="content">
                <div id="run-a"><div id="user-request-a"></div><div id="response-a"></div></div>
                <div id="run-b"><div id="user-request-b"></div><div id="response-b"><div id=":r1:"></div></div></div>
            </div>
        </div>`;
    container = document.getElementById('beaver-thread-view') as HTMLDivElement;
}

const byId = (id: string) => document.getElementById(id)!;

/**
 * Lay the thread out with its top `scrollTop` pixels scrolled away, given each
 * element's height. Runs are separated by a 16px gap, like the real column.
 */
function layOut(scrollTop: number, heights: Record<string, number>) {
    setBox(container, { top: 0, height: 500 });
    let y = -scrollTop;
    for (const run of ['a', 'b']) {
        const request = heights[`user-request-${run}`];
        const response = heights[`response-${run}`];
        setBox(byId(`run-${run}`), { top: y, height: request + response });
        setBox(byId(`user-request-${run}`), { top: y, height: request });
        setBox(byId(`response-${run}`), { top: y + request, height: response });
        y += request + response + 16;
    }
    setScroll(container, { scrollTop, scrollHeight: y + scrollTop - 16, clientHeight: 500 });
}

const NARROW = { 'user-request-a': 100, 'response-a': 1000, 'user-request-b': 100, 'response-b': 2000 };
const WIDE = { 'user-request-a': 60, 'response-a': 500, 'user-request-b': 60, 'response-b': 1000 };

beforeEach(buildThread);

describe('captureScrollAnchor', () => {
    it('records the run and the part of it at the top of the viewport, outermost first', () => {
        // Run b starts at 1116; its response at 1216. Scrolled to 1716, the
        // viewport top is 500px into a 2000px response.
        layOut(1716, NARROW);

        const anchor = captureScrollAnchor(container)!;

        expect(anchor.scrollTop).toBe(1716);
        expect(anchor.levels.map((l) => l.id)).toEqual(['run-b', 'response-b']);
        expect(anchor.levels[1].fraction).toBeCloseTo(0.25);
    });

    it('never anchors to an id React generates per mount', () => {
        layOut(1716, NARROW);
        setBox(byId(':r1:'), { top: -10, height: 100 });

        const ids = captureScrollAnchor(container)!.levels.map((l) => l.id);

        expect(ids).not.toContain(':r1:');
    });

    it('anchors to the run below when the viewport top falls in the gap between two runs', () => {
        // Run a ends at 1100; run b starts at 1116.
        layOut(1108, NARROW);

        const anchor = captureScrollAnchor(container)!;

        expect(anchor.levels.map((l) => l.id)).toEqual(['run-b']);
        expect(anchor.levels[0].fraction).toBeLessThan(0);
    });

    it('keeps only the raw offset when nothing anchorable is at the top', () => {
        document.body.innerHTML = '<div id="beaver-thread-view"><div class="content"><p></p></div></div>';
        container = document.getElementById('beaver-thread-view') as HTMLDivElement;
        setBox(container, { top: 0, height: 500 });
        setBox(container.querySelector('p')!, { top: -300, height: 2000 });
        setScroll(container, { scrollTop: 300, scrollHeight: 2000, clientHeight: 500 });

        expect(captureScrollAnchor(container)).toEqual({ levels: [], scrollTop: 300 });
    });

    it('records nothing for a container that is not displayed', () => {
        layOut(0, NARROW);
        setScroll(container, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

        expect(captureScrollAnchor(container)).toBeNull();
    });
});

describe('resolveScrollAnchor', () => {
    it('puts the reader back at the same place in the text at another width', () => {
        layOut(1716, NARROW);
        const anchor = captureScrollAnchor(container)!;

        // Wider pane: everything is half as tall. Run b now starts at 576 and
        // its response at 636; a quarter of the 1000px response is 250px in.
        layOut(0, WIDE);

        expect(resolveScrollAnchor(container, anchor)).toBe(886);
    });

    it('lands on the same place when the layout is unchanged', () => {
        layOut(1716, NARROW);
        const anchor = captureScrollAnchor(container)!;

        layOut(0, NARROW);

        expect(resolveScrollAnchor(container, anchor)).toBe(1716);
    });

    it('falls back to the enclosing run when the inner element no longer renders', () => {
        layOut(1716, NARROW);
        const anchor = captureScrollAnchor(container)!;

        layOut(0, NARROW);
        byId('response-b').remove();

        // Run b starts at 1116 and the reader was 600px into it.
        expect(resolveScrollAnchor(container, anchor)).toBeCloseTo(1716);
    });

    it('falls back to the raw offset when none of the elements is rendered, within the scrollable range', () => {
        const anchor = { levels: [{ id: 'run-gone', fraction: 0.5 }], scrollTop: 5000 };
        layOut(0, NARROW);

        // scrollHeight 3216, clientHeight 500.
        expect(resolveScrollAnchor(container, anchor)).toBe(2716);
    });
});
