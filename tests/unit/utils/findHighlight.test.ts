/**
 * The find-in-chat highlighting primitives: the plain-text helper, the markdown
 * (hast) transformer, and the query gate they both sit behind.
 *
 * `highlightText` is exercised through `renderToStaticMarkup` — the same
 * approach the other shared-component suites take, since jsdom is not loaded
 * for these tests.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    FIND_HIT_ATTR,
    FIND_HIT_CLASS,
    FIND_MIN_QUERY_LENGTH,
    FindQueryProvider,
    useFindQuery,
} from '@beaver/agent-ui/chat/findContext';
import { highlightText } from '@beaver/agent-ui/chat/highlightText';
import { rehypeFindHighlight } from '@beaver/agent-ui/chat/rehypeFindHighlight';

/** Render a highlight result to HTML so the emitted markup can be asserted on. */
function render(text: string, query: string, keyPrefix?: string): string {
    return renderToStaticMarkup(
        React.createElement(React.Fragment, null, highlightText(text, query, keyPrefix))
    );
}

const HIT_OPEN = `<mark class="${FIND_HIT_CLASS}" ${FIND_HIT_ATTR}="">`;

/** Wrap `inner` in the markup a hit is expected to render as. */
function hit(inner: string): string {
    return `${HIT_OPEN}${inner}</mark>`;
}

describe('highlightText', () => {
    it('returns the plain string when there is no query', () => {
        expect(highlightText('the quick brown fox', '')).toBe('the quick brown fox');
    });

    it('returns the plain string when the query does not occur', () => {
        expect(highlightText('the quick brown fox', 'zebra')).toBe('the quick brown fox');
    });

    it('wraps a single match and leaves the surrounding text alone', () => {
        expect(render('the quick brown fox', 'quick')).toBe(
            `the ${hit('quick')} brown fox`
        );
    });

    it('wraps every non-overlapping match', () => {
        expect(render('aaXaaXaa', 'aa')).toBe(
            `${hit('aa')}X${hit('aa')}X${hit('aa')}`
        );
    });

    it('does not re-match inside an already matched run', () => {
        // "aaa" holds one "aa" starting at 0; the scan resumes past it.
        expect(render('aaa', 'aa')).toBe(`${hit('aa')}a`);
    });

    it('matches case-insensitively while preserving the original casing', () => {
        expect(render('The Quick Brown Fox', 'quick')).toBe(
            `The ${hit('Quick')} Brown Fox`
        );
    });

    it('matches at the start of the string', () => {
        expect(render('quick brown', 'quick')).toBe(`${hit('quick')} brown`);
    });

    it('matches at the end of the string', () => {
        expect(render('brown quick', 'quick')).toBe(`brown ${hit('quick')}`);
    });

    it('matches when the query spans the whole string', () => {
        expect(render('quick', 'QUICK')).toBe(hit('quick'));
    });

    it('treats regex metacharacters literally', () => {
        expect(render('a.b and axb', 'a.b')).toBe(`${hit('a.b')} and axb`);
        expect(render('f(x) = 1', '(x)')).toBe(`f${hit('(x)')} = 1`);
        expect(render('an [unclosed bracket', '[')).toBe(`an ${hit('[')}unclosed bracket`);
        expect(render('a+b', 'a+')).toBe(`${hit('a+')}b`);
    });

    it('does not throw on a query that would be an invalid regex', () => {
        expect(() => highlightText('some text', '(')).not.toThrow();
        expect(() => highlightText('some text', '[a-')).not.toThrow();
        expect(() => highlightText('some text', '\\')).not.toThrow();
    });

    it('gives each hit a key derived from the supplied prefix', () => {
        const nodes = highlightText('aa bb aa', 'aa', 'msg-3') as React.ReactNode[];
        const keys = (nodes as any[])
            .filter((node) => node && typeof node === 'object')
            .map((node) => node.key);
        expect(keys).toEqual(['msg-3-0', 'msg-3-6']);
    });
});

/** Minimal hast helpers, mirroring the shapes react-markdown produces. */
function text(value: string) {
    return { type: 'text', value };
}

function element(tagName: string, properties: Record<string, unknown>, children: any[]) {
    return { type: 'element', tagName, properties, children };
}

function root(children: any[]) {
    return { type: 'root', children };
}

/** Concatenate every text value in a tree, marking hits with «…». */
function readTree(node: any): string {
    if (node.type === 'text') return node.value;
    const inner = (node.children ?? []).map(readTree).join('');
    return node.tagName === 'mark' ? `«${inner}»` : inner;
}

describe('rehypeFindHighlight', () => {
    it('wraps matches in a mark carrying the shared class and attribute', () => {
        const tree = root([element('p', {}, [text('the quick brown fox')])]);
        rehypeFindHighlight('quick')(tree);

        const paragraph = tree.children[0] as any;
        expect(paragraph.children.map((child: any) => child.value ?? child.tagName)).toEqual([
            'the ',
            'mark',
            ' brown fox',
        ]);
        expect(paragraph.children[1].properties).toEqual({
            className: [FIND_HIT_CLASS],
            [FIND_HIT_ATTR]: '',
        });
        expect(paragraph.children[1].children).toEqual([text('quick')]);
    });

    it('marks every match across nested elements', () => {
        const tree = root([
            element('p', {}, [
                text('one hit here'),
                element('strong', {}, [text('another hit')]),
            ]),
        ]);
        rehypeFindHighlight('hit')(tree);
        expect(readTree(tree)).toBe('one «hit» hereanother «hit»');
    });

    it('matches case-insensitively', () => {
        const tree = root([element('p', {}, [text('Quick and QUICK')])]);
        rehypeFindHighlight('quick')(tree);
        expect(readTree(tree)).toBe('«Quick» and «QUICK»');
    });

    it('leaves the tree untouched when the query is empty', () => {
        const tree = root([element('p', {}, [text('the quick brown fox')])]);
        const before = JSON.parse(JSON.stringify(tree));
        rehypeFindHighlight('')(tree);
        expect(tree).toEqual(before);
    });

    it('leaves the tree untouched when nothing matches', () => {
        const tree = root([element('p', {}, [text('the quick brown fox')])]);
        const before = JSON.parse(JSON.stringify(tree));
        rehypeFindHighlight('zebra')(tree);
        expect(tree).toEqual(before);
    });

    it('does not descend into KaTeX output', () => {
        const tree = root([
            element('span', { className: ['katex'] }, [
                element('span', { className: ['katex-mathml'] }, [text('x quick y')]),
                element('span', { className: ['katex-html'] }, [text('quick')]),
            ]),
            element('p', {}, [text('quick')]),
        ]);
        rehypeFindHighlight('quick')(tree);
        expect(readTree(tree)).toBe('x quick yquick«quick»');
    });

    it('does not descend into a katex-display wrapper', () => {
        const tree = root([
            element('span', { className: ['katex-display'] }, [text('quick')]),
        ]);
        rehypeFindHighlight('quick')(tree);
        expect(readTree(tree)).toBe('quick');
    });

    it('does not descend into math elements, including a string className', () => {
        const tree = root([
            element('span', { className: ['math', 'math-inline'] }, [text('quick')]),
            element('pre', { className: 'math' }, [text('quick')]),
        ]);
        rehypeFindHighlight('quick')(tree);
        expect(readTree(tree)).toBe('quickquick');
    });

    it('does not descend into citation elements', () => {
        const tree = root([
            element('p', {}, [
                text('as shown quick '),
                element('citation', { 'data-zotero-key': 'ABCD1234' }, [text('quick')]),
            ]),
        ]);
        rehypeFindHighlight('quick')(tree);
        expect(readTree(tree)).toBe('as shown «quick» quick');
    });

    it('treats regex metacharacters literally', () => {
        const tree = root([element('p', {}, [text('a.b and axb')])]);
        rehypeFindHighlight('a.b')(tree);
        expect(readTree(tree)).toBe('«a.b» and axb');
    });

    it('does not throw on a query that would be an invalid regex', () => {
        const tree = root([element('p', {}, [text('a (partial thing')])]);
        expect(() => rehypeFindHighlight('(')(tree)).not.toThrow();
        expect(readTree(tree)).toBe('a «(»partial thing');
    });
});

/** Renders whatever `useFindQuery` reports, so the gate can be asserted on. */
function Probe() {
    return React.createElement('span', null, `[${useFindQuery()}]`);
}

function readQuery(query?: string): string {
    const probe = React.createElement(Probe);
    const tree =
        query === undefined
            ? probe
            : React.createElement(FindQueryProvider, { query }, probe);
    return renderToStaticMarkup(tree).replace(/^<span>\[|\]<\/span>$/g, '');
}

describe('useFindQuery', () => {
    it('reports the query supplied by the provider', () => {
        expect(readQuery('quick')).toBe('quick');
    });

    it('reports nothing when there is no provider above', () => {
        expect(readQuery()).toBe('');
    });

    it('reports nothing for a whitespace-only query', () => {
        expect(readQuery('   ')).toBe('');
    });

    it('reports nothing for a query shorter than the minimum length', () => {
        expect(FIND_MIN_QUERY_LENGTH).toBe(2);
        expect(readQuery('q')).toBe('');
    });

    it('reports a query exactly at the minimum length', () => {
        expect(readQuery('qu')).toBe('qu');
    });

    it('keeps surrounding whitespace, which is part of what the user searched for', () => {
        expect(readQuery('of ')).toBe('of ');
    });
});
