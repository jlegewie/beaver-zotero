import React from 'react';
import { useSetAtom } from 'jotai';
import { ExtractionTable, SearchResultsTable } from '@beaver/agent-ui/layouts';
import { ArrowLeftIcon } from '@beaver/agent-ui/icons';
import Button from '@beaver/agent-ui/primitives/Button';
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
 */
export default function TableWindowView({ surface }: { surface: TableSurface }): React.ReactElement {
    const showThread = useSetAtom(showThreadInWindowAtom);

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
                    <ExtractionTable table={table} subtitle={surface.subtitle} />
                ) : (
                    <SearchResultsTable table={table} subtitle={surface.subtitle} />
                )}
            </div>
        </div>
    );
}
