import React from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { getHost } from '@beaver/agent-ui/host';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { externalRecordLinks, primaryExternalUrl, type TrialStatusTone } from '@beaver/agent-core/citations/externalRecordDisplay';

/** Building blocks shared by the PubMed and trial rows and details views. */

export const RecordBadge: React.FC<{ label: string; tone?: TrialStatusTone | 'neutral'; tooltip?: string }> = ({
    label,
    tone = 'neutral',
    tooltip,
}) => {
    const badge = <span className="ext-badge" data-tone={tone}>{label}</span>;
    return tooltip ? <Tooltip content={tooltip} singleLine={tooltip.length < 70}>{badge}</Tooltip> : badge;
};

export const RetractedBanner: React.FC = () => (
    <div className="display-flex">
        <span className="ext-retracted-banner">Retracted</span>
    </div>
);

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

/** "PubMed · PMC · DOI · ClinicalTrials.gov" links derived from the record's identifiers. */
export const RecordLinks: React.FC<{ item: ExternalReference; className?: string }> = ({ item, className = '' }) => {
    const links = externalRecordLinks(item);
    if (!links.length) return null;
    return (
        <div className={`display-flex flex-row flex-wrap items-center gap-1 text-sm ${className}`}>
            {links.map((link, index) => (
                <React.Fragment key={link.kind}>
                    {index > 0 && <span className="font-color-tertiary">·</span>}
                    <RecordLink url={link.url}>{link.label}</RecordLink>
                </React.Fragment>
            ))}
        </div>
    );
};

/** A labelled section in a details view. */
export const DetailsSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="display-flex flex-col gap-1">
        <div className="font-bold font-color-primary uppercase tracking-wider text-sm">{title}</div>
        <div className="font-color-primary leading-relaxed select-text">{children}</div>
    </div>
);

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
            <div className="display-flex flex-col gap-1 px-4 py-2 shrink-0">{header}</div>
            {body.length > 0 && (
                <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
                    <div className="display-flex flex-col gap-3">{body}</div>
                </div>
            )}
            <div className="p-4 pt-3 border-t border-quaternary shrink-0">{footer}</div>
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
