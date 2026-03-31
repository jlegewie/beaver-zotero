import React from 'react';

const citationBadge: React.CSSProperties = {
    fontSize: '0.85em',
    paddingLeft: '0.35em',
    paddingRight: '0.35em',
    borderRadius: '0.25em',
    border: '1px solid',
    fontWeight: 500,
};

const green: React.CSSProperties = {
    ...citationBadge,
    background: 'var(--tag-green-quinary)',
    borderColor: 'var(--tag-green-tertiary)',
    color: 'var(--tag-green-primary)',
};

const gray: React.CSSProperties = {
    ...citationBadge,
    background: 'var(--fill-quinary)',
    borderColor: 'var(--fill-quinary)',
    color: 'var(--fill-secondary)',
};

const blue: React.CSSProperties = {
    ...citationBadge,
    background: 'var(--tag-blue-quinary)',
    borderColor: 'var(--tag-blue-tertiary)',
    color: 'var(--tag-blue)',
};

export const CitationTipContent: React.FC = () => (
    <div className="text-base font-color-secondary" style={{ lineHeight: '1.6' }}>
        Beaver cites sources from your library and beyond.
        <br />
        <span style={gray}>1</span> points to an item in your library.
        <br />
        <span style={green}>2</span> opens a specific page in your PDF.
        <br />
        <span style={blue}>3</span> is an external reference you can explore or import to your library.
    </div>
);
