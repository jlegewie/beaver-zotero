import { threadNavigationSeqAtom } from '../atoms/threads';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';

/** Start a reader-action draft, retaining a guard for its asynchronous preparation. */
export async function beginReaderActionThread(
    newThread: (options: { skipAutoPopulate: boolean }) => Promise<number | undefined>,
): Promise<(() => boolean) | null> {
    const navigation = await newThread({ skipAutoPopulate: true });
    // Cancellation or superseding navigation does not return a committed token.
    if (navigation === undefined) return null;
    const isCurrent = () => !!tryGetWindowRuntime() && store.get(threadNavigationSeqAtom) === navigation;
    return isCurrent() ? isCurrent : null;
}
