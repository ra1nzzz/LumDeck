/**
 * Shared bounded HTTP helper for LumDeck widgets.
 *
 * Enforces a single timeout and optional parent AbortSignal across the full
 * request lifecycle (both headers and body consumption), preserves status and
 * headers, handles no-content responses without forcing JSON parsing, parses
 * Retry-After headers, and classifies failures cleanly.
 */

export type HttpErrorKind = "aborted" | "timeout" | "network" | "http" | "decode";

export type HttpResponseType = "json" | "text" | "none";

export interface HttpHeaders {
  get(name: string): string | null;
}

export interface HttpRequestOptions extends Omit<RequestInit, "signal"> {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  responseType?: HttpResponseType;
  /** When true, HTTP 304 Not Modified resolves as a no-content response instead of throwing HttpError. */
  allowNotModified?: boolean;
  /** Optional custom predicate to decide whether a status code is treated as success. */
  validateStatus?: (status: number, res: Response) => boolean;
}

export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  headers: HttpHeaders;
  data: T | undefined;
  noContent: boolean;
  retryAfterMs: number | null;
}

export interface HttpErrorOptions {
  kind: HttpErrorKind;
  message: string;
  status?: number;
  headers?: HttpHeaders;
  retryAfterMs?: number | null;
  cause?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const EMPTY_HEADERS: HttpHeaders = { get: () => null };

/** Structured HTTP failure preserving error category, status, headers, and Retry-After delay. */
export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status?: number;
  readonly headers?: HttpHeaders;
  readonly retryAfterMs: number | null;

  constructor(opts: HttpErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HttpError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.headers = opts.headers;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function isHttpError(err: unknown, kind?: HttpErrorKind): err is HttpError {
  return err instanceof HttpError && (kind === undefined || err.kind === kind);
}

export function isAbortError(err: unknown): boolean {
  return isHttpError(err, "aborted") || (err instanceof Error && err.name === "AbortError");
}

/**
 * Parse an HTTP Retry-After header value (delta-seconds or HTTP-date) into milliseconds.
 * Returns null if the header is missing or malformed.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const ms = seconds * 1000;
    return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
  }

  // Require at least one letter so Date.parse cannot accept numeric fragments like "1.5".
  if (!/[a-zA-Z]/.test(trimmed)) return null;
  const targetMs = Date.parse(trimmed);
  if (!Number.isFinite(targetMs)) return null;
  return Math.max(0, targetMs - nowMs);
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: () => HttpError,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(makeError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(makeError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function hasNoResponseBody(
  status: number,
  method: string,
  responseType: HttpResponseType,
  headers: HttpHeaders,
): boolean {
  if (responseType === "none") return true;
  if (method.toUpperCase() === "HEAD") return true;
  if (status === 204 || status === 205 || status === 304) return true;
  return headers.get("content-length")?.trim() === "0";
}

/**
 * Execute a bounded HTTP request whose timeout and parent AbortSignal cover both
 * the initial fetch and reading/decoding the response body.
 */
export async function fetchHttp<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    signal: parentSignal,
    timeoutMs: rawTimeoutMs,
    responseType = "json",
    allowNotModified = false,
    validateStatus,
    ...fetchInit
  } = options;

  const timeoutMs =
    rawTimeoutMs === undefined || Number.isNaN(rawTimeoutMs) ? DEFAULT_TIMEOUT_MS : rawTimeoutMs;

  if (parentSignal?.aborted) {
    throw new HttpError({
      kind: "aborted",
      message: "Request aborted",
      cause: parentSignal.reason,
    });
  }

  if (timeoutMs <= 0) {
    throw new HttpError({
      kind: "timeout",
      message: `Request timed out after ${timeoutMs}ms`,
    });
  }

  const ctrl = new AbortController();
  let abortKind: "aborted" | "timeout" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;

  if (parentSignal) {
    onParentAbort = () => {
      if (!abortKind) abortKind = "aborted";
      ctrl.abort(parentSignal.reason);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs)) {
    timer = globalThis.setTimeout(() => {
      if (!abortKind) abortKind = "timeout";
      ctrl.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  const makeSignalError = (cause?: unknown): HttpError => {
    const kind: "aborted" | "timeout" =
      abortKind ?? (parentSignal?.aborted ? "aborted" : "timeout");
    return new HttpError({
      kind,
      message: kind === "timeout" ? `Request timed out after ${timeoutMs}ms` : "Request aborted",
      cause,
    });
  };

  try {
    let res: Response;
    try {
      res = await raceWithAbort(
        fetch(url, { ...fetchInit, signal: ctrl.signal }),
        ctrl.signal,
        makeSignalError,
      );
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (abortKind || parentSignal?.aborted || ctrl.signal.aborted) {
        throw makeSignalError(err);
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError({ kind: "aborted", message: "Request aborted", cause: err });
      }
      throw new HttpError({
        kind: "network",
        message: err instanceof Error ? err.message : "Network request failed",
        cause: err,
      });
    }

    const headers: HttpHeaders =
      res.headers && typeof res.headers.get === "function" ? res.headers : EMPTY_HEADERS;
    const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
    const isOk = validateStatus
      ? validateStatus(res.status, res)
      : res.ok || (allowNotModified && res.status === 304);

    if (!isOk) {
      throw new HttpError({
        kind: "http",
        message: `HTTP ${res.status}`,
        status: res.status,
        headers,
        retryAfterMs,
      });
    }

    const method = fetchInit.method ?? "GET";
    if (hasNoResponseBody(res.status, method, responseType, headers)) {
      return {
        ok: true,
        status: res.status,
        headers,
        data: undefined,
        noContent: true,
        retryAfterMs,
      };
    }

    const readBody = async (): Promise<T> => {
      if (responseType === "text") {
        return (await res.text()) as T;
      }
      if (typeof res.json === "function") {
        return (await res.json()) as T;
      }
      return JSON.parse(await res.text()) as T;
    };

    try {
      const data = await raceWithAbort(readBody(), ctrl.signal, makeSignalError);
      return {
        ok: true,
        status: res.status,
        headers,
        data,
        noContent: false,
        retryAfterMs,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (abortKind || parentSignal?.aborted || ctrl.signal.aborted) {
        throw makeSignalError(err);
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError({ kind: "aborted", message: "Request aborted", cause: err });
      }
      throw new HttpError({
        kind: "decode",
        message: err instanceof Error ? err.message : "Failed to decode response body",
        status: res.status,
        headers,
        retryAfterMs,
        cause: err,
      });
    }
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

export function fetchJson<T = unknown>(
  url: string,
  options: Omit<HttpRequestOptions, "responseType"> = {},
): Promise<HttpResponse<T>> {
  return fetchHttp<T>(url, { ...options, responseType: "json" });
}

export function fetchText(
  url: string,
  options: Omit<HttpRequestOptions, "responseType"> = {},
): Promise<HttpResponse<string>> {
  return fetchHttp<string>(url, { ...options, responseType: "text" });
}
