/**
 * The only way the app talks to the API.
 *
 * Credentials are session cookies the browser holds and JavaScript cannot read, so
 * there is no token to attach here. The custom header is half of the CSRF defence:
 * a cross-site page cannot set it without a preflight the API refuses.
 */
const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  fields?: { field: string; message: string }[];

  constructor(status: number, code: string, message: string, requestId?: string, fields?: { field: string; message: string }[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fields = fields;
  }
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal };

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-dineflow-client': 'web',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // The request never reached the server: it is down, unreachable or blocked. Say
    // so, rather than the catch-all that makes it look like the user did something wrong.
    throw new ApiError(0, 'NETWORK', "Can't reach the DineFlow server. Check your connection, or try again in a moment.");
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      // Never invent a message: if the API did not give one, say so plainly rather
      // than guessing at a cause.
      error.message ?? 'Something went wrong. Please try again.',
      error.requestId,
      Array.isArray(error.details) ? error.details : undefined,
    );
  }
  return payload as T;
}
