import React, { useCallback, useState } from 'react';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import { getHost } from '@beaver/agent-ui/host';
import { CsvIcon, XlsIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import { getTablesApi } from '../../../../../src/services/artifacts/tablesApi';
import { exportTable, tableActionErrorMessage, type TableExportFormat } from '../../../../../src/ui/tableDocumentActions';
import { StopStrokeIcon, TableIcon } from '../../../../components/icons/icons';
import { FillProgressRule } from '../../../../components/tables/FillProgressRule';
import { useSurfaceWindow } from '../../../../runtime/SurfaceWindowContext';
import { RunArtifactCard, RunArtifactExportButton, RunArtifactOpenButton } from './RunArtifactCard';
import { tableReceiptModel } from './tableReceipt';
import { useTableReceiptState } from './useTableReceiptState';

interface TableArtifactRowProps {
    row: TableArtifact;
}

const UNDONE_MESSAGE = 'Undone. The table is back to the version before this edit.';

/**
 * One table in the artifacts list: the receipt of what the answer did to it.
 *
 * Two lines (see `tableReceiptModel`): the table, or what the answer changed
 * about it, then its condition as it is now, including what is left to fill.
 * Filling happens in the table itself, whose Fill shows the plan and its
 * cost. The card offers Undo on an edit, Stop while a fill runs, and, like a
 * note's card, Export and Open as icons; a click anywhere on it opens the
 * table.
 */
export const TableArtifactRow: React.FC<TableArtifactRowProps> = ({ row }) => {
    const { record } = row;
    const key = record.reference.key;
    const { ref, live, job } = useTableReceiptState(key);
    const surfaceWindow = useSurfaceWindow();
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState<'export' | 'undo' | null>(null);
    const [undone, setUndone] = useState(false);
    const host = getHost();

    const model = tableReceiptModel({
        record,
        created: row.created,
        live,
        job,
        undoAvailable: !undone && !!host.navigation?.undoTableEdit,
    });

    // The table opens beside the surface that was clicked.
    const handleOpen = useCallback(async (event: React.SyntheticEvent) => {
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        const open = getHost().navigation?.openTable;
        if (!open) {
            setMessage('Table provider unavailable.');
            return;
        }
        const outcome = await open(key, origin, { onDownload: () => setMessage('Downloading table…') })
            .catch(() => ({ error: 'Table provider unavailable.' }));
        // The host reports a table that cannot be opened.
        setMessage('error' in outcome ? '' : (outcome.warning ?? ''));
    }, [key]);

    // The same export as the table's own: a save dialog, then the table as it
    // is when the dialog closes, in the table's order.
    const handleExport = useCallback(async (format: TableExportFormat) => {
        const api = getTablesApi();
        if (!ref || !api) {
            setMessage('Export is unavailable right now.');
            return;
        }
        setBusy('export');
        setMessage('');
        try {
            await exportTable(surfaceWindow, ref, () => api.local.commands(surfaceWindow), format);
        } catch (error) {
            setMessage(tableActionErrorMessage(error, ref));
        } finally {
            setBusy(null);
        }
    }, [ref, surfaceWindow]);

    const handleStop = useCallback(() => {
        if (job) Zotero.Beaver.tableFills?.stop(job.job_id);
    }, [job]);

    const handleUndo = useCallback(async (event: React.SyntheticEvent) => {
        const undo = getHost().navigation?.undoTableEdit;
        if (!undo || typeof record.version !== 'number') return;
        const origin = (event.currentTarget as Element).ownerDocument?.defaultView ?? null;
        setBusy('undo');
        const outcome = await undo(key, { version: record.version, runId: row.recordRunId }, origin)
            .catch(() => ({ error: 'Table provider unavailable.' }));
        setBusy(null);
        // A refusal keeps the button: a running fill may end, and a refused
        // Undo is refused again without harm.
        if (!('error' in outcome)) setUndone(true);
        setMessage('error' in outcome ? outcome.error : UNDONE_MESSAGE);
    }, [key, record.version, row.recordRunId]);

    const exportItems = [
        { label: 'Excel…', icon: XlsIcon, onClick: () => void handleExport('xlsx') },
        { label: 'CSV…', icon: CsvIcon, onClick: () => void handleExport('csv') },
    ];

    return (
        <RunArtifactCard
            icon={TableIcon}
            headline={model.headline}
            condition={model.condition}
            warning={model.warning}
            muted={model.muted}
            onActivate={model.open ? (event) => void handleOpen(event) : undefined}
            activateLabel={`Open table ${model.title}`}
            top={model.stop && job ? <FillProgressRule job={job} /> : undefined}
            message={message}
            actions={
                <>
                    {model.undo && (
                        <Button
                            variant="ghost-secondary"
                            onClick={(event) => void handleUndo(event as React.SyntheticEvent)}
                            disabled={busy !== null}
                            loading={busy === 'undo'}
                            className="flex-none whitespace-nowrap"
                        >
                            Undo
                        </Button>
                    )}
                    {model.stop && (
                        <Button
                            variant="outline"
                            rightIcon={StopStrokeIcon}
                            ariaLabel="Stop fill"
                            onClick={handleStop}
                            disabled={job?.state === 'stopping'}
                            className="flex-none whitespace-nowrap"
                        >
                            Stop
                        </Button>
                    )}
                    {model.export && <RunArtifactExportButton items={exportItems} exporting={busy === 'export'} />}
                    {model.open && <RunArtifactOpenButton label="Open table" onClick={(event) => void handleOpen(event)} />}
                </>
            }
        />
    );
};

export default TableArtifactRow;
