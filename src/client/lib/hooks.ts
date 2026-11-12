import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "@/api";

/** Run `fn` every `ms` while the tab is visible (and once when it becomes visible again). */
export function usePoll(fn: () => void, ms: number | null | undefined) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(() => {
		if (!ms) return;
		const id = setInterval(() => {
			if (document.visibilityState === "visible") ref.current();
		}, ms);
		const onVis = () => document.visibilityState === "visible" && ref.current();
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [ms]);
}

export interface ApiState<T> {
	data: T | undefined;
	error: Error | undefined;
	loading: boolean;
	reload: () => Promise<void>;
	setData: React.Dispatch<React.SetStateAction<T | undefined>>;
}

/**
 * Load JSON from `path` (full path, e.g. "/api/admin/systems"). `null` path skips loading.
 * Keeps the previous data while refreshing, so polling never flashes skeletons.
 */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<Error>();
	const [loading, setLoading] = useState(path != null);
	const pathRef = useRef(path);
	pathRef.current = path;
	const seq = useRef(0);

	const load = useCallback(async () => {
		const p = pathRef.current;
		if (p == null) return;
		const mine = ++seq.current;
		try {
			const d = await request<T>(p);
			if (mine !== seq.current) return;
			setData(d);
			setError(undefined);
		} catch (e) {
			if (mine !== seq.current) return;
			setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			if (mine === seq.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		setLoading(path != null);
		setData(undefined);
		setError(undefined);
		void load();
	}, [path, load]);

	usePoll(() => void load(), path == null ? null : opts.refreshMs);

	return { data, error, loading, reload: load, setData };
}

/**
 * The latest value in a ref, for callbacks used inside effects. Parents often pass inline handlers
 * (`onClose={() => setOpen(false)}`) that change on every render, and polling pages re-render every
 * few seconds: listing such a handler in an effect's deps re-runs the effect (e.g. reloads a form
 * and wipes the user's edits). Call `ref.current()` instead and leave it out of the deps.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
	const ref = useRef(value);
	ref.current = value;
	return ref;
}

/** Re-render every `ms` (for "updated 12s ago" labels). */
export function useNow(ms = 1000): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(id);
	}, [ms]);
	return now;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw == null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(v: T) => {
			setValue(v);
			localStorage.setItem(key, JSON.stringify(v));
		},
		[key],
	);
	return [value, set];
}

export const DEFAULT_TITLE = "Lemmeknow";

/**
 * Set document.title while the calling view is mounted. `undefined` (e.g. still loading) leaves
 * the current title alone. On unmount the title that was in place before this view first set it
 * is restored (falling back to `fallback`), so it never sticks after navigating away.
 */
export function useDocumentTitle(title: string | undefined, fallback = DEFAULT_TITLE) {
	const prev = useRef<string | null>(null);
	useEffect(() => {
		if (!title) return;
		if (prev.current === null) prev.current = document.title || fallback;
		document.title = title;
	}, [title, fallback]);
	useEffect(
		() => () => {
			if (prev.current !== null) document.title = prev.current;
			prev.current = null;
		},
		[],
	);
}
