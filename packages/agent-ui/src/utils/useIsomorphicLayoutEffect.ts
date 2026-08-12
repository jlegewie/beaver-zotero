import { useEffect, useLayoutEffect } from 'react';

/**
 * Isomorphic layout effect that works in both client and SSR contexts.
 *
 * Uses useLayoutEffect on client (avoids visual flicker by running synchronously
 * after DOM mutations but before paint) and useEffect during SSR (where
 * useLayoutEffect would throw a warning since there's no DOM to layout).
 *
 * Note: During SSR (e.g., renderToStaticMarkup), effects don't run at all.
 * This hook only suppresses the warning; SSR components should handle
 * the no-effect case via synchronous fallbacks in their render logic.
 *
 * The `typeof document` test is a feature detect for "is there a DOM at all",
 * not a window lookup: it must not throw when no document exists, which is the
 * entire case it is testing for. Components still reach their actual document
 * through an element's `ownerDocument`, never through this global.
 */
export const useIsomorphicLayoutEffect =
    typeof document !== 'undefined' && typeof document.createElement === 'function'
        ? useLayoutEffect
        : useEffect;
