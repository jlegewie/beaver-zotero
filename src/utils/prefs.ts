import config from "../../package.json";
import { getRuntimeAdapter } from "../platform/runtime";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.config.prefsPrefix;

/**
 * Get preference value. Routes through the platform runtime adapter
 * (Zotero-backed by default).
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return getRuntimeAdapter().getPref(`${PREFS_PREFIX}.${key}`) as PluginPrefsMap[K];
}

/**
 * Set preference value. Routes through the platform runtime adapter
 * (Zotero-backed by default).
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
 * Clear preference value. Routes through the platform runtime adapter
 * (Zotero-backed by default).
 * @param key
 */
export function clearPref(key: string) {
  return getRuntimeAdapter().clearPref(`${PREFS_PREFIX}.${key}`);
}
