import { threadNavigationSeqAtom } from '../atoms/threads';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';

/** Start a reader-action draft, retaining a guard for its asynchronous preparation. */
export async function beginReaderActionThread(
    newThread: (options: { skipAutoPopulate: boolean }) => Promise<void>,
): Promise<(() => boolean) | null> {
    const beforeNavigation = store.get(threadNavigationSeqAtom);
    await newThread({ skipAutoPopulate: true });
    const navigation = store.get(threadNavigationSeqAtom);
    // A cancelled new-thread confirmation leaves the navigation sequence unchanged.
    if (navigation === beforeNavigation) return null;
    return () => !!tryGetWindowRuntime() && store.get(threadNavigationSeqAtom) === navigation;
}
