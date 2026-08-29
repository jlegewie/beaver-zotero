import React from 'react';
import { FIND_HIT_ATTR, FIND_HIT_CLASS, findMatchRanges } from './findContext';

/**
 * Wrap every occurrence of `query` in `text` in a find-hit `<mark>`.
 *
 * For renderers that display a plain string (message text, chip labels, table
 * cells). Markdown goes through `rehypeFindHighlight` instead, which does the
 * same thing to a hast tree.
 *
 * Returns the string itself — not a one-element array — when there is nothing
 * to highlight, so a caller that passes no query renders exactly what it
 * rendered before find-in-chat existed.
 *
 * @param keyPrefix Disambiguates React keys when one parent renders several
 *                  highlighted strings.
 */
export function highlightText(
    text: string,
    query: string,
    keyPrefix: string = 'find'
): React.ReactNode {
    const ranges = findMatchRanges(text, query);
    if (ranges.length === 0) return text;

    // A computed attribute name cannot be written as JSX syntax, so the hit
    // props are built as an object and spread.
    const hitProps: Record<string, string> = {
        className: FIND_HIT_CLASS,
        [FIND_HIT_ATTR]: '',
    };

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (const { start, end } of ranges) {
        if (start > cursor) nodes.push(text.slice(cursor, start));
        nodes.push(
            <mark key={`${keyPrefix}-${start}`} {...hitProps}>
                {text.slice(start, end)}
            </mark>
        );
        cursor = end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}
