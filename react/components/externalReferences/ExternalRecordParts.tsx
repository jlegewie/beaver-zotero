import React, { useState } from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { getHost } from '@beaver/agent-ui/host';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalRecordLinks, primaryExternalUrl, type TrialStatusTone } from '@beaver/agent-core/citations/externalRecordDisplay';

/**
 * Building blocks shared by the PubMed and trial rows and details views.
 *
 * Tags follow one rule: neutral grey describes what a record is (a study
 * design, a publication type); color reports a state worth acting on (free
 * full text, recruiting, retracted).
 */

export const RecordBadge: React.FC<{ label: string; tone?: TrialStatusTone | 'neutral'; tooltip?: string }> = ({
    label,
    tone = 'neutral',
    tooltip,
}) => {
    const badge = <span className="ext-badge" data-tone={tone}>{label}</span>;
    return tooltip ? <Tooltip content={tooltip} singleLine={tooltip.length < 70}>{badge}</Tooltip> : badge;
};

/** A row of tags; renders nothing without any. */
export const RecordTags: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const tags = React.Children.toArray(children).filter(Boolean);
    if (!tags.length) return null;
    return <div className="display-flex flex-row flex-wrap items-center gap-1">{tags}</div>;
};

/** Opens a URL through the host; a plain anchor would navigate the chat pane. */
export function openExternal(url: string | undefined): void {
    if (url) getHost().navigation?.openExternalUrl(url);
}

/** A link-styled span that opens `url` through the host. */
export const RecordLink: React.FC<{ url: string; children: React.ReactNode; className?: string }> = ({
    url,
    children,
    className = '',
}) => (
    <a
        className={`text-link-muted ${className}`}
        role="link"
        tabIndex={0}
        onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openExternal(url);
        }}
        onKeyDown={(event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                openExternal(url);
            }
        }}
    >
        {children}
    </a>
);

/** "View on PubMed · PubMed Central · Publisher": the record's pages on other sites. */
export const RecordLinks: React.FC<{ item: ExternalReference; className?: string }> = ({ item, className = '' }) => {
    const links = externalRecordLinks(item);
    if (!links.length) return null;
    return (
        <div className={`text-sm ${className}`}>
            <span className="font-color-secondary">View on </span>
            {links.map((link, index) => (
                <React.Fragment key={link.kind}>
                    {index > 0 && <span className="font-color-secondary"> · </span>}
                    <RecordLink url={link.url}>{link.label}</RecordLink>
                </React.Fragment>
            ))}
        </div>
    );
};

/** Labelled facts in two columns. Entries without a value are left out. */
export const RecordFacts: React.FC<{ facts: Array<[string, React.ReactNode]> }> = ({ facts }) => {
    const shown = facts.filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false);
    if (!shown.length) return null;
    return (
        <div className="ext-facts">
            {shown.map(([label, value]) => (
                <React.Fragment key={label}>
                    <span className="ext-fact-label">{label}</span>
                    <span className="ext-fact-value">{value}</span>
                </React.Fragment>
            ))}
        </div>
    );
};

/** A section of a details view, under one heading style. */
export const DetailsSection: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({
    title,
    aside,
    children,
}) => (
    <div className="display-flex flex-col gap-2">
        <div className="display-flex flex-row items-center gap-2">
            <span className="ext-section-title">{title}</span>
            {aside}
        </div>
        <div className="font-color-primary leading-relaxed select-text">{children}</div>
    </div>
);

/** Names joined by commas, the rest behind "+N more" when there are many. */
export const ExpandableNames: React.FC<{ names: string[]; limit?: number; className?: string }> = ({
    names,
    limit = 6,
    className = '',
}) => {
    const [expanded, setExpanded] = useState(false);
    if (!names.length) return null;
    const hidden = names.length - limit;
    const shown = expanded || hidden <= 1 ? names : names.slice(0, limit);
    return (
        <div className={className}>
            {shown.join(', ')}
            {hidden > 1 && (
                <>
                    {' '}
                    <a className="text-link-muted" role="button" tabIndex={0} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? 'show fewer' : `+${hidden} more`}
                    </a>
                </>
            )}
        </div>
    );
};

/** First `limit` entries and how many more there are. */
export function capList<T>(values: T[] | null | undefined, limit: number): { shown: T[]; more: number } {
    const list = values ?? [];
    return { shown: list.slice(0, limit), more: Math.max(0, list.length - limit) };
}

/** The details layout: a fixed header, a scrolling body, and the actions. */
export const DetailsFrame: React.FC<{ header: React.ReactNode; footer: React.ReactNode; children?: React.ReactNode }> = ({
    header,
    footer,
    children,
}) => {
    const body = React.Children.toArray(children).filter(Boolean);
    return (
        <div className="display-flex flex-col h-full overflow-hidden">
            <div className="display-flex flex-col gap-2 px-5 pt-2 pb-3 shrink-0">{header}</div>
            {body.length > 0 && (
                <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0 border-top-quinary">
                    <div className="display-flex flex-col gap-5">{body}</div>
                </div>
            )}
            <div className="px-5 pt-3 pb-4 border-t border-quaternary shrink-0">{footer}</div>
        </div>
    );
};

export const DetailsActions: React.FC<{ item: ExternalReference }> = ({ item }) => (
    <>
        {getHost().components?.externalReferenceActions({
            item,
            detailsButtonMode: 'none',
            webButtonMode: 'icon-only',
            pdfButtonMode: 'icon-only',
            webUrl: primaryExternalUrl(item),
        })}
    </>
);
