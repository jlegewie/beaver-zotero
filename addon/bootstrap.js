/* eslint-disable no-undef */

/**
 * Most of this code is from Zotero team's official Make It Red example[1]
 * or the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;

// Upper bound on how long a startup or shutdown waits for the other to
// settle before proceeding anyway.
const LIFECYCLE_WAIT_TIMEOUT_MS = 60000;

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
 * Wait, bounded, for an in-flight lifecycle step to settle. Zotero does not
 * await async bootstrap methods: on reload or update the new instance's
 * `startup` overlaps the old async `shutdown`, and a quick disable overlaps a
 * still-running `startup`. Without this, one would run over the other.
 */
async function waitForLifecycleStep(pending, timeoutMessage) {
  if (!pending) return;
  const timedOut = await Promise.race([
    pending.then(
      () => false,
      () => false,
    ),
    Zotero.Promise.delay(LIFECYCLE_WAIT_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    Zotero.logError(new Error(`Beaver: ${timeoutMessage}`));
  }
}

async function startup(data, reason) {
  // Published so a shutdown arriving mid-startup waits for it to settle.
  const run = runStartup(data);
  Zotero.__beaverBootstrapStartup = run;
  try {
    await run;
  } finally {
    if (Zotero.__beaverBootstrapStartup === run) {
      Zotero.__beaverBootstrapStartup = undefined;
    }
  }
}

async function runStartup({ id, version, resourceURI, rootURI }) {
  const generation = nextLifecycleGeneration();
  // Captured before any await: a shutdown that arrives later waits for this
  // startup, so waiting on it here would deadlock.
  const previousShutdown = Zotero.__beaverBootstrapShutdown;
  await Zotero.initializationPromise;
  await waitForLifecycleStep(
    previousShutdown,
    "previous instance did not finish shutting down; starting anyway",
  );
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

  // Load through the chrome URL registered above: Firefox 153 refuses
  // loadSubScript of the XPI's own jar:/file: URIs. `ignoreCache` because the
  // script cache is keyed by URL, which is the same across updates and reloads.
  Services.scriptloader.loadSubScriptWithOptions(
    "chrome://__addonRef__/content/scripts/__addonRef__.js",
    { target: ctx, ignoreCache: true },
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
  // Cancels a startup still waiting on a previous teardown; one already
  // running is allowed to settle first, so this tears down a finished
  // instance rather than one that is half initialized.
  nextLifecycleGeneration();
  const startingUp = Zotero.__beaverBootstrapStartup;
  // Published before the first await so a concurrently starting instance
  // waits for this teardown. The instance and chrome handle are captured so
  // that cleanup only ever touches what this shutdown owns.
  let finishShutdown;
  const shutdownDone = new Promise((resolve) => {
    finishShutdown = resolve;
  });
  Zotero.__beaverBootstrapShutdown = shutdownDone;
  let instance;
  let handle;
  try {
    if (startingUp) {
      await waitForLifecycleStep(
        startingUp,
        "startup did not finish before shutdown; shutting down anyway",
      );
    }
    instance = Zotero.__addonInstance__;
    handle = chromeHandle;
    chromeHandle = null;
    await instance?.hooks.onShutdown();
  } finally {
    // Always drop the singleton off Zotero so the next startup's
    // `loadSubScript` sees it gone and assigns a fresh Addon. onShutdown's
    // own `delete` lives inside a try/catch and gets skipped if any
    // earlier cleanup step throws — without this finally a partial
    // teardown leaves `Zotero.__addonInstance__` pointing at a stale
    // instance, breaking the next reload.
    try {
      if (instance && Zotero.__addonInstance__ === instance) {
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
