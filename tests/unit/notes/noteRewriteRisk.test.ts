import { describe, expect, it } from 'vitest';

import { assessNoteRewrite, retainedFraction, toComparableText } from '../../../src/utils/noteRewriteRisk';

/** A note long enough to be worth protecting (~3.5k characters of text). */
const PARAGRAPHS = Array.from(
    { length: 40 },
    (_, i) => `<p>Paragraph ${i}: corrugator activity during the preparation window predicts strategy choice.</p>`,
);
const NOTE = `<div data-schema-version="9">${PARAGRAPHS.join('\n')}</div>`;

describe('assessNoteRewrite', () => {
    it('flags a rewrite carrying only the section the model was working on', () => {
        const risk = assessNoteRewrite(NOTE, PARAGRAPHS[3]);

        expect(risk.removedFraction).toBeGreaterThan(0.9);
        expect(risk.retainedFraction).toBeLessThan(0.2);
        expect(risk.reason).toBe('shrunk');
        expect(risk.isDestructive).toBe(true);
    });

    it('flags a same-length rewrite that replaces the content outright', () => {
        const replacement = Array.from(
            { length: 40 },
            (_, i) => `<p>Section ${i}: housing markets and school access reproduce urban inequality.</p>`,
        ).join('\n');
        const risk = assessNoteRewrite(NOTE, replacement);

        // Length alone would clear this — retention is what catches it.
        expect(Math.abs(risk.removedFraction)).toBeLessThan(0.2);
        expect(risk.retainedFraction).toBeLessThan(0.6);
        expect(risk.reason).toBe('replaced');
        expect(risk.isDestructive).toBe(true);
    });

    it('clears a rewrite that reproduces the note with changes folded in', () => {
        const rewritten = `${PARAGRAPHS.join('\n')}\n<p>A closing paragraph on limitations.</p>`
            .replace('Paragraph 7:', 'Paragraph 7 (revised):');
        const risk = assessNoteRewrite(NOTE, rewritten);

        expect(risk.retainedFraction).toBeGreaterThan(0.9);
        expect(risk.isDestructive).toBe(false);
    });

    it('clears a restructure that keeps the note\'s text', () => {
        const reordered = [...PARAGRAPHS].reverse().join('\n');
        const risk = assessNoteRewrite(NOTE, reordered);

        expect(risk.isDestructive).toBe(false);
    });

    it('ignores markup-only changes', () => {
        const restyled = NOTE.replace(/<p>/g, '<p><strong>').replace(/<\/p>/g, '</strong></p>');

        expect(assessNoteRewrite(NOTE, restyled).isDestructive).toBe(false);
    });

    it('never escalates a short note, which is cheap to redo', () => {
        const risk = assessNoteRewrite('<p>Two short lines.</p><p>Nothing much here.</p>', '<p>Replaced.</p>');

        expect(risk.removedFraction).toBeGreaterThan(0.5);
        expect(risk.isDestructive).toBe(false);
    });
});

describe('retention signal', () => {
    it('scores identical text as fully retained and disjoint text near zero', () => {
        expect(retainedFraction('the quick brown fox', 'the quick brown fox')).toBe(1);
        expect(retainedFraction('aaaaaaaaaa', 'bbbbbbbbbb')).toBe(0);
    });

    it('works on scripts that do not separate words with spaces', () => {
        const original = '改写将删除先前过度延伸到后期治理与主体论的段落内容';
        expect(retainedFraction(original, original)).toBe(1);
        expect(retainedFraction(original, '这是一段完全不同的文字用于测试相似度比较')).toBeLessThan(0.2);
    });
});

describe('toComparableText', () => {
    it('reduces note HTML to collapsed lowercase text', () => {
        expect(toComparableText('<p>Hello&nbsp;<strong>World</strong></p>\n<p>Second</p>'))
            .toBe('hello world second');
    });
});
