/** System timers. Surviving window closure also requires plugin-owned callbacks and promises. */
export function getSystemTimers() {
    return typeof ChromeUtils !== 'undefined'
        ? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs') as {
            setTimeout: typeof setTimeout;
            clearTimeout: typeof clearTimeout;
        }
        : { setTimeout, clearTimeout };
}

export function systemDelay(ms: number): Promise<void> {
    return new Promise(resolve => getSystemTimers().setTimeout(resolve, ms));
}
