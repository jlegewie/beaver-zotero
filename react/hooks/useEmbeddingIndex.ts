import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { embeddingIndexStateAtom } from '../atoms/embeddingIndex';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/** Project instance index state with subscriptions revoked synchronously on window close. */
export function useEmbeddingIndex(): void {
    const setState = useSetAtom(embeddingIndexStateAtom);
    useEffect(() => {
        const runtime = tryGetWindowRuntime();
        const background = Zotero.Beaver.background;
        if (!runtime || !background) return;
        const unsubscribe = Zotero.Beaver.runtime.subscribeWindow(runtime, 'embedding-index:status', setState);
        setState(background.getSnapshot());
        return unsubscribe;
    }, [setState]);
}
