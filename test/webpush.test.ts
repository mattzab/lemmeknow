import { describe, expect, it } from "vitest";
import { b64url, b64urlDecode } from "../src/worker/util";
import { buildPushRequest, encryptPayload, generateVapidKeys, isAcceptableEndpoint, isGone, vapidJwt } from "../src/worker/webpush";
import { decryptPush, fakeBrowserSubscription } from "./helpers";

// RFC 8291 §5 / Appendix A.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcSenderKeys(): Promise<CryptoKeyPair> {
	const pub = b64urlDecode(RFC.asPublic);
	const jwk = { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)), d: RFC.asPrivate };
	const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
	return { privateKey, publicKey };
}

describe("RFC 8291 encryption", () => {
	it("reproduces the RFC 8291 example byte for byte", async () => {
		const out = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, new TextEncoder().encode(RFC.plaintext), {
			senderKeys: await rfcSenderKeys(),
			salt: b64urlDecode(RFC.salt),
		});
		expect(b64url(out)).toBe(RFC.body);
	});

	it("round-trips through an independent browser-side decrypt with random keys and salt", async () => {
		const sub = await fakeBrowserSubscription();
		const body = await encryptPayload(sub.keys, new TextEncoder().encode('{"body":"héllo 🔔"}'));
		expect(await decryptPush(body, sub.privateKey, sub.keys.p256dh, sub.keys.auth)).toBe('{"body":"héllo 🔔"}');
		// A second encryption uses a fresh ephemeral key and salt.
		const again = await encryptPayload(sub.keys, new TextEncoder().encode("x"));
		expect(b64url(again.slice(0, 16))).not.toBe(b64url(body.slice(0, 16)));
	});

	it("rejects malformed browser keys", async () => {
		await expect(encryptPayload({ p256dh: b64url(new Uint8Array(65)), auth: RFC.auth }, new Uint8Array(1))).rejects.toThrow();
		await expect(encryptPayload({ p256dh: RFC.uaPublic, auth: "AAAA" }, new Uint8Array(1))).rejects.toThrow(/auth/);
	});
});

describe("VAPID", () => {
	it("signs an ES256 JWT that verifies with the advertised public key", async () => {
		const keys = await generateVapidKeys();
		expect(b64urlDecode(keys.publicKey)).toHaveLength(65);
		const now = 1_800_000_000;
		const jwt = await vapidJwt(keys, "https://web.push.apple.com", "https://lemmeknow.example.com", now);
		const [h, p, s] = jwt.split(".");
		expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
		const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
		expect(claims).toEqual({ aud: "https://web.push.apple.com", exp: now + 12 * 3600, sub: "https://lemmeknow.example.com" });
		expect(claims.exp - now).toBeLessThanOrEqual(86400); // Apple rejects > 24 h
		const pub = await crypto.subtle.importKey("raw", b64urlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		expect(b64urlDecode(s)).toHaveLength(64); // raw r||s, not DER
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
	});

	it("builds a push request with the headers push services require", async () => {
		const keys = await generateVapidKeys();
		const sub = await fakeBrowserSubscription("https://fcm.googleapis.com/fcm/send/abc123");
		const req = await buildPushRequest(keys, { endpoint: sub.endpoint, ...sub.keys }, new TextEncoder().encode("hi"), { ttl: 3600, urgency: "high", subject: "mailto:me@example.com" });
		expect(req.method).toBe("POST");
		expect(req.url).toBe(sub.endpoint);
		expect(req.headers.get("content-encoding")).toBe("aes128gcm");
		expect(req.headers.get("ttl")).toBe("3600");
		expect(req.headers.get("urgency")).toBe("high");
		const auth = req.headers.get("authorization") ?? "";
		expect(auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
		expect(auth.endsWith(`k=${keys.publicKey}`)).toBe(true);
		const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(auth.slice(8).split(".")[1])));
		expect(claims.aud).toBe("https://fcm.googleapis.com");
		const body = new Uint8Array(await req.arrayBuffer());
		expect(await decryptPush(body, sub.privateKey, sub.keys.p256dh, sub.keys.auth)).toBe("hi");
	});

	it("classifies dead subscriptions like Apple and FCM report them", () => {
		expect(isGone(410, "push subscription has unsubscribed or expired.")).toBe(true); // FCM
		expect(isGone(400, '{"reason":"BadDeviceToken"}')).toBe(true); // Apple, unknown token
		expect(isGone(403, '{"reason":"VapidPkHashMismatch"}')).toBe(true);
		expect(isGone(403, '{"reason":"BadJwtToken"}')).toBe(false); // our bug, not the device's
		expect(isGone(429, "")).toBe(false);
		expect(isGone(503, "")).toBe(false);
	});

	it("only accepts https endpoints on public hostnames", () => {
		expect(isAcceptableEndpoint("https://web.push.apple.com/abc")).toBe(true);
		expect(isAcceptableEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
		for (const bad of ["http://web.push.apple.com/x", "https://localhost/x", "https://10.0.0.1/x", "https://[::1]/x", "https://intranet/x", "https://a:b@push.example.com/x", "nope"]) {
			expect(isAcceptableEndpoint(bad), bad).toBe(false);
		}
	});
});
