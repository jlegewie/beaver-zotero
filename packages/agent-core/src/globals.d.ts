/*
 * Minimal ambient declarations for the host globals the core uses, narrowed
 * to the members actually called. Declaring these instead of adding lib "DOM"
 * keeps the full DOM surface out of the standalone typecheck, so any new
 * host-environment dependency fails loudly here.
 */

/**
 * Connectivity probe and client description. Declared possibly-undefined so
 * call sites must guard with `typeof navigator !== 'undefined'` — not every
 * host provides it. `platform`/`userAgent` are optional for the same reason:
 * they only enrich diagnostics, and callers already fall back.
 */
declare const navigator:
  | { onLine: boolean; platform?: string; userAgent?: string }
  | undefined;

/**
 * Development logging. Possibly-undefined because some host contexts (a
 * sandboxed script scope, a worker) have no console at all; the logger guards
 * with `typeof console !== 'undefined'`.
 */
declare const console: { log(...args: any[]): void } | undefined;

/**
 * Build-time configuration, listed key by key rather than as an open record.
 * Each read has to be substituted by the host's bundler; a bundler that does
 * not define one emits a bare `process` reference that throws at load in a
 * host with no Node runtime. Adding a key here is the point at which to check
 * that every bundler consuming the core defines it.
 */
declare const process: {
  env: {
    API_BASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
  };
};

/** Unique-id generation. */
declare const crypto: { randomUUID(): string };

/** URL parsing and validation. */
declare class URL {
  constructor(url: string, base?: string);
  protocol: string;
  hostname: string;
  /** Host including the port, used to derive the WebSocket URL from the base URL. */
  host: string;
}

/** Query-string building for the backend clients. */
declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  set(name: string, value: string): void;
  append(name: string, value: string): void;
  toString(): string;
}

/**
 * Opaque timer handle. Hosts return different things (a number in browsers, an
 * object in Node) and the core only ever hands it back to `clearTimeout`, so
 * the shape is deliberately left undescribed. Annotate stored timers as
 * `ReturnType<typeof setTimeout>`.
 */
declare interface TimerHandle {
  readonly __timerHandle: unique symbol;
}

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeoutMs?: number,
): TimerHandle;
declare function clearTimeout(handle: TimerHandle | null | undefined): void;

/** Cancellation for in-flight requests. */
declare interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

/** The response members the backend clients read. */
declare interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

declare interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

declare function fetch(url: string, init?: RequestInit): Promise<Response>;

/** Payload frame delivered to `WebSocket.onmessage`. */
declare interface WebSocketMessageEvent {
  data: string;
}

/** Close frame delivered to `WebSocket.onclose`. */
declare interface WebSocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/**
 * The agent connection. `onerror` carries no useful detail, so its handler
 * takes no argument: the close frame that always follows is what the transport
 * reads.
 */
declare class WebSocket {
  static readonly CONNECTING: number;
  static readonly OPEN: number;
  static readonly CLOSED: number;
  constructor(url: string);
  readonly readyState: number;
  /** Negotiated on open; logged to tell proxy interference apart. */
  readonly extensions: string;
  readonly protocol: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
