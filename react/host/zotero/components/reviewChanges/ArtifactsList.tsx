import React, { useState } from 'react';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import { getReviewRowKey, type ReviewRow } from '../reviewChangeRows';
import { ReviewActionRow } from './ReviewActionRow';
import { TableArtifactRow } from './TableArtifactRow';
import Button from '@beaver/agent-ui/primitives/Button';

/**
 * Rows shown before the `Show all (N)` affordance. Tighter than the changes
 * card's, which spends its rows only once the user has opened it — these are
 * on screen at the end of every run that wrote one.
 */
const MAX_VISIBLE_ROWS = 4;

interface ArtifactsListProps {
    /** From `useArtifactRows`; the caller derives them so it can skip an empty list. */
    rows: ReviewRow[];
    /** From `useTableArtifactRows`: the tables the answer wrote. */
    tableRows?: TableArtifact[];
}

type ArtifactEntry =
    | { kind: 'action'; key: string; row: ReviewRow }
    | { kind: 'table'; key: string; row: TableArtifact };

/**
 * What a terminal run produced for the user to open — the notes and tables it
 * wrote.
 *
 * Sits at the bottom of the run so a note is reachable from where the answer
 * ends, however long the answer is, and whatever else the run did. That is the
 * whole reason this is a surface of its own rather than a row inside
 * `ChangesCard`: a note folded into a count is buried exactly when the run was
 * busy enough to make finding it hard.
 *
 * Deliberately without the aggregate header the changes card carries. There is
 * no bulk operation to offer and no status worth summarizing — each row is one
 * artifact, already carrying its own title, preview, open and delete. One
 * artifact therefore looks like a single bordered row, which is what a run that
 * wrote one note should look like; the frame is the list's, not a card's.
 */
export const ArtifactsList: React.FC<ArtifactsListProps> = ({ rows, tableRows = [] }) => {
    const [showAllRows, setShowAllRows] = useState(false);

    // Notes first, then tables: the note rows carry apply/undo state the user
    // may still have to settle, and a table is already written when it appears.
    const entries: ArtifactEntry[] = [
        ...rows.map((row): ArtifactEntry => ({ kind: 'action', key: getReviewRowKey(row), row })),
        ...tableRows.map((row): ArtifactEntry => ({
            kind: 'table',
            key: `table:${row.runId}:${row.toolcallId}`,
            row,
        })),
    ];

    if (entries.length === 0) return null;

    // A batch job can write a note per item, so this list is unbounded in
    // principle. Same cap and affordance as the changes card — and for a run
    // that large the batch receipt above already reports the total.
    const visibleEntries = showAllRows ? entries : entries.slice(0, MAX_VISIBLE_ROWS);

    return (
        <div className="border-card rounded-card bg-senary overflow-hidden display-flex flex-col min-w-0">
            {visibleEntries.map((entry, idx) => (
                <div key={entry.key} className={idx > 0 ? 'border-top-quinary' : undefined}>
                    {entry.kind === 'action'
                        ? <ReviewActionRow row={entry.row} inGroup />
                        : <TableArtifactRow row={entry.row} />}
                </div>
            ))}

            {visibleEntries.length < entries.length && (
                <div className="display-flex flex-row px-2 py-2 border-top-quinary">
                    <Button variant="ghost-secondary" onClick={() => setShowAllRows(true)}>
                        {`Show all (${entries.length})`}
                    </Button>
                </div>
            )}
        </div>
    );
};

export default ArtifactsList;
