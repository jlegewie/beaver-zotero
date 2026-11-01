/**
 * What the table tab looks up in Zotero beyond the stored spec: the names and
 * kinds of the documents its rows read, and the papers its sources hold that
 * the table does not. Both are worked out when the table is shown and
 * whenever the library changes under it, never stored, and handed to the
 * shared surface as props.
 */

import React from 'react';
import type { Row, TableSpec } from '@beaver/agent-core/layouts/table';
import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import type { NewPapersNotice, TableDocumentInfo } from '@beaver/agent-ui/layouts';
import { getReadableContentKind } from '../../../src/services/documentExtraction/attachmentResolution';
import { isLibrarySearchable } from '../../../src/services/agentDataProvider/utils';
import { safeAttachmentFilename } from '../../../src/utils/attachmentFiles';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { resolveLibraryScopeIds } from './card/liveSources';

/** Every document id a row or its cells name, evidence and replaced answers included. */
export function tableDocumentIds(spec: TableSpec | null): string[] {
    const ids = new Set<string>();
    const add = (list?: string[]) => list?.forEach((id) => ids.add(id));
    for (const row of spec?.rows ?? []) {
        add(row.documents);
        for (const cell of Object.values(row.cells)) {
            add(cell.documents);
            cell.evidence?.forEach((entry) => ids.add(entry.document));
            if (cell.replaced) {
                add(cell.replaced.documents);
                cell.replaced.evidence?.forEach((entry) => ids.add(entry.document));
            }
        }
    }
    return [...ids].sort();
}

/**
 * A document's file name and kind, from the attachment's metadata (no file is
 * opened). Undefined for a document this device does not have. Local only:
 * the names render in the user's own tab, so an excluded library is looked up
 * like any other (exclusion is not a UI restriction).
 */
async function describeDocument(id: string): Promise<TableDocumentInfo | undefined> {
    const parsed = parseItemReference(id);
    const libraryID = parsed ? resolveLibraryRef(parsed) : null;
    if (!parsed || !libraryID) return undefined;
    const item = (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, parsed.zotero_key)) as Zotero.Item | false;
    if (!item || !item.isAttachment()) return undefined;
    const kind = getReadableContentKind(item) ?? undefined;
    let title = '';
    try {
        title = item.getField('title') as string;
    } catch {
        title = '';
    }
    return { name: safeAttachmentFilename(item) || title || 'Document', ...(kind ? { kind } : {}) };
}

/** Calls `onChange` once a burst of item changes in Zotero settles. */
function useLibraryChanges(enabled: boolean, types: _ZoteroTypes.Notifier.Type[], onChange: () => void): void {
    const callback = React.useRef(onChange);
    callback.current = onChange;
    const key = types.join(',');
    React.useEffect(() => {
        if (!enabled) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // An app-lifetime registry: the observer leaves with the tab.
        const id = Zotero.Notifier.registerObserver(
            {
                notify: (event: string) => {
                    if (!['add', 'modify', 'delete', 'trash', 'remove', 'move'].includes(event)) return;
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => callback.current(), 600);
                },
            },
            key.split(',') as _ZoteroTypes.Notifier.Type[],
            'beaver-table-tab-data',
        );
        return () => {
            if (timer) clearTimeout(timer);
            Zotero.Notifier.unregisterObserver(id);
        };
    }, [enabled, key]);
}

/** The table's documents, keyed by document id, as the shared surface reads them. */
export function useTableDocuments(spec: TableSpec | null): ReadonlyMap<string, TableDocumentInfo> {
    const ids = React.useMemo(() => tableDocumentIds(spec).join('\n'), [spec]);
    const [documents, setDocuments] = React.useState<ReadonlyMap<string, TableDocumentInfo>>(new Map());
    const [changed, setChanged] = React.useState(0);
    useLibraryChanges(!!ids, ['item'], () => setChanged((n) => n + 1));
    React.useEffect(() => {
        if (!ids) {
            setDocuments(new Map());
            return;
        }
        let live = true;
        void (async () => {
            const found = new Map<string, TableDocumentInfo>();
            for (const id of ids.split('\n')) {
                try {
                    const info = await describeDocument(id);
                    if (info) found.set(id, info);
                } catch {
                    // A document that cannot be looked up is shown without its name.
                }
            }
            if (live) setDocuments(found);
        })();
        return () => {
            live = false;
        };
    }, [ids, changed]);
    return documents;
}

/** The portable id of a row's own item, as a source's population names it. */
function rowItemId(row: Row): string | undefined {
    const ref = row.ref;
    return ref?.kind === 'item' ? `${ref.library_ref}-${ref.zotero_key}` : undefined;
}

/** Papers the table's library sources hold that it does not. */
export interface NewPapers {
    /** The toolbar's notice; null when no source has new papers. */
    notice: NewPapersNotice | null;
    /** New papers by source id, for the sources popover and the notice's Add. */
    bySource: ReadonlyMap<string, number>;
}

const NO_NEW_PAPERS: NewPapers = { notice: null, bySource: new Map() };

/**
 * Papers the table's library sources (collections, tags, saved searches) hold
 * that it does not: what refreshing them would add. Papers the user removed
 * from the table stay out, as a refresh skips them. A source in a library
 * Beaver may not read is not offered.
 */
export function useNewPapers(spec: TableSpec | null): NewPapers {
    const sources = React.useMemo(
        () => (spec?.sources ?? []).filter((source) => source.type === 'library' && source.scope),
        [spec?.sources],
    );
    const sourcesKey = JSON.stringify(sources);
    const rowsKey = React.useMemo(
        () => (spec?.rows ?? []).map(rowItemId).filter(Boolean).sort().join(','),
        [spec?.rows],
    );
    // The spec's list of removed papers (written by the table engine).
    const removedKey = JSON.stringify(spec?.removed ?? []);
    const [found, setFound] = React.useState<NewPapers>(NO_NEW_PAPERS);
    const [changed, setChanged] = React.useState(0);
    useLibraryChanges(sources.length > 0, ['item', 'collection-item', 'item-tag'], () => setChanged((n) => n + 1));

    React.useEffect(() => {
        if (!sources.length) {
            setFound(NO_NEW_PAPERS);
            return;
        }
        let live = true;
        void (async () => {
            const inTable = new Set(rowsKey ? rowsKey.split(',') : []);
            const removed = new Set<string>();
            for (const entry of JSON.parse(removedKey) as Array<{ ref?: unknown }>) {
                const ref = entry.ref as { library_ref?: string; zotero_key?: string } | string | undefined;
                if (typeof ref === 'string') removed.add(ref);
                else if (ref?.library_ref && ref.zotero_key) removed.add(`${ref.library_ref}-${ref.zotero_key}`);
            }
            const fresh = new Set<string>();
            const bySource = new Map<string, number>();
            let withNew = 0;
            let firstName: string | undefined;
            for (const source of sources) {
                const scope = source.scope!;
                const libraryID = resolveLibraryRef({ library_ref: scope.library_ref });
                if (!libraryID || !isLibrarySearchable(libraryID)) continue;
                try {
                    const found = await resolveLibraryScopeIds(scope);
                    if (!found.ok) continue;
                    const added = found.ids.filter((id) => !inTable.has(id) && !removed.has(id));
                    if (!added.length) continue;
                    withNew += 1;
                    bySource.set(source.id, added.length);
                    firstName ??= scope.name ?? found.response.collection_names?.[0] ?? scope.tag ?? undefined;
                    added.forEach((id) => fresh.add(id));
                } catch {
                    // A source that cannot be resolved offers nothing.
                }
            }
            if (!live) return;
            setFound({
                notice: fresh.size ? { count: fresh.size, sources: withNew, ...(firstName ? { sourceName: firstName } : {}) } : null,
                bySource,
            });
        })();
        return () => {
            live = false;
        };
    }, [sourcesKey, rowsKey, removedKey, changed]);
    return found;
}
