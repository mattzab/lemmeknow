import { DatabaseSync } from "node:sqlite";

/** Minimal D1 on node:sqlite, counting rows written like D1 (statement changes). */
export function fakeD1() {
	const sql = new DatabaseSync(":memory:");
	const stats = { writes: 0, statements: [] as string[] };
	const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
	class Stmt {
		constructor(
			public q: string,
			public args: unknown[] = [],
		) {}
		bind(...a: unknown[]) {
			return new Stmt(this.q, a);
		}
		exec() {
			const st = sql.prepare(this.q);
			stats.statements.push(this.q);
			if (/^\s*(SELECT|WITH)/i.test(this.q) || /RETURNING/i.test(this.q)) return { results: st.all(...(this.args.map(norm) as never[])) as Record<string, unknown>[], changes: 0 };
			const r = st.run(...(this.args.map(norm) as never[]));
			stats.writes += Number(r.changes);
			return { results: [], changes: Number(r.changes) };
		}
		async all() {
			const r = this.exec();
			return { results: r.results, success: true, meta: { changes: r.changes } };
		}
		async first<T>(col?: string) {
			const r = this.exec().results[0] as Record<string, unknown> | undefined;
			return (r ? (col ? r[col] : r) : null) as T;
		}
		async run() {
			return this.all();
		}
	}
	const db = {
		prepare: (q: string) => new Stmt(q),
		async batch(list: Stmt[]) {
			sql.exec("BEGIN");
			try {
				const out = list.map((s) => {
					const r = s.exec();
					return { results: r.results, success: true, meta: { changes: r.changes } };
				});
				sql.exec("COMMIT");
				return out;
			} catch (e) {
				sql.exec("ROLLBACK");
				throw e;
			}
		},
		async exec(q: string) {
			sql.exec(q);
		},
	};
	return { db, sql, stats };
}
