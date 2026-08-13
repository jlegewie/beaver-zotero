/**
 * Host-platform flags for the shared React layer.
 *
 * Keyboard behavior is platform-specific (accelerator key, IME workarounds), so
 * shared components need to know which platform they render on. They take the
 * `Navigator` as a parameter instead of reading a global one: this package has
 * no host global to ask, and the same component renders into more than one
 * window, so it derives its window from an element's `ownerDocument` and hands
 * that window's navigator in.
 *
 * `navigator.userAgentData.platform` is preferred where the engine provides it.
 * Gecko — which Zotero runs on — does not, so the `navigator.platform` fallback
 * ("MacIntel", "Win32"/"Win64") is the one that resolves there; the user-agent
 * string is a last resort for engines that report neither.
 */

/**
 * `userAgentData` is not in TypeScript's DOM lib, so it is read through a narrow
 * structural type rather than a global declaration (which this package bans).
 */
type NavigatorWithUserAgentData = Navigator & {
    userAgentData?: { platform?: string };
};

/**
 * The most specific platform string the navigator offers, lower-cased.
 */
function platformDescriptor(navigator: Navigator): string {
    const uaDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
    return (uaDataPlatform || navigator.platform || navigator.userAgent || '').toLowerCase();
}

/**
 * Whether the given navigator's platform is macOS — where the accelerator key is
 * Cmd rather than Ctrl.
 *
 * @param navigator - The navigator of the window the component renders in
 */
export function isMacPlatform(navigator: Navigator): boolean {
    // "macOS" (userAgentData), "MacIntel" (navigator.platform), "Macintosh" (UA).
    return platformDescriptor(navigator).includes('mac');
}

/**
 * Whether the given navigator's platform is Windows.
 *
 * @param navigator - The navigator of the window the component renders in
 */
export function isWindowsPlatform(navigator: Navigator): boolean {
    // "Windows" (userAgentData), "Win32"/"Win64" (navigator.platform), "Windows NT" (UA).
    return platformDescriptor(navigator).includes('win');
}
