import React, { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { citationsAtom, processCitationsAtom } from '@beaver/agent-core/citations/atoms';
import { ExtractionTable, SearchResultsTable } from '@beaver/agent-ui/layouts';
import { ArrowLeftIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import { showThreadInWindowAtom, type WindowSurface } from '../../atoms/windowSurface';

type TableSurface = Extract<WindowSurface, { kind: 'table' }>;

/**
 * A table filling the separate Beaver window.
 *
 * The window is the table's working surface: full width, its own scroll, and
 * nothing of the thread around it except the way back. Which chrome the table
 * gets is the surface's decision (`variant`); the grid underneath is the same
 * component either way.
 *
 * Row verbs — reveal, open, import — arrive through the registered Zotero host
 * and so work here without wiring. Verbs that would need a producer behind them
 * (export, save to library, re-running a column) are deliberately not passed:
 * an absent callback renders no control, which is the point.
 *
 * Cell text goes through the same renderer the chat uses, so a `<citation …/>`
 * tag in a cell becomes the same marker it would be in a message: the tooltip,
 * the preview and the click-through to the cited passage are the component's,
 * not a second implementation of them.
 */
const renderCellText = (text: string) => (
    <MarkdownRenderer content={text} className="bt-md" />
);

export default function TableWindowView({ surface }: { surface: TableSurface }): React.ReactElement {
    const showThread = useSetAtom(showThreadInWindowAtom);
    const addCitations = useSetAtom(citationsAtom);
    const processCitations = useSetAtom(processCitationsAtom);
    const citations = surface.table.citations;

    // A `TableSpec` carries its own citations; the `Citation` component reads
    // the thread's store. Contributing them to it is what makes a marker in a
    // cell resolve to the same tooltip, number and click-through it would have
    // in a message — rather than a second implementation of all three.
    //
    // Merged, never assigned: the store is shared with the thread the window
    // came from, and replacing it would strip that thread of its own sources.
    useEffect(() => {
        if (!citations?.length) return;
        addCitations((current) => {
            const known = new Set(current.map((c) => c.citation_id));
            const added = citations.filter((c) => !known.has(c.citation_id));
            return added.length ? [...current, ...added] : current;
        });
        processCitations();
    }, [citations, addCitations, processCitations]);

    const table = surface.title ? { ...surface.table, title: surface.title } : surface.table;

    return (
        <div className="display-flex flex-col h-full w-full min-w-0 min-h-0">
            <div className="display-flex flex-row gap-2 px-3 py-2 border-bottom-quinary flex-shrink-0">
                <Button variant="ghost-secondary" icon={ArrowLeftIcon} onClick={() => showThread()}>
                    Back to chat
                </Button>
            </div>

            <div className="flex-1 min-h-0 min-w-0">
                {surface.variant === 'extraction' ? (
                    <ExtractionTable
                        table={table}
                        subtitle={surface.subtitle}
                        renderText={renderCellText}
                    />
                ) : (
                    <SearchResultsTable
                        table={table}
                        subtitle={surface.subtitle}
                        renderText={renderCellText}
                    />
                )}
            </div>
        </div>
    );
}
