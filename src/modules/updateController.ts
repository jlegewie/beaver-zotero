/**
 * Update controller: intercepts Mozilla AddonManager plugin updates for Beaver
 * and defers them while the Beaver sidebar is visible.
 *
 * ## Design
 *
 * Zotero 7 uses Mozilla's AddonManager to auto-update bootstrapped plugins. When
 * an update is discovered, the AOM downloads the XPI and immediately calls
 * `shutdown({reason: ADDON_UPGRADE})` → `startup({reason: ADDON_UPGRADE})` on
 * the live plugin, which tears down the Beaver React UI mid-session — the user
 * experiences the sidebar "suddenly closing" while mid-thread.
 *
 * This module registers an `AddonManager.InstallListener`. When `onInstallStarted`
 * fires for our addon, we:
 *   1. Persist the currently-loaded thread ID to `pendingDeferredThread` pref so
 *      the new plugin instance can restore it on startup.
 *   2. If the Beaver sidebar is currently visible, return `false` to cancel the
 *      install and mark it as deferred.
 *   3. Otherwise return `true` and let the upgrade proceed normally.
 *
 * We re-attempt deferred updates from two event sources:
 *   - A `sidebarVisibilityChange` CustomEvent dispatched by the React bundle on
 *     the window event bus when `isSidebarVisibleAtom` flips.
 *   - A 5-minute `setInterval` safety net that catches cases where the event
 *     bus is detached or a listener was missed.
 *
 * ## Cross-bundle boundary
 *
 * This file lives in the esbuild-bundled src/ layer, which must NOT import
 * Jotai (doing so would create a second Jotai instance with divergent atom
 * identities). We therefore:
 *   - Read sidebar visibility from the DOM (toolbar button `selected` attr
 *     across all main windows, with pane display-style fallback).
 *   - Read the active thread ID from `Zotero.__beaverActiveThreadId`, which is
 *     mirrored from `currentThreadIdAtom` by `useActiveThreadBridge` in the
 *     React bundle.
 *
 * ## Cleanup
 *
 * `disposeUpdateController` must be called from `onMainWindowUnload`'s global
 * cleanup branch. It unregisters the install listener, removes the event bus
 * listeners from every tracked window, and clears the retry interval. It does
 * NOT clear the `pendingDeferredThread` pref — that's consumed by the next
 * plugin instance on startup.
 */

let AddonManagerMod: any = null;
let installListener: any = null;
let storedAddon: any = null;
let safetyInterval: ReturnType<typeof setInterval> | null = null;
let updateDeferred = false;
let inFlightFindUpdates = false;

// Tracked event bus subscriptions, one per main window we attach to.
type SidebarBusHandler = (event: Event) => void;
const sidebarBusSubs: Array<{ bus: EventTarget; handler: SidebarBusHandler }> =
  [];

/** Max age for a persisted thread to be considered fresh enough to restore. */
const DEFER_WINDOW_MS = 10 * 60 * 1000;
/** Safety-net retry cadence. */
const SAFETY_INTERVAL_MS = 5 * 60 * 1000;
/** Small debounce after sidebar-close before we re-trigger the update. */
const SIDEBAR_CLOSE_SETTLE_MS = 250;

const ADDON_ID: string = addon.data.config.addonID;

// ---------------------------------------------------------------------------
// Sidebar visibility (DOM-based, cross-bundle safe)
// ---------------------------------------------------------------------------

/**
 * Is the Beaver sidebar visible in any open main window?
 *
 * We can't import `isSidebarVisibleAtom` from Jotai without creating a second
 * Jotai instance, so we read the DOM instead. Two signals:
 *   1. Toolbar button `#zotero-beaver-tb-chat-toggle` has `selected="true"`
 *      when `UIManager.updateToolbarButton(true)` has run.
 *   2. `#beaver-pane-library` / `#beaver-pane-reader` have their inline
 *      `display` style cleared when visible, and set to `none` when hidden.
 *
 * We check both because the toolbar button can lag briefly during tab switches.
 */
function isAnySidebarVisible(): boolean {
  try {
    const wins = Zotero.getMainWindows?.() ?? [];
    for (const win of wins) {
      if (!win || win.closed || !win.document) continue;

      const btn = win.document.querySelector(
        "#zotero-beaver-tb-chat-toggle",
      ) as HTMLElement | null;
      if (btn?.getAttribute("selected") === "true") {
        return true;
      }

      const lib = win.document.querySelector(
        "#beaver-pane-library",
      ) as HTMLElement | null;
      if (lib && lib.style.display !== "none") {
        // Only treat as visible if the pane actually has width (avoids
        // matching freshly-mounted panes before visibility is applied).
        if (lib.offsetWidth > 0 || lib.offsetHeight > 0) return true;
      }

      const reader = win.document.querySelector(
        "#beaver-pane-reader",
      ) as HTMLElement | null;
      if (reader && reader.style.display !== "none") {
        if (reader.offsetWidth > 0 || reader.offsetHeight > 0) return true;
      }
    }
  } catch (error) {
    ztoolkit.log(`[updateController] isAnySidebarVisible error: ${error}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Thread persistence
// ---------------------------------------------------------------------------

/**
 * Capture the currently-active thread (if any) into the
 * `pendingDeferredThread` pref so that the next plugin instance — whether it
 * starts immediately (update proceeds) or after the sidebar next closes
 * (update deferred) — can restore it.
 *
 * `sidebarWasOpen` is recorded so the restoration logic can decide whether to
 * force-open the sidebar or just load the thread silently in the background.
 */
function persistCurrentThread(sidebarWasOpen: boolean): void {
  try {
    const threadId = (Zotero as any).__beaverActiveThreadId as
      | string
      | null
      | undefined;
    if (!threadId) {
      // Nothing to restore — clear any stale pref so we don't restore
      // something from a previous deferral.
      try {
        Zotero.Prefs.clear(
          `${addon.data.config.prefsPrefix}.pendingDeferredThread`,
          true,
        );
      } catch {
        /* ignore */
      }
      return;
    }

    const payload = {
      threadId,
      setAt: Date.now(),
      sidebarWasOpen,
    };
    Zotero.Prefs.set(
      `${addon.data.config.prefsPrefix}.pendingDeferredThread`,
      JSON.stringify(payload),
      true,
    );
    ztoolkit.log(
      `[updateController] Persisted deferred thread ${threadId} (sidebarWasOpen=${sidebarWasOpen})`,
    );
  } catch (error) {
    ztoolkit.log(`[updateController] persistCurrentThread error: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Install listener
// ---------------------------------------------------------------------------

function buildInstallListener() {
  return {
    onNewInstall(_install: any) {
      /* no-op */
    },
    onDownloadStarted(_install: any) {
      /* no-op */
    },
    onDownloadEnded(_install: any) {
      /* no-op */
    },
    onDownloadFailed(_install: any) {
      /* no-op */
    },
    /**
     * Called right before an install/upgrade is applied. Returning `false`
     * cancels this specific install attempt; the AOM will discover the
     * update again on its next poll (or when we call `findUpdates`).
     */
    onInstallStarted(install: any): boolean {
      try {
        // Only act on upgrades to OUR addon. Pass through everything
        // else (other plugins installing/updating, fresh installs).
        if (install?.existingAddon?.id !== ADDON_ID) {
          return true;
        }

        const sidebarVisible = isAnySidebarVisible();

        // Capture the thread regardless of outcome, so either the
        // immediate upgrade OR the eventual deferred upgrade can
        // restore it. `sidebarWasOpen` drives whether restoration
        // force-opens the sidebar.
        persistCurrentThread(sidebarVisible);

        if (sidebarVisible) {
          updateDeferred = true;
          ztoolkit.log(
            "[updateController] Deferred plugin update — Beaver sidebar is visible",
          );
          return false;
        }

        ztoolkit.log(
          "[updateController] Allowing plugin update to proceed (sidebar closed)",
        );
        return true;
      } catch (error) {
        // Never block an install because of a bug in this code.
        ztoolkit.log(
          `[updateController] onInstallStarted error, allowing install: ${error}`,
        );
        return true;
      }
    },
    onInstallEnded(_install: any, _addon: any) {
      /* no-op */
    },
    onInstallCancelled(_install: any) {
      /* no-op — we may have cancelled ourselves, nothing to do */
    },
    onInstallFailed(_install: any) {
      /* no-op */
    },
  };
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

function isPluginAlive(): boolean {
  try {
    if (!addon?.data?.alive) return false;
    if (Zotero.__beaverShuttingDown) return false;
    if (Services?.startup?.shuttingDown) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Guarded retry: calls `addon.findUpdates()` on our own addon if an update was
 * previously deferred and the sidebar is currently closed. Re-discovery causes
 * the AOM to re-download the XPI and re-fire `onInstallStarted`, which this
 * time returns `true` and lets the upgrade proceed.
 *
 * Never call this from inside `onInstallStarted` or `onInstallCancelled` —
 * only from event sources (sidebar-close event, safety interval) to avoid a
 * tight cancel/retry loop.
 */
async function tryApplyDeferredUpdate(
  reason: "sidebar-close" | "interval",
): Promise<void> {
  if (!isPluginAlive()) return;
  if (!updateDeferred) return;
  if (inFlightFindUpdates) return;
  if (isAnySidebarVisible()) return;

  try {
    // Re-resolve the addon in case the initial lookup failed.
    if (!storedAddon && AddonManagerMod) {
      try {
        storedAddon = await AddonManagerMod.AddonManager.getAddonByID(ADDON_ID);
      } catch (error) {
        ztoolkit.log(`[updateController] getAddonByID retry failed: ${error}`);
      }
    }

    if (!storedAddon || !AddonManagerMod) {
      ztoolkit.log(
        `[updateController] tryApplyDeferredUpdate (${reason}): addon handle unavailable, will retry later`,
      );
      return;
    }

    // Re-check liveness after the await above.
    if (!isPluginAlive()) return;

    inFlightFindUpdates = true;
    ztoolkit.log(
      `[updateController] tryApplyDeferredUpdate (${reason}): calling findUpdates`,
    );

    storedAddon.findUpdates(
      {
        onUpdateAvailable(_a: any, install: any) {
          try {
            ztoolkit.log(
              "[updateController] findUpdates: update available, applying",
            );
            install.install();
          } catch (error) {
            ztoolkit.log(
              `[updateController] install.install() failed: ${error}`,
            );
          }
        },
        onNoUpdateAvailable() {
          ztoolkit.log(
            "[updateController] findUpdates: no update available, clearing deferred flag",
          );
          updateDeferred = false;
        },
        onUpdateFinished() {
          inFlightFindUpdates = false;
        },
      },
      AddonManagerMod.AddonManager.UPDATE_WHEN_USER_REQUESTED,
    );
  } catch (error) {
    inFlightFindUpdates = false;
    ztoolkit.log(`[updateController] tryApplyDeferredUpdate error: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Sidebar visibility event bus subscription
// ---------------------------------------------------------------------------

/**
 * Attach a `sidebarVisibilityChange` listener to the given window's event bus.
 * The React bundle dispatches this event whenever the sidebar toggles. We use
 * it for aggressive re-trigger of deferred updates.
 *
 * Safe to call multiple times per window — duplicates are filtered out.
 */
function attachSidebarListener(win: Window): void {
  if (!isPluginAlive()) return;
  const bus = (win as unknown as { __beaverEventBus?: EventTarget })
    .__beaverEventBus;
  if (!bus) return;

  // Filter out duplicate bus registrations.
  if (sidebarBusSubs.some((sub) => sub.bus === bus)) return;

  const handler: SidebarBusHandler = (event) => {
    if (!isPluginAlive()) return;
    try {
      const detail = (event as any).detail as
        | { isVisible?: boolean }
        | undefined;
      // A visibility event only matters to us if it transitions to false
      // (sidebar closing). Use the event payload when present, otherwise
      // fall back to the DOM check.
      const isVisible =
        typeof detail?.isVisible === "boolean"
          ? detail.isVisible
          : isAnySidebarVisible();
      if (isVisible) return;
      if (!updateDeferred) return;

      // Let any in-flight React unmount settle before we tear the plugin
      // down via findUpdates.
      setTimeout(() => {
        void tryApplyDeferredUpdate("sidebar-close");
      }, SIDEBAR_CLOSE_SETTLE_MS);
    } catch (error) {
      ztoolkit.log(`[updateController] sidebar listener error: ${error}`);
    }
  };

  bus.addEventListener("sidebarVisibilityChange", handler);
  sidebarBusSubs.push({ bus, handler });
  ztoolkit.log("[updateController] Attached sidebarVisibilityChange listener");
}

function detachAllSidebarListeners(): void {
  while (sidebarBusSubs.length > 0) {
    const sub = sidebarBusSubs.pop();
    if (!sub) continue;
    try {
      sub.bus.removeEventListener("sidebarVisibilityChange", sub.handler);
    } catch (error) {
      ztoolkit.log(
        `[updateController] detach sidebar listener error: ${error}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called from `onStartup` after core services are initialized. Idempotent.
 */
export async function initUpdateController(): Promise<void> {
  if (installListener) {
    ztoolkit.log(
      "[updateController] initUpdateController: already initialized, skipping",
    );
    return;
  }

  try {
    AddonManagerMod = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );

    // Resolve our own addon so we can call findUpdates later. Failure
    // here is non-fatal — we'll retry inside tryApplyDeferredUpdate.
    try {
      storedAddon = await AddonManagerMod.AddonManager.getAddonByID(ADDON_ID);
    } catch (error) {
      ztoolkit.log(`[updateController] initial getAddonByID failed: ${error}`);
    }

    installListener = buildInstallListener();
    AddonManagerMod.AddonManager.addInstallListener(installListener);

    // Attach sidebar listeners to all currently-open main windows. New
    // windows will pick up listeners via `attachSidebarListenerForWindow`
    // from `onMainWindowLoad`.
    const wins = Zotero.getMainWindows?.() ?? [];
    for (const win of wins) {
      attachSidebarListener(win as Window);
    }

    // Safety-net retry interval. Runs regardless of event delivery so a
    // missed sidebarVisibilityChange event doesn't leave an update
    // permanently deferred.
    safetyInterval = setInterval(() => {
      void tryApplyDeferredUpdate("interval");
    }, SAFETY_INTERVAL_MS);

    ztoolkit.log("[updateController] initialized");
  } catch (error) {
    ztoolkit.log(`[updateController] initUpdateController failed: ${error}`);
    // Best-effort rollback so we don't leak a partially-initialized state.
    disposeUpdateController();
  }
}

/**
 * Called from `onMainWindowLoad` for each new main window so the sidebar
 * listener attaches without requiring a full plugin restart. Safe to call
 * even before `initUpdateController` has run (becomes a no-op if the install
 * listener isn't registered yet).
 */
export function attachSidebarListenerForWindow(win: Window): void {
  if (!installListener) return;
  attachSidebarListener(win);
}

/**
 * Called from `onMainWindowUnload` in the global cleanup branch. Must run
 * BEFORE React unmount so the sidebar visibility transition during teardown
 * doesn't fire `tryApplyDeferredUpdate` mid-shutdown.
 */
export function disposeUpdateController(): void {
  try {
    if (installListener && AddonManagerMod) {
      try {
        AddonManagerMod.AddonManager.removeInstallListener(installListener);
      } catch (error) {
        ztoolkit.log(
          `[updateController] removeInstallListener error: ${error}`,
        );
      }
    }
    installListener = null;

    detachAllSidebarListeners();

    if (safetyInterval !== null) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }

    AddonManagerMod = null;
    storedAddon = null;
    updateDeferred = false;
    inFlightFindUpdates = false;

    ztoolkit.log("[updateController] disposed");
  } catch (error) {
    ztoolkit.log(`[updateController] disposeUpdateController error: ${error}`);
  }
}
