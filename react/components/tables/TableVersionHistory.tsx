import React from 'react';
import { VersionHistory, type TableVersionListEntry } from '@beaver/agent-ui/layouts';
import { getTablesApi } from '../../../src/services/artifacts/tablesApi';
import type { TableRef, TableVersionEntry } from '../../../src/services/artifacts/tableItemIdentity';
import { revertFailureMessage, tableActionErrorMessage } from '../../../src/ui/tableDocumentActions';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';

/** A log entry as the version list shows it: its size from the stored summary. */
export function toVersionListEntry(entry: TableVersionEntry): TableVersionListEntry {
    const summary = entry.summary as TableVersionEntry['summary'] | undefined;
    const detail = summary?.columns_detail;
    return {
        version: entry.version,
        change: entry.change,
        actor: entry.actor,
        at: entry.at,
        ...(typeof summary?.rows === 'number' ? { items: summary.rows } : {}),
        ...(detail ? { columns: Object.values(detail).filter((column) => !column.system).length } : {}),
    };
}

interface TableVersionHistoryProps {
    tableRef: TableRef;
    /** The version the tab shows. */
    currentVersion: number;
    /**
     * Changes whenever the tab re-reads the table, so the list follows writes
     * that kept the version number (a fill's writes collapse into one version).
     */
    reloadKey: unknown;
    /** Set where the library is read-only: versions are listed but not restorable. */
    readOnly: boolean;
    /** Why restoring is unavailable for now (a fill is running). */
    restoreDisabledReason?: string;
}

/**
 * The table tab's Version history panel: loads the table's version log through
 * this window's table commands and restores a version as a new one. The tab
 * re-reads the table after a restore, which reloads this list.
 */
export function TableVersionHistory({
    tableRef,
    currentVersion,
    reloadKey,
    readOnly,
    restoreDisabledReason,
}: TableVersionHistoryProps): React.ReactElement {
    const win = useSurfaceWindow();
    const [versions, setVersions] = React.useState<TableVersionListEntry[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<string | null>(null);
    const [restoring, setRestoring] = React.useState<number | null>(null);
    const { libraryID, key } = tableRef;

    const commands = React.useCallback(() => {
        if (!win || win.closed) throw new Error('The originating window is closed.');
        const api = getTablesApi();
        if (!api) throw new Error('Version history is unavailable right now.');
        return api.local.commands(win);
    }, [win]);

    React.useEffect(() => {
        let live = true;
        const ref = { libraryID, key };
        (async () => {
            try {
                const entries = await commands().history(ref);
                if (!live) return;
                setVersions(entries.map(toVersionListEntry));
                setError(null);
            } catch (failure) {
                if (live) setError(tableActionErrorMessage(failure, ref));
            }
        })();
        return () => {
            live = false;
        };
    }, [libraryID, key, currentVersion, reloadKey, commands]);

    const restore = async (version: number) => {
        const ref = { libraryID, key };
        setRestoring(version);
        setError(null);
        setStatus(null);
        try {
            const result = await commands().revert(ref, version);
            if (!result.ok) {
                setError('The table changed while restoring, so nothing was restored. Check the updated history and try again.');
            } else {
                setStatus(
                    result.saved
                        ? `Restored version ${version} as version ${result.version}.`
                        : `Restored version ${version} as version ${result.version}, but its version history could not be updated. Reopen the table to repair it; do not restore again.`,
                );
            }
        } catch (failure) {
            setError(revertFailureMessage(failure, ref));
        } finally {
            setRestoring(null);
        }
    };

    return (
        <VersionHistory
            versions={versions}
            currentVersion={currentVersion}
            onRestore={readOnly ? undefined : (version) => void restore(version)}
            restoring={restoring}
            restoreDisabledReason={restoreDisabledReason}
            status={status}
            error={error}
            note={readOnly ? 'This library is read-only, so versions cannot be restored here.' : undefined}
        />
    );
}
