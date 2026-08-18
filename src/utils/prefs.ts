import config from "../../package.json";
import { getRuntimeAdapter } from "@beaver/agent-core/platform/runtime";
import { registerZoteroRuntime } from "../platform/zoteroRuntime";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.config.prefsPrefix;

// Install the Zotero-backed runtime adapter here rather than from a bundle
// entry, because some preference-backed atoms call `getPref()` at MODULE SCOPE
// for their initial values. A module's imports are fully evaluated before any
// of its own body runs, so an entry-body call — the pattern the other host
// seams follow — always lands after those eager reads.
//
// Installing here makes preference access order-independent: the pref
// accessors live only on this module, so every caller already imports it, and
// a dependency's top-level code always completes before its importer's. That
// argument holds only while this module imports nothing from the app graph —
// an import cycle through it would move this call after a consumer's body and
// make the eager reads throw.
//
// It orders nothing for the adapter's other consumers, which reach it without
// importing this module; they read at call time, long after evaluation.
registerZoteroRuntime();

/**
 * Get preference value. Routes through the platform runtime adapter.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return getRuntimeAdapter().getPref(`${PREFS_PREFIX}.${key}`) as PluginPrefsMap[K];
}

/**
 * Set preference value. Routes through the platform runtime adapter.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return getRuntimeAdapter().setPref(`${PREFS_PREFIX}.${key}`, value);
}

/**
 * Clear preference value. Routes through the platform runtime adapter.
 * @param key
 */
export function clearPref(key: string) {
  return getRuntimeAdapter().clearPref(`${PREFS_PREFIX}.${key}`);
}
