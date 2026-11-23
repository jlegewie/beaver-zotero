import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { TableRef } from '../../../../../src/services/artifacts/tableItemIdentity';
import { libraryScopeInitializedAtom, searchableLibraryIdsAtom } from '../../../../atoms/profile';
import { useTableFillJob } from '../../../../components/tables/TableFillControl';
import { resolveTableReceipt, resolveTableRef, subscribeTableChanges } from '../../tables';
import type { TableReceiptLive } from './tableReceipt';

/** A ref no table has, so the job hook can run before the key resolves. */
const NO_TABLE: TableRef = { libraryID: -1, key: '' };

export interface TableReceiptState {
    /** The local table, or null when its library is not on this device. */
    ref: TableRef | null;
    live: TableReceiptLive | undefined;
    job: TableFillJobSnapshot | null;
}

/**
 * The live state behind a table receipt: the table as it is now (re-read on
 * every change to it and to the library scope) and its fill job.
 */
export function useTableReceiptState(key: string): TableReceiptState {
    const ref = useMemo(() => resolveTableRef(key), [key]);
    const [live, setLive] = useState<TableReceiptLive>();
    const job = useTableFillJob(ref ?? NO_TABLE);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const scopeReady = useAtomValue(libraryScopeInitializedAtom);

    // Another table starts unread; a scope change keeps the row while it is read again.
    useEffect(() => setLive(undefined), [key]);
    // The library scope decides whether the table may be filled, so it is read
    // again when the scope changes, as on every change to the table.
    useEffect(() => {
        let active = true;
        let generation = 0;
        const refresh = async () => {
            const request = ++generation;
            const next = await resolveTableReceipt(key).catch(
                (): TableReceiptLive => ({ status: 'unavailable', reason: 'Table provider unavailable.' }),
            );
            if (active && generation === request) setLive(next);
        };
        const unsubscribeTable = subscribeTableChanges(key, () => void refresh());
        void refresh();
        return () => {
            active = false;
            unsubscribeTable();
        };
    }, [key, searchableLibraryIds, scopeReady]);

    return { ref, live, job };
}
