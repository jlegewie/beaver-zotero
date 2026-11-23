import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import {
    agentActionItemTitleAtom,
    annotationAttachmentTitleAtom,
    resetMessageUIStateAtom,
    setAgentActionItemTitleAtom,
    setAnnotationAttachmentTitleAtom,
} from '../../../react/atoms/messageUIState';

describe('keyed title caches', () => {
    it('stores a title under its key and reads null for a key never written', () => {
        const store = createStore();
        store.set(setAgentActionItemTitleAtom, { key: 'run-1:call-1', title: 'Smith 2020' });

        expect(store.get(agentActionItemTitleAtom('run-1:call-1'))).toBe('Smith 2020');
        expect(store.get(agentActionItemTitleAtom('run-1:call-2'))).toBeNull();
    });

    it('reads null for a null key', () => {
        const store = createStore();
        expect(store.get(agentActionItemTitleAtom(null))).toBeNull();
    });

    it('notifies only the readers of the key that was written', () => {
        const store = createStore();
        const first = vi.fn();
        const second = vi.fn();
        store.sub(agentActionItemTitleAtom('run-1:call-1'), first);
        store.sub(agentActionItemTitleAtom('run-1:call-2'), second);

        store.set(setAgentActionItemTitleAtom, { key: 'run-1:call-1', title: 'Smith 2020' });

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('keeps one atom per key, so a reader sees later writes', () => {
        expect(agentActionItemTitleAtom('run-1:call-1')).toBe(agentActionItemTitleAtom('run-1:call-1'));

        const store = createStore();
        const reader = agentActionItemTitleAtom('run-1:call-3');
        store.set(setAgentActionItemTitleAtom, { key: 'run-1:call-3', title: 'Doe 2019' });
        expect(store.get(reader)).toBe('Doe 2019');
    });

    it('keeps annotation and agent-action titles apart', () => {
        const store = createStore();
        store.set(setAnnotationAttachmentTitleAtom, { key: 'call-1', title: 'Attachment' });

        expect(store.get(annotationAttachmentTitleAtom('call-1'))).toBe('Attachment');
        expect(store.get(agentActionItemTitleAtom('call-1'))).toBeNull();
    });

    it('clears every title when the thread-local UI state is reset', () => {
        const store = createStore();
        const agentReader = agentActionItemTitleAtom('run-1:call-4');
        const annotationReader = annotationAttachmentTitleAtom('call-4');
        store.set(setAgentActionItemTitleAtom, { key: 'run-1:call-4', title: 'Smith 2020' });
        store.set(setAnnotationAttachmentTitleAtom, { key: 'call-4', title: 'Attachment' });

        store.set(resetMessageUIStateAtom);

        expect(store.get(agentReader)).toBeNull();
        expect(store.get(annotationReader)).toBeNull();
        expect(store.get(agentActionItemTitleAtom('run-1:call-4'))).toBeNull();
        expect(store.get(annotationAttachmentTitleAtom('call-4'))).toBeNull();
    });
});
