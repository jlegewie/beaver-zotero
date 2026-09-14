import React from 'react';

/** Renders `text` with the first case-insensitive occurrence of `query` emphasized. */
export function highlightMatch(text: string, query: string): React.ReactNode {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
        <>
            {text.slice(0, idx)}
            <span className="font-color-accent-blue font-medium">{text.slice(idx, idx + query.length)}</span>
            {text.slice(idx + query.length)}
        </>
    );
}
