// Tiny fetch wrapper. Same-origin credentials (Cloudflare Access cookie), JSON in/out,
// throws ApiError with the server's `{ error, field }` on non-2xx.

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly field?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface RequestOptions {
	method?: string;
	body?: unknown;
	signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const method = opts.method ?? "GET";
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		signal: opts.signal,
		headers: opts.body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	const text = await res.text();
	let data: unknown = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			if (!res.ok) throw new ApiError(text.slice(0, 200) || res.statusText, res.status);
			throw new ApiError("Invalid JSON from server", res.status);
		}
	}
	if (!res.ok) {
		const err = (data ?? {}) as { error?: string; field?: string };
		throw new ApiError(err.error || `${res.status} ${res.statusText}`, res.status, err.field);
	}
	return data as T;
}

export const api = {
	get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
	post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body ?? {} }),
	put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body }),
	patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
	del: <T = { ok: boolean }>(path: string) => request<T>(path, { method: "DELETE" }),
};

const A = "/api/admin";
/** Admin API, paths relative to /api/admin. */
export const admin = {
	get: <T>(path: string, signal?: AbortSignal) => api.get<T>(A + path, signal),
	post: <T>(path: string, body?: unknown) => api.post<T>(A + path, body),
	put: <T>(path: string, body: unknown) => api.put<T>(A + path, body),
	patch: <T>(path: string, body: unknown) => api.patch<T>(A + path, body),
	del: <T = { ok: boolean }>(path: string) => api.del<T>(A + path),
};

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
