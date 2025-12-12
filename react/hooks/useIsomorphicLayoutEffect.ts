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
 */
export const useIsomorphicLayoutEffect =
    typeof Zotero.getMainWindow() !== 'undefined' &&
    typeof Zotero.getMainWindow().document !== 'undefined' &&
    typeof Zotero.getMainWindow().document.createElement === 'function'
        ? useLayoutEffect
        : useEffect;

