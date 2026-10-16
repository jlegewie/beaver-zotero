/**
 * Randomized checks of `citationPageLocator` against the rule in its doc
 * comment, over label maps that mix numberings, gaps and label styles.
 */
import { describe, expect, it } from 'vitest';

import { labelsBreakNumbering } from '@beaver/agent-core/extract/pageLabels/printedPageLabels';
import { citationPageLocator } from '../../../src/utils/pageLabelTranslation';

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];

/** A label map of `pageCount` pages built from random runs of label styles and gaps. */
function randomLabels(random: () => number, pageCount: number): Record<number, string> {
    const labels: Record<number, string> = {};
    let page = 0;
    while (page < pageCount) {
        const length = 1 + Math.floor(random() * 8);
        const style = Math.floor(random() * 6);
        const offset = Math.floor(random() * 900);
        for (let i = 0; i < length && page < pageCount; i++, page++) {
            switch (style) {
                case 0: labels[page] = String(offset + i + 1); break;
                case 1: labels[page] = `S${offset + i + 1}`; break;
                case 2: labels[page] = ROMAN[i % ROMAN.length]; break;
                case 3: labels[page] = String.fromCharCode(65 + (i % 26)); break;
                case 4: labels[page] = `α${'β'.repeat(i)}`; break; // unrecognized style
                default: break; // unlabelled pages
            }
        }
    }
    return labels;
}

/** A random citation: a page, a range or a list of those, within or just past the document. */
function randomPages(random: () => number, pageCount: number): string {
    const part = (): string => {
        const a = 1 + Math.floor(random() * (pageCount + 3));
        if (random() < 0.5) return String(a);
        const b = 1 + Math.floor(random() * (pageCount + 3));
        return `${a}-${b}`;
    };
    const count = 1 + Math.floor(random() * 3);
    return Array.from({ length: count }, part).join(', ');
}

/** 1-based pages within one input part ("4" or "2-7") that carry a label. */
function labelledPagesIn(labels: Record<number, string>, part: string): number[] {
    const [a, b = a] = part.split('-').map((n) => Number(n.trim()));
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    return Object.keys(labels).map(Number).map((index) => index + 1)
        .filter((page) => page >= start && page <= end)
        .sort((x, y) => x - y);
}

/** Whether an output part names one run of `pages` without a change of numbering. */
function isOneRunOf(labels: Record<number, string>, pages: number[], output: string): boolean {
    const labelOf = (page: number) => labels[page - 1];
    for (let i = 0; i < pages.length; i++) {
        for (let j = i; j < pages.length; j++) {
            const expected = i === j || labelOf(pages[i]) === labelOf(pages[j])
                ? labelOf(pages[i])
                : `${labelOf(pages[i])}-${labelOf(pages[j])}`;
            if (expected !== output) continue;
            let unbroken = true;
            for (let k = i; k < j; k++) {
                if (labelsBreakNumbering(labelOf(pages[k]), labelOf(pages[k + 1]), pages[k + 1] - pages[k])) {
                    unbroken = false;
                    break;
                }
            }
            if (unbroken) return true;
        }
    }
    return false;
}

describe('citationPageLocator (randomized)', () => {
    it('cites only labels of cited pages, one numbering per part, and drops unlabelled parts', () => {
        for (let seed = 1; seed <= 3000; seed++) {
            const random = rng(seed);
            const pageCount = 1 + Math.floor(random() * 40);
            const labels = randomLabels(random, pageCount);
            const pages = randomPages(random, pageCount);
            const result = citationPageLocator(labels, pages);
            const context = `seed ${seed}: pages "${pages}", labels ${JSON.stringify(labels)}`;

            if (Object.keys(labels).length === 0) {
                expect(result, context).toBe(pages);
                continue;
            }
            const cited = pages.split(',').map((part) => labelledPagesIn(labels, part.trim()))
                .filter((labelled) => labelled.length > 0);
            if (cited.length === 0) {
                expect(result, context).toBeUndefined();
                continue;
            }
            const outputs = result?.split(', ') ?? [];
            expect(outputs.length, context).toBe(cited.length);
            outputs.forEach((output, i) => {
                expect(isOneRunOf(labels, cited[i], output), `${context}: part "${output}"`).toBe(true);
            });
        }
    });

    it('stays linear on long and huge ranges', () => {
        const labels = Object.fromEntries(Array.from({ length: 30000 }, (_, i) => [i, String(i + 1)]));
        const started = performance.now();
        expect(citationPageLocator(labels, '1-30000')).toBe('1-30000');
        expect(citationPageLocator(labels, '1-9007199254740993')).toBe('1-30000');
        expect(citationPageLocator(labels, '9007199254740992')).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(500);
    });
});
