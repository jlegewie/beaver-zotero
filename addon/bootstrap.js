/* eslint-disable no-undef */

/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

// Upper bound on how long a starting instance waits for its predecessor's
// teardown before starting anyway.
const PREVIOUS_SHUTDOWN_TIMEOUT_MS = 60000;

function install(data, reason) {}

/**
 * Advance the plugin lifecycle generation. Kept on `Zotero` because a reload
 * reuses this scope while an update loads a new one.
 */
function nextLifecycleGeneration() {
  Zotero.__beaverBootstrapGeneration =
    (Zotero.__beaverBootstrapGeneration || 0) + 1;
  return Zotero.__beaverBootstrapGeneration;
}

/**
 * Wait for a previous instance's `shutdown` to finish. On reload or update,
 * Zotero calls the new instance's `startup` without awaiting the old async
 * `shutdown`, whose cleanup would otherwise run over the new instance.
 */
async function waitForPreviousShutdown() {
  const pending = Zotero.__beaverBootstrapShutdown;
  if (!pending) return;
  const timedOut = await Promise.race([
    pending.then(() => false),
    Zotero.Promise.delay(PREVIOUS_SHUTDOWN_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    Zotero.logError(
      new Error("Beaver: previous instance did not finish shutting down; starting anyway"),
    );
  }
}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  const generation = nextLifecycleGeneration();
  await Zotero.initializationPromise;
  await waitForPreviousShutdown();
  // A shutdown while this startup waited (e.g. disabled again during the
  // previous teardown) supersedes it.
  if (Zotero.__beaverBootstrapGeneration !== generation) return;

  // String 'rootURI' introduced in Zotero 7
  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = {
    rootURI,
  };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  try {
    await Zotero.__addonInstance__.hooks.onStartup();
  } catch (error) {
    Zotero.logError(error);
  }
}

async function onMainWindowLoad({ window }, reason) {
  Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    nextLifecycleGeneration();
    // Last-window close can leave instance services running. Dispose them
    // even when there are no windows left to deliver an unload hook.
    try {
      await Zotero.__addonInstance__?.hooks.onAppShutdown();
    } catch (_) {
      // Keep the database safeguard independent of service cleanup failures.
    }
    // An unclosed Sqlite.sys.mjs connection can block the shutdown barrier.
    try {
      const db = Zotero.__addonInstance__?.db;
      if (db) {
        await db.closeDatabase();
        Zotero.__addonInstance__.db = undefined;
      }
    } catch (_) {
      // Best-effort — if this fails the process is dying anyway
    }
    return;
  }

  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports,
    ).wrappedJSObject;
  }
  nextLifecycleGeneration();
  // Published before the first await so a concurrently starting instance
  // waits for this teardown. The instance and chrome handle are captured so
  // that cleanup only ever touches what this shutdown owns.
  let finishShutdown;
  const shutdownDone = new Promise((resolve) => {
    finishShutdown = resolve;
  });
  Zotero.__beaverBootstrapShutdown = shutdownDone;
  const instance = Zotero.__addonInstance__;
  const handle = chromeHandle;
  chromeHandle = null;
  try {
    await instance?.hooks.onShutdown();
  } finally {
    // Always drop the singleton off Zotero so the next startup's
    // `loadSubScript` sees it gone and assigns a fresh Addon. onShutdown's
    // own `delete` lives inside a try/catch and gets skipped if any
    // earlier cleanup step throws — without this finally a partial
    // teardown leaves `Zotero.__addonInstance__` pointing at a stale
    // instance, breaking the next reload.
    try {
      if (Zotero.__addonInstance__ === instance) {
        delete Zotero.__addonInstance__;
      }
    } catch (_) {
      // best-effort — property may already be gone
    }

    try {
      handle?.destruct();
    } catch (error) {
      Zotero.logError(error);
    }

    if (Zotero.__beaverBootstrapShutdown === shutdownDone) {
      Zotero.__beaverBootstrapShutdown = undefined;
    }
    finishShutdown();
  }
}

function uninstall(data, reason) {}
