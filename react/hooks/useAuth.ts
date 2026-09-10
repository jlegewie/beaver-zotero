import { useAtomValue } from 'jotai';
import { authLoadingAtom } from '../atoms/auth';
import { credentials } from '@beaver/agent-core/transport/credentials';

/** Auth is projected synchronously when the renderer attaches. */
export function useAuth() {
    return { loading: useAtomValue(authLoadingAtom), signOut: () => credentials.signOut() };
}
