import React, { ReactNode } from 'react';
import { getHost } from '../host';

export interface DocsLinkProps {
    /**
     * Path of the documentation page, relative to the docs site root and
     * without a leading slash (e.g. `credits#credit-overview`). Kept relative
     * because the caller — often the backend, which supplies the path with the
     * text it wants linked — cannot know which docs deployment this client
     * points at.
     */
    path: string;
    children: ReactNode;
    /** Extra class names, merged with the link styling. */
    className?: string;
}

/**
 * A link into the Beaver documentation site.
 *
 * Both halves of "open the docs" are client-specific: the docs base URL (a
 * separate deployment each client learns differently) and what opening a URL
 * means (neither a Zotero chrome window nor an Office task pane may navigate
 * itself). So this component owns only the shape of the link and reaches both
 * through the host registry.
 */
const DocsLink: React.FC<DocsLinkProps> = ({ path, children, className }) => {
    const href = getHost().config?.docsUrl?.(path);

    // No docs base URL from this host: render the text without a link rather
    // than an anchor that goes nowhere. A dead link is worse than prose — it
    // invites a click that silently does nothing, and the sentence around it
    // still reads correctly on its own. Each component decides how an absent
    // host slice degrades; this is that decision for documentation links.
    if (!href) {
        return <span className={className}>{children}</span>;
    }

    return (
        <a
            href={href}
            onClick={(event) => {
                // With no navigation slice, fall through to the anchor's own
                // behavior instead of swallowing the click: the href is a real
                // absolute URL, and `target="_blank"` is the correct fallback
                // in any host whose window can open one. Preventing the default
                // here would turn a working link into a dead one.
                const navigation = getHost().navigation;
                if (!navigation) return;
                event.preventDefault();
                navigation.openExternalUrl(href);
            }}
            target="_blank"
            rel="noopener noreferrer"
            className={className ? `text-link ${className}` : 'text-link'}
        >
            {children}
        </a>
    );
};

export default DocsLink;
