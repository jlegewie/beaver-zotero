/*
 * Minimal ambient declarations for the host globals the core uses, narrowed
 * to the members actually called. Declaring these instead of adding lib "DOM"
 * keeps the full DOM surface out of the standalone typecheck, so any new
 * host-environment dependency fails loudly here.
 */

/**
 * Connectivity probe. Declared possibly-undefined so call sites must guard
 * with `typeof navigator !== 'undefined'` — not every host provides it.
 */
declare const navigator: { onLine: boolean } | undefined;

/** Unique-id generation. */
declare const crypto: { randomUUID(): string };

/** URL parsing and validation. */
declare class URL {
  constructor(url: string, base?: string);
  protocol: string;
  hostname: string;
}
