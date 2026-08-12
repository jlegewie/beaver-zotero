import { getPref } from '../../../src/utils/prefs';
import type { ConfigHost } from '@beaver/agent-ui/host/types';

/** Zotero implementation of {@link ConfigHost} — reads Beaver prefs. */
export const zoteroConfig: ConfigHost = {
    citationFormat() {
        return getPref('citationFormat') === 'numeric' ? 'numeric' : 'author-year';
    },
    usePageLabels() {
        return getPref('usePageLabels') !== false;
    },
    isDevelopment() {
        return Zotero.Beaver?.data?.env === 'development';
    },
};
