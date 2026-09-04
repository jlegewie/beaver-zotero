import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';

const mocks = vi.hoisted(() => ({
    changesRows: [
        { runId: 'run-1', toolcallId: 'call-1', actions: [{ run_id: 'run-1' }] },
        { runId: 'run-2', toolcallId: 'call-2', actions: [{ run_id: 'run-2' }] },
    ],
    useChangesRows: vi.fn(),
    useArtifactRows: vi.fn(),
    changesCard: vi.fn(),
}));

vi.mock('jotai', () => ({
    useAtomValue: () => () => [],
}));

vi.mock('../../../react/agents/agentActions', () => ({
    getAgentActionsByRunAtom: {},
    isCreateItemAgentAction: () => false,
}));

vi.mock('../../../react/host/zotero/components/reviewChanges/useRunActionRows', () => ({
    useChangesRows: (runIds: string[]) => {
        mocks.useChangesRows(runIds);
        return mocks.changesRows;
    },
    useArtifactRows: (runIds: string[]) => {
        mocks.useArtifactRows(runIds);
        return [];
    },
}));

vi.mock('../../../react/host/zotero/components/reviewChanges/ChangesCard', () => ({
    default: (props: unknown) => {
        mocks.changesCard(props);
        return null;
    },
}));

vi.mock('../../../react/host/zotero/components/reviewChanges/ArtifactsList', () => ({
    default: () => null,
}));

vi.mock('../../../react/host/zotero/components/CreateItemAgentActionDisplay', () => ({
    default: () => null,
}));

import { AgentActionsReview } from '../../../react/host/zotero/components/AgentActionsReview';

describe('AgentActionsReview continuation chains', () => {
    it('renders one changes card containing rows from every run', () => {
        const runs = [
            { id: 'run-1', status: 'error' },
            { id: 'run-2', status: 'completed' },
        ] as AgentRun[];

        renderToStaticMarkup(React.createElement(AgentActionsReview, { runs }));

        expect(mocks.useChangesRows).toHaveBeenCalledWith(['run-1', 'run-2']);
        expect(mocks.changesCard).toHaveBeenCalledTimes(1);
        expect(mocks.changesCard).toHaveBeenCalledWith({
            runId: 'run-2',
            rows: mocks.changesRows,
        });
    });
});
