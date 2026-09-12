import type { MutationOptions } from '../../src/services/libraryMutations';
import type { LibraryOperationMap, LibraryOperationName } from '../../src/services/libraryOperations';
import { tryGetWindowRuntime } from './windowRuntime';

export function captureWindowMutationOptions(): MutationOptions {
    const runtime = tryGetWindowRuntime(true);
    const generation = Zotero.Beaver.account?.getGeneration();
    return { owner: runtime?.id, assertCurrent: () => {
        if (runtime?.status === 'closing') throw Object.assign(new Error('Window closed'), { code: 'operation_cancelled' });
        if (generation !== Zotero.Beaver.account?.getGeneration()) throw Object.assign(new Error('Account changed'), { code: 'account_changed' });
    } };
}

/** Dispatch data, never a renderer-owned async write callback. */
export function runWindowOperation<K extends LibraryOperationName>(
    name: K, args: Parameters<LibraryOperationMap[K]>, options = captureWindowMutationOptions(),
): ReturnType<LibraryOperationMap[K]> {
    return Zotero.Beaver.libraryOperations.run(name, args, options);
}
