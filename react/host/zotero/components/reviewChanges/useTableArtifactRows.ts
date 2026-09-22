import { useMemo } from 'react';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { collectTableArtifacts, type TableArtifact } from '@beaver/agent-core/run-state/tableResults';

/**
 * The tables an answer wrote, for `ArtifactsList`. Derived from the runs'
 * tool returns rather than from agent actions: a table write is committed by
 * the provider as the call runs, so it never passes through the approval
 * ledger the note rows are built from.
 */
export function useTableArtifactRows(runs: AgentRun[]): TableArtifact[] {
    return useMemo(() => collectTableArtifacts(runs), [runs]);
}
