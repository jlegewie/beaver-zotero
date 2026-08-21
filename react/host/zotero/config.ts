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
    docsUrl(path: string) {
        // The webapp hosts the docs, and its base URL is substituted into the
        // bundle at build time, so it differs per build environment.
        return `${process.env.WEBAPP_BASE_URL}/docs/${path}`;
    },
    isImeCompositionOrderFixEnabled() {
        // Kill-switch pref: anything but an explicit `false` (including an
        // unset pref) leaves the workaround on.
        return getPref('imeCompositionOrderFix') !== false;
    },
    isImeTracingEnabled() {
        return getPref('debugImeTrace') === true;
    },
};
