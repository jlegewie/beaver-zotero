/**
 * Several windows can show one chat, each from its own copy of the session's
 * state. A command from any of them is checked against the session's state:
 * a card is answered once, and a Stop pressed for one run never stops the run
 * that has replaced it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: { auth: {} } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { createStore } from 'jotai/vanilla';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import { pendingCreditConfirmationsAtom } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    closeWSConnectionAtom,
    sendAskUserQuestionResponseAtom,
    sendCreditConfirmationResponseAtom,
} from '../../../src/services/agentRuns/runEngine';
import { installStoreRunSession } from '../../helpers/runSession';

function transport() {
    return {
        close: vi.fn(),
        cancel: vi.fn(async () => {}),
        isReattaching: () => false,
        isConnected: () => true,
        sendAskUserQuestionResponse: vi.fn(() => true),
        sendCreditConfirmationResponse: vi.fn(() => true),
    };
}

describe('commands from the windows that show a chat', () => {
    let store: ReturnType<typeof createStore>;
    let service: ReturnType<typeof transport>;

    beforeEach(() => {
        (globalThis as any).Zotero.Beaver = { ...((globalThis as any).Zotero.Beaver ?? {}), presence: undefined };
        store = createStore();
        service = transport();
        installStoreRunSession(store, { agentService: service as unknown as AgentService });
    });

    it('answer a question once, however many windows answer it', () => {
        store.set(pendingQuestionsAtom, new Map([['call-1', { toolcallId: 'call-1', questionId: 'q-1' } as any]]));
        const answer = { questionId: 'q-1', toolcallId: 'call-1', answers: [] };

        store.set(sendAskUserQuestionResponseAtom, answer);
        store.set(sendAskUserQuestionResponseAtom, answer);

        expect(service.sendAskUserQuestionResponse).toHaveBeenCalledOnce();
        expect(store.get(pendingQuestionsAtom).size).toBe(0);
    });

    it('answer a credit confirmation once', () => {
        store.set(pendingCreditConfirmationsAtom, new Map([['c-1', { confirmationId: 'c-1' } as any]]));

        store.set(sendCreditConfirmationResponseAtom, { confirmationId: 'c-1', approved: true });
        store.set(sendCreditConfirmationResponseAtom, { confirmationId: 'c-1', approved: false });

        expect(service.sendCreditConfirmationResponse).toHaveBeenCalledExactlyOnceWith('c-1', true, undefined);
    });

    it('stop only the run the Stop was pressed for', async () => {
        store.set(activeRunAtom, { id: 'run-2', status: 'in_progress', model_messages: [] } as any);

        await store.set(closeWSConnectionAtom, 'run-1');
        expect(service.cancel).not.toHaveBeenCalled();
        expect(store.get(activeRunAtom)?.id).toBe('run-2');

        await store.set(closeWSConnectionAtom, 'run-2');
        expect(service.cancel).toHaveBeenCalledOnce();

        // A message being prepared has no run yet: a Stop for an earlier run leaves it.
        store.set(activeRunAtom, null);
        await store.set(closeWSConnectionAtom, 'run-2');
        expect(service.cancel).toHaveBeenCalledOnce();
    });
});
