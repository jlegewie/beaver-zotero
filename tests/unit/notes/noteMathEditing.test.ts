import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'test' })),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { normalizeNoteHtml, simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
import { expandBase, findBestMatch, type MatchInput } from '../../../src/utils/editNoteMatcher';
import {
    applyResolvedEdits,
    resolveBatchEdits,
    type BatchEditSpec,
    type ResolveBatchContext,
} from '../../../src/utils/editNoteBatchCore';

const inline = (text: string) => `<span class="math">$${text}$</span>`;
const display = (text: string) => `<pre class="math">$$${text}$$</pre>`;

function context(html: string): ResolveBatchContext {
    const strippedHtml = normalizeNoteHtml(`<div data-schema-version="9">${html}</div>`);
    const { simplified, metadata } = simplifyNoteHtml(strippedHtml, 1);
    return {
        strippedHtml, simplified, metadata,
        externalRefContext: { externalRefs: {}, externalItemMapping: {} },
        pageLabels: {}, appendPoint: 0, mode: 'validate',
    };
}

function edit(oldString: string, newString: string, operation: BatchEditSpec['operation'] = 'str_replace'): BatchEditSpec {
    return { index: 0, oldString, newString, operation };
}

function resolveAndExecute(ctx: ResolveBatchContext, spec: BatchEditSpec) {
    const validated = resolveBatchEdits(ctx, [spec]);
    expect(validated.failures).toEqual([]);
    expect(validated.resolved).toHaveLength(1);
    const target = validated.resolved[0];
    const executed = resolveBatchEdits({ ...ctx, mode: 'execute' }, [{
        ...spec,
        oldString: target.normalizedOldString!,
        newString: target.normalizedNewString!,
        targetBeforeContext: target.targetBeforeContext,
        targetAfterContext: target.targetAfterContext,
    }]);
    expect(executed.failures).toEqual([]);
    expect(executed.resolved[0].applyOps).toEqual(target.applyOps);
    return { target, applied: applyResolvedEdits(ctx.strippedHtml, executed.resolved) };
}

describe('literal math read/edit contract', () => {
    it('retains inline, display, empty wrappers, entities, and literal dollar text in a read round-trip', () => {
        const ctx = context(`<p>Literal $x$; math ${inline('x &lt; y')} and ${inline('')}.</p>${display('a\nb')}${display('')}`);
        expect(ctx.simplified).toContain('Literal $x$');
        for (const math of [inline('x &lt; y'), inline(''), display('a\nb'), display('')]) {
            expect(ctx.simplified).toContain(math);
        }
        expect(expandToRawHtml(ctx.simplified, ctx.metadata, 'old')).toBe(ctx.simplified);
    });

    it.each(['$a b$', '$$a\nb$$', '<p>$x$</p>', '$x &lt; y$', '$a<em>b</em>c$'])('keeps old dollar anchor literal: %s', (anchor) => {
        expect(expandToRawHtml(anchor, { elements: new Map() }, 'old')).toBe(anchor);
    });

    it.each([inline, display])('replaces and deletes whole math elements without leaving wrappers', (math) => {
        const ctx = context(`<p>Before.</p><p>Equation: ${math === inline ? math('x') : ''}</p>${math === display ? math('x') : ''}<p>After.</p>`);
        for (const replacement of [math('y'), 'replacement', '']) {
            const { target, applied } = resolveAndExecute(ctx, edit(math('x'), replacement));
            expect(target.strategy).toBe('exact');
            expect(target.undoOldHtml).toBe(math('x'));
            expect(applied.newStrippedHtml).not.toContain(math('x'));
            expect(applied.newStrippedHtml).toContain(replacement);
        }
    });

    it('prefers a literal paragraph anchor over legacy math expansion', () => {
        const literal = '<p>Value $x$.</p>';
        const wrapped = `<p>Value ${inline('x')}.</p>`;
        const ctx = context(literal + wrapped);
        const { target, applied } = resolveAndExecute(ctx, edit(literal, '<p>Replaced.</p>'));
        expect(target.strategy).toBe('exact');
        expect(applied.newStrippedHtml).toContain(wrapped);
        expect(applied.newStrippedHtml).not.toContain(literal);
    });

    it.each(['str_replace', 'str_replace_all'] as const)('requests a more specific anchor for mixed literal/wrapped matches: %s', (operation) => {
        const ctx = context(`<p>Literal $x$ and math ${inline('x')}.</p>`);
        const result = resolveBatchEdits(ctx, [edit('$x$', '$y$', operation)]);
        expect(result.resolved).toEqual([]);
        expect(result.failures[0].errorCode).toBe('ambiguous_match');
        expect(result.failures[0].error).toContain('copy the whole <span class="math">');
    });

    it.each(['insert_after', 'insert_before'] as const)('preserves a literal dollar anchor for %s, before and after validation merges it', (operation) => {
        const ctx = context('<p>Value $x$.</p>');
        const { applied } = resolveAndExecute(ctx, edit('$x$', ' plus $y$', operation));
        expect(applied.newStrippedHtml).toContain(operation === 'insert_after'
            ? `$x$ plus ${inline('y')}` : ` plus ${inline('y')}$x$`);
        expect(applied.newStrippedHtml).not.toContain(inline('x'));
    });
});

describe('legacy dollar-math anchors', () => {
    it.each([
        [inline('x'), '$x$'],
        [display('x'), '$$x$$'],
        [`<p>Value ${inline('x')}.</p>`, '<p>Value $x$.</p>'],
        [display('x'), '<p>$x$</p>'],
    ])('restores the wrapper for %s during validation and execution', (html, anchor) => {
        const ctx = context(`<p>Before.</p>${html}<p>After.</p>`);
        const { target, applied } = resolveAndExecute(ctx, edit(anchor, 'replacement'));
        expect(target.strategy).toBe('legacy_math');
        expect(target.expandedOld).toBe(html);
        expect(applied.newStrippedHtml).not.toContain('class="math"');
        expect(applied.newStrippedHtml).toContain('replacement');
    });

    it.each(['insert_before', 'insert_after'] as const)('inserts outside the legacy math wrapper for %s', (operation) => {
        const ctx = context(`<p>Value ${inline('x')}.</p>`);
        const { target, applied } = resolveAndExecute(ctx, edit('$x$', ' added $y$', operation));
        expect(target.strategy).toBe('legacy_math');
        expect(applied.newStrippedHtml).toContain(operation === 'insert_after'
            ? `${inline('x')} added ${inline('y')}` : ` added ${inline('y')}${inline('x')}`);
    });

    it('retains ambiguity checks for repeated legacy anchors and supports replace-all', () => {
        const ctx = context(`<p>${inline('x')} and ${inline('x')}.</p>`);
        const ambiguous = resolveBatchEdits(ctx, [edit('$x$', '$y$')]);
        expect(ambiguous.failures[0].errorCode).toBe('ambiguous_match');
        const { target, applied } = resolveAndExecute(ctx, edit('$x$', '$y$', 'str_replace_all'));
        expect(target.occurrencesReplaced).toBe(2);
        expect(applied.newStrippedHtml.split(inline('y'))).toHaveLength(3);
        expect(applied.newStrippedHtml).not.toContain(inline('x'));
    });

    it('legacy expansion preserves malformed formulas and code while expanding adjacent math', () => {
        const input = '$a<em>b</em>c$ and $x$; $$d<em>e</em>f$$ then $$y$$; <code>$z$</code>';
        expect(expandToRawHtml(input, { elements: new Map() }, 'legacy-old')).toBe(
            `$a<em>b</em>c$ and ${inline('x')}; $$d<em>e</em>f$$ then ${display('y')}; <code>$z$</code>`
        );
    });

    it('does not reinterpret code or manufacture markup around a malformed formula', () => {
        for (const anchor of ['<pre>$x$</pre>', '$a<em>b</em>c$']) {
            const ctx = context(`<p>Before.</p>${anchor}<p>After.</p>`);
            const { target } = resolveAndExecute(ctx, edit(anchor, 'replacement'));
            expect(target.strategy).toBe('exact');
        }
    });

    it('keeps legacy math support after a literal exact match is unavailable', () => {
        const ctx = context(`<p>The value is ${inline('x')}.</p>`);
        const input: MatchInput = { ...ctx, oldString: 'The value is $x$.', newString: 'New value.', operation: 'str_replace' };
        const result = findBestMatch(input, expandBase(input));
        expect(result?.strategy).toBe('legacy_math');
        expect(result?.expandedOld).toBe(`The value is ${inline('x')}.`);
    });
});


describe('normalization of legacy math anchors', () => {
    it.each([
        ['trim_trailing_newlines', inline('x'), '$x$\n'],
        ['entity_decode', inline("x'"), '$x&#x27;$'],
        ['entity_encode', inline('x &amp; y'), '$x & y$'],
        ['nfkc', inline('X'), '$Ｘ$'],
        ['quote_normalized', inline('"x"'), '$“x”$'],
        ['json_unescape', inline(String.raw`\alpha`), String.raw`$\\alpha$`],
        ['spurious_wrap_strip', `Value ${inline('x')}.`, '<p>Value $x$.</p>'],
        ['tag_attribute_strip', `<p>Value ${inline('x')}.</p>`, '<p class="unused">Value $x$.</p>'],
        ['markdown_to_html', `<strong>Value</strong> ${inline('x')}.`, '**Value** $x$.'],
        ['whitespace_relaxed', `The value is ${inline('x')} in this sufficiently long equation.`, 'The  value is $x$ in this sufficiently long equation.'],
    ])('retains %s for legacy anchors through validate and execute', (strategy, raw, anchor) => {
        const ctx = context(raw.startsWith('<p>') ? raw : `<p>Before ${raw} After.</p>`);
        const replacement = strategy === 'spurious_wrap_strip' ? '<p>replacement</p>' : 'replacement';
        const { target, applied } = resolveAndExecute(ctx, edit(anchor, replacement));
        expect(target.strategy).toBe(strategy);
        expect(target.expandedOld).toBe(raw);
        expect(target.undoOldHtml).toBe(raw);
        expect(applied.newStrippedHtml).toContain('replacement');
        expect(applied.newStrippedHtml).not.toContain('class="math"');
    });

    it.each(['insert_before', 'insert_after'] as const)('normalizes a trailing newline for %s without duplicating the anchor', (operation) => {
        const ctx = context(`<p>Value ${inline('x')}.</p>`);
        const { target, applied } = resolveAndExecute(ctx, edit('$x$\n', ' plus $y$', operation));
        expect(target.strategy).toBe('trim_trailing_newlines');
        expect(target.normalizedOldString).toBe('$x$');
        expect(applied.newStrippedHtml).toContain(operation === 'insert_after'
            ? `${inline('x')} plus ${inline('y')}` : ` plus ${inline('y')}${inline('x')}`);
        expect(applied.newStrippedHtml.split(inline('x'))).toHaveLength(2);
    });

    it.each(['insert_before', 'insert_after'] as const)('preserves already-merged legacy payloads with relaxed whitespace for %s', (operation) => {
        const raw = `The value is ${inline('x')} in this sufficiently long equation.`;
        const anchor = 'The  value is $x$ in this sufficiently long equation.';
        const ctx = context(`<p>${raw}</p>`);
        const payload = operation === 'insert_after' ? anchor + ' added' : 'added ' + anchor;
        const { target, applied } = resolveAndExecute(ctx, edit(anchor, payload, operation));
        expect(target.strategy).toBe('whitespace_relaxed');
        expect(applied.newStrippedHtml).toContain(operation === 'insert_after'
            ? raw + ' added' : 'added ' + raw);
        expect(applied.newStrippedHtml.split(inline('x'))).toHaveLength(2);
    });

    it('prefers a normalized literal anchor over an exact legacy-expanded anchor', () => {
        const literal = '<p>Value $X$.</p>';
        const wrapped = `<p>Value ${inline('Ｘ')}.</p>`;
        const anchor = '<p>Value $Ｘ$.</p>';
        const ctx = context(literal + wrapped);
        expect(ctx.strippedHtml).toContain(expandToRawHtml(anchor, ctx.metadata, 'legacy-old'));
        const { target, applied } = resolveAndExecute(ctx, edit(anchor, '<p>replacement</p>'));
        expect(target.strategy).toBe('nfkc');
        expect(target.expandedOld).toBe(literal);
        expect(applied.newStrippedHtml).toContain(wrapped);
    });

    it('still rejects mixed literal and wrapped matches after trimming', () => {
        const ctx = context(`<p>Literal $x$ and math ${inline('x')}.</p>`);
        const result = resolveBatchEdits(ctx, [edit('$x$\n', '$y$')]);
        expect(result.resolved).toEqual([]);
        expect(result.failures[0].errorCode).toBe('ambiguous_match');
    });

    it('retains duplicate-anchor ambiguity and replace-all semantics after trimming', () => {
        const ctx = context(`<p>${inline('x')} and ${inline('x')}.</p>`);
        expect(resolveBatchEdits(ctx, [edit('$x$\n', '$y$')]).failures[0].errorCode).toBe('ambiguous_match');
        const { target, applied } = resolveAndExecute(ctx, edit('$x$\n', '$y$', 'str_replace_all'));
        expect(target.occurrencesReplaced).toBe(2);
        expect(applied.newStrippedHtml.split(inline('y'))).toHaveLength(3);
    });
});
