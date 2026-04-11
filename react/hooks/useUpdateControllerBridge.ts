/**
 * Bridge hook for the src/ update controller.
 *
 * The update controller lives in the esbuild-bundled src/ layer and cannot
 * import Jotai (doing so would create a second Jotai instance with divergent
 * atom identities). This hook exposes the state it needs:
 *
 *   1. Mirrors `currentThreadIdAtom` to `Zotero.__beaverActiveThreadId` so
 *      `persistCurrentThread` can read the active thread synchronously when
 *      an update is about to install.
 *
 *   2. Dispatches a `sidebarVisibilityChange` CustomEvent on the window event
 *      bus whenever `isSidebarVisibleAtom` flips, so the update controller
 *      can retry deferred installs the moment the sidebar closes.
 */

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { isSidebarVisibleAtom } from "../atoms/ui";
import { currentThreadIdAtom } from "../atoms/threads";
import { eventManager } from "../events/eventManager";

export function useUpdateControllerBridge() {
  const currentThreadId = useAtomValue(currentThreadIdAtom);
  const isSidebarVisible = useAtomValue(isSidebarVisibleAtom);

  // Mirror the active thread ID onto the Zotero global so the esbuild
  // bundle can read it without importing Jotai.
  useEffect(() => {
    try {
      Zotero.__beaverActiveThreadId = currentThreadId;
    } catch {
      // Zotero may not be available during strict-mode double-invocation
      // or teardown — silently ignore.
    }
    return () => {
      // Don't clear on unmount — the updateController may still need to
      // read it during an onInstallStarted that fires between the
      // effect cleanup and the plugin shutdown. The next mount will
      // overwrite it with the fresh value.
    };
  }, [currentThreadId]);

  // Notify the src/ update controller when sidebar visibility flips.
  useEffect(() => {
    try {
      eventManager.dispatch("sidebarVisibilityChange", {
        isVisible: isSidebarVisible,
      });
    } catch {
      // Dispatch can fail if no main window is available (very early
      // mount or teardown race). Safe to ignore — the controller's
      // safety interval will pick up the change within 5 minutes.
    }
  }, [isSidebarVisible]);
}
