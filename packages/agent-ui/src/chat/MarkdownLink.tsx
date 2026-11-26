import React, { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { resolveObjectIdReference } from '@beaver/agent-core/identity/libraryRef';
import { parseItemLinkHref, type ItemLinkTarget } from '@beaver/agent-core/identity/itemLinks';
import { isHttpUrl, parseWebLinkHref } from '@beaver/agent-core/identity/webPages';
import { externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { getHost } from '../host';
import type { LinkedObject } from '../host/types';
import { AttachmentIcon, FileIcon, FolderIcon, GlobeIcon, HighlighterIcon, Icon, NoteIcon, PdfIcon } from '../icons';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

// =============================================================================
// What a key names
// =============================================================================

/** Resolved kinds, by object id. A miss is retried after a while: the object may not exist yet. */
const resolvedObjects = new Map<string, { value: LinkedObject | null; at: number }>();
const pendingObjects = new Map<string, Promise<LinkedObject | null>>();
const MISS_TTL_MS = 10_000;
const MAX_RESOLVED_OBJECTS = 500;

function cachedObject(objectId: string): LinkedObject | null | undefined {
    const entry = resolvedObjects.get(objectId);
    if (!entry) return undefined;
    if (entry.value === null && Date.now() - entry.at > MISS_TTL_MS) {
        resolvedObjects.delete(objectId);
        return undefined;
    }
    return entry.value;
}

/** Resolve an object id through the host; null at once when the host cannot. */
function lookUpObject(objectId: string): Promise<LinkedObject | null> | null {
    const pending = pendingObjects.get(objectId);
    if (pending) return pending;
    const itemData = getHost().itemData;
    const ref = resolveObjectIdReference(objectId);
    if (!itemData?.resolveLinkedObject || !ref) return null;
    const lookup = itemData
        .resolveLinkedObject(ref)
        .catch(() => null)
        .then((value) => {
            pendingObjects.delete(objectId);
            if (resolvedObjects.size >= MAX_RESOLVED_OBJECTS) resolvedObjects.clear();
            resolvedObjects.set(objectId, { value, at: Date.now() });
            return value;
        });
    pendingObjects.set(objectId, lookup);
    return lookup;
}

/**
 * What an object link's key names, from the host. `undefined` while it is
 * being resolved, null when the host cannot say. Results are kept per object
 * id, so a link the chat re-mounts while a response streams draws its icon at
 * once instead of resolving it again.
 */
function useLinkedObject(link: ItemLinkTarget | null): LinkedObject | null | undefined {
    const objectId = link?.kind === 'object' ? link.objectId : null;
    const [resolved, setResolved] = useState(() => (objectId ? cachedObject(objectId) : undefined));
    useEffect(() => {
        if (!objectId) return undefined;
        const cached = cachedObject(objectId);
        setResolved(cached);
        if (cached !== undefined) return undefined;
        const lookup = lookUpObject(objectId);
        if (!lookup) {
            setResolved(null);
            return undefined;
        }
        let cancelled = false;
        void lookup.then((value) => {
            if (!cancelled) setResolved(value);
        });
        return () => {
            cancelled = true;
        };
    }, [objectId]);
    if (link?.kind === 'collection') return { kind: 'collection' };
    return objectId ? resolved : null;
}

/** The type icon of a library object. No icon for a kind it cannot name. */
function objectIcon(object: LinkedObject | null | undefined): IconComponent | null {
    switch (object?.kind) {
        case 'item':
            return FileIcon;
        case 'attachment':
            return object.contentKind === 'pdf' ? PdfIcon : AttachmentIcon;
        case 'note':
            return NoteIcon;
        case 'annotation':
            return HighlighterIcon;
        case 'collection':
            return FolderIcon;
        default:
            return null;
    }
}

// =============================================================================
// The link
// =============================================================================

/** Links that are not web page ids share this atom instead of a selector each. */
const NO_WEB_URL = atom<string | undefined>(undefined);

/**
 * A link's leading icon. It is an inline box whose start padding holds the
 * glyph, not an atomic one: a line can break after an inline-block, but never
 * between an inline box's start edge and the text that follows it, so the icon
 * stays with the link's first word whatever markup that word is in.
 */
function LinkIcon({ icon }: { icon: IconComponent }) {
    return (
        <span className="markdown-link-icon" aria-hidden="true">
            <Icon icon={icon} />
        </span>
    );
}

export interface MarkdownLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    /** The source syntax-tree node the Markdown renderer hands its components; never a DOM attribute. */
    node?: unknown;
}

/**
 * Anchor rendered in chat Markdown, led by a small icon for what it opens.
 *
 * The default click is always suppressed: clients render the chat where a bare
 * `<a href>` either does nothing (a chrome document) or would navigate the UI
 * away (a task pane). Every link opens through the host instead.
 *
 * - An object id (`[Smith 2004](u-KEY)`, see `itemLinks.ts`) reveals the item,
 *   attachment, note, annotation or collection in the host. Its icon says
 *   which, as the host resolves the key (`itemData.resolveLinkedObject`).
 * - A web page id (`[WHO fact sheet](web-KEY)`) opens the page's URL, from the
 *   conversation's record of the page.
 * - An http(s) URL opens in the browser. Other links (`zotero://` URIs,
 *   `mailto:`) open through the host with no icon.
 *
 * A link the host cannot follow (an object link without `revealObject`, a web
 * page id the conversation has no record of, any link on a host without
 * navigation) renders as its text alone: a control that does nothing when
 * clicked is worse than none. Fragment links (footnote references) have no
 * target and stay inert anchors.
 */
export function MarkdownLink({ href, children, title, node: _node, ...props }: MarkdownLinkProps) {
    const navigation = getHost().navigation;
    const itemLink = parseItemLinkHref(href);
    const webId = itemLink ? null : parseWebLinkHref(href);
    const webUrlAtom = useMemo(
        () => (webId ? selectAtom(externalReferenceMappingAtom, (pages) => pages[webId]?.url) : NO_WEB_URL),
        [webId],
    );
    const webUrl = useAtomValue(webUrlAtom);
    const reveal = itemLink?.kind === 'collection' ? navigation?.revealCollection : navigation?.revealObject;
    // Only a link the host can follow asks what its object is.
    const object = useLinkedObject(reveal ? itemLink : null);

    // What the link opens, and what its hover and icon say about it.
    let open: (() => void) | null = null;
    let linkTitle: string | undefined;
    let icon: IconComponent | null = null;
    if (itemLink) {
        if (reveal) {
            icon = objectIcon(object);
            linkTitle = 'Show in Zotero';
            // Resolved at click time, so rendering never touches the host's libraries.
            open = () => {
                const ref = resolveObjectIdReference(itemLink.objectId);
                if (ref) void reveal.call(navigation, ref);
            };
        }
    } else {
        const url = webId ? webUrl : href;
        const isHttp = !!url && isHttpUrl(url);
        if (navigation && url && !url.startsWith('#') && (isHttp || !webId)) {
            if (isHttp) icon = GlobeIcon;
            const target = url;
            linkTitle = target;
            open = () => navigation.openExternalUrl(target);
        }
    }

    const isFragment = !itemLink && !webId && !!href?.startsWith('#');
    if (!open && !isFragment) return <span className="markdown-link-text">{children}</span>;
    return (
        <a
            {...props}
            href={href}
            title={title ?? linkTitle}
            onClick={(event) => {
                event.preventDefault();
                open?.();
            }}
        >
            {icon && <LinkIcon icon={icon} />}
            {children}
        </a>
    );
}

export default MarkdownLink;
