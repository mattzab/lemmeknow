export class DurableObject<E = unknown> {
	constructor(
		protected ctx: unknown,
		protected env: E,
	) {}
}
