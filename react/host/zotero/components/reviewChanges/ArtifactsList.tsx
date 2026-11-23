import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { setToolExpandedAtom, toolExpandedAtom } from '../../../../atoms/messageUIState';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import { getReviewRowKey, noteIdentityKey, type NoteEditSummary, type ReviewRow } from '../reviewChangeRows';
import { NoteIcon, TableIcon } from '../../../../components/icons/icons';
import { CreatedNoteCard, EditedNoteCard } from './NoteArtifactCards';
import { TableArtifactRow } from './TableArtifactRow';
import { RunArtifactCard, RunArtifactToggleButton } from './RunArtifactCard';
import { groupArtifacts, groupCard, inAnswerOrder, type ArtifactEntry } from './runArtifacts';

interface ArtifactsListProps {
    /** From `useArtifactRows`: the notes the answer created. */
    rows: ReviewRow[];
    /** From `useTableArtifactRows`: the tables the answer wrote. */
    tableRows?: TableArtifact[];
    /** From `useEditedNoteArtifacts`: the notes the answer edited without creating them. */
    editedNotes?: NoteEditSummary[];
    /** The answer's tool-call order (`toolCallOrder`), which orders the notes as the answer wrote them. */
    order?: ReadonlyMap<string, number>;
}

function ArtifactCard({ entry }: { entry: ArtifactEntry }): React.ReactElement {
    if (entry.kind === 'createdNote') return <CreatedNoteCard row={entry.row} />;
    if (entry.kind === 'editedNote') return <EditedNoteCard summary={entry.summary} />;
    return <TableArtifactRow row={entry.row} />;
}

/**
 * Many artifacts of one kind as one card: how many, and what became of them.
 * A click unfolds their cards under it.
 */
function ArtifactGroupCard({ of, entries }: { of: ArtifactEntry['kind']; entries: ArtifactEntry[] }): React.ReactElement {
    // In the renderer's expansion state, like the other run cards: opening a
    // member moves the chat to the reader's sidebar, which mounts its own list.
    const expansionKey = `artifacts:${of}:${entries[0].key}`;
    const expanded = useAtomValue(useMemo(() => toolExpandedAtom(expansionKey), [expansionKey])) ?? false;
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const { headline, condition } = groupCard(of, entries);
    const toggle = () => setExpanded({ key: expansionKey, expanded: !expanded });
    return (
        <RunArtifactCard
            icon={of === 'table' ? TableIcon : NoteIcon}
            headline={headline}
            condition={condition}
            onActivate={toggle}
            activateLabel={`${expanded ? 'Hide' : 'Show'} ${headline}`}
            expanded={expanded}
            actions={<RunArtifactToggleButton expanded={expanded} onClick={toggle} />}
        >
            {expanded ? entries.map((entry) => <ArtifactCard key={entry.key} entry={entry} />) : null}
        </RunArtifactCard>
    );
}

/**
 * What a terminal run produced for the user to open: the notes it wrote or
 * edited and the tables it wrote, each as one card of the same shape (see
 * `RunArtifactCard`).
 *
 * Sits at the bottom of the run so an artifact is reachable from where the
 * answer ends, however long the answer is, and whatever else the run did.
 * That is the whole reason this is a surface of its own rather than a row
 * inside `ChangesCard`: a note folded into a count is buried exactly when the
 * run was busy enough to make finding it hard.
 *
 * A run can write a note per item, so a kind with many artifacts folds into
 * one group card that unfolds on a click (see `groupArtifacts`). The frame is
 * the list's: one artifact looks like a single bordered card.
 */
const NO_ORDER: ReadonlyMap<string, number> = new Map();

export const ArtifactsList: React.FC<ArtifactsListProps> = ({ rows, tableRows = [], editedNotes = [], order = NO_ORDER }) => {
    // Notes first, then tables: a created note may still wait for a decision,
    // and a table is already written when it appears. Created notes lead the
    // edited ones, as the answer's own writing.
    const entries: ArtifactEntry[] = [
        ...inAnswerOrder(rows, order).map((row): ArtifactEntry => ({ kind: 'createdNote', key: getReviewRowKey(row), row })),
        ...inAnswerOrder(editedNotes, order).map((summary): ArtifactEntry => ({
            kind: 'editedNote',
            key: `note:${noteIdentityKey(summary.note)}`,
            summary,
        })),
        ...tableRows.map((row): ArtifactEntry => ({
            kind: 'table',
            key: `table:${row.runId}:${row.toolcallId}`,
            row,
        })),
    ];

    if (entries.length === 0) return null;

    return (
        <div className="border-card rounded-card bg-senary overflow-hidden display-flex flex-col min-w-0">
            {groupArtifacts(entries).map((card, idx) => (
                <div key={card.key} className={idx > 0 ? 'border-top-quinary' : undefined}>
                    {card.kind === 'group' ? (
                        <ArtifactGroupCard of={card.of} entries={card.entries} />
                    ) : (
                        <ArtifactCard entry={card} />
                    )}
                </div>
            ))}
        </div>
    );
};

export default ArtifactsList;
