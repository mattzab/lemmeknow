/** ntfy-shaped JSON errors: {"code":40101,"http":401,"error":"unauthorized","link":"..."}. */
export class NtfyError extends Error {
	constructor(
		readonly code: number,
		readonly http: number,
		message: string,
		readonly link?: string,
	) {
		super(message);
	}
	withDetail(detail: string): NtfyError {
		return new NtfyError(this.code, this.http, `${this.message}, ${detail}`, this.link);
	}
	toJSON() {
		return { code: this.code, http: this.http, error: this.message, ...(this.link ? { link: this.link } : {}) };
	}
	toResponse(): Response {
		return new Response(JSON.stringify(this.toJSON()) + "\n", {
			status: this.http,
			headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
		});
	}
}

const D = "https://docs.ntfy.sh";
export const E = {
	delayNoCache: new NtfyError(40002, 400, "cannot disable cache for delayed message"),
	delayCannotParse: new NtfyError(40004, 400, "invalid delay parameter: unable to parse delay", `${D}/publish/#scheduled-delivery`),
	delayTooSmall: new NtfyError(40005, 400, "invalid delay parameter: too small, please refer to the docs", `${D}/publish/#scheduled-delivery`),
	delayTooLarge: new NtfyError(40006, 400, "invalid delay parameter: too large, please refer to the docs", `${D}/publish/#scheduled-delivery`),
	priorityInvalid: new NtfyError(40007, 400, "invalid priority parameter", `${D}/publish/#message-priority`),
	sinceInvalid: new NtfyError(40008, 400, "invalid since parameter", `${D}/subscribe/api/#fetch-cached-messages`),
	topicInvalid: new NtfyError(40009, 400, "invalid request: topic invalid"),
	attachmentUrlInvalid: new NtfyError(40013, 400, "invalid request: attachment URL is invalid", `${D}/publish/#attachments`),
	attachmentsDisallowed: new NtfyError(40014, 400, "invalid request: attachments not allowed", `${D}/config/#attachments`),
	wsUpgradeMissing: new NtfyError(40016, 400, "invalid request: client not using the websocket protocol", `${D}/subscribe/api/#websockets`),
	messageJsonInvalid: new NtfyError(40017, 400, "invalid request: request body must be message JSON", `${D}/publish/#publish-as-json`),
	actionsInvalid: new NtfyError(40018, 400, "invalid request: actions invalid", `${D}/publish/#action-buttons`),
	iconUrlInvalid: new NtfyError(40021, 400, "invalid request: icon URL is invalid", `${D}/publish/#icons`),
	titleTooLarge: new NtfyError(40045, 400, "invalid request: title too large"),
	tagsTooLarge: new NtfyError(40046, 400, "invalid request: tags too large"),
	messageNotUtf8: new NtfyError(40022, 400, "invalid request: message must be UTF-8 encoded"),
	emailUnsupported: new NtfyError(40031, 400, "e-mail notifications are not supported by this server"),
	callUnsupported: new NtfyError(40034, 400, "phone calls are not supported by this server"),
	unauthorized: new NtfyError(40101, 401, "unauthorized", `${D}/publish/#authentication`),
	forbidden: new NtfyError(40301, 403, "forbidden", `${D}/publish/#authentication`),
	notFound: new NtfyError(40401, 404, "page not found"),
	tooLarge: new NtfyError(41301, 413, "request entity too large"),
	internal: new NtfyError(50001, 500, "internal server error"),
};
