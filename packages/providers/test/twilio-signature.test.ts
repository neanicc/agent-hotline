import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type FormParams,
  twilioSignature,
  twilioSignaturePayload,
  validTwilioSignature,
} from "../src/index.js";

// Twilio's worked example, copied verbatim from
// https://www.twilio.com/docs/usage/security#validating-requests (fetched 2026-10-13).
// The numbers are Twilio's own documentation values, kept as published because
// the signature covers them; every other test uses +1555555 01xx numbers.
const DOCUMENTED = {
  authToken: "12345",
  url: "https://example.com/myapp.php?foo=1&bar=2",
  params: [
    ["Digits", "1234"],
    ["To", "+18005551212"],
    ["From", "+14158675310"],
    ["Caller", "+14158675310"],
    ["CallSid", "CA1234567890ABCDE"],
  ] as FormParams,
  payload:
    "https://example.com/myapp.php?foo=1&bar=2CallSidCA1234567890ABCDECaller+14158675310Digits1234From+14158675310To+18005551212",
  signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
};

const TOKEN = "fake-auth-token-0123456789abcdef";
const URL = "https://hotline.example.test/hooks/twilio/sms";
const PARAMS: FormParams = [
  ["MessageSid", `SM${"1".repeat(32)}`],
  ["AccountSid", `AC${"2".repeat(32)}`],
  ["From", "+15555550100"],
  ["To", "+15555550101"],
  ["Body", "yes"],
];

describe("Twilio signatures", () => {
  it("builds the documented signing string", () => {
    expect(twilioSignaturePayload(DOCUMENTED.url, DOCUMENTED.params)).toBe(DOCUMENTED.payload);
  });

  it("reproduces the documented signature", () => {
    expect(twilioSignature(DOCUMENTED.authToken, DOCUMENTED.url, DOCUMENTED.params)).toBe(
      DOCUMENTED.signature,
    );
    expect(
      validTwilioSignature(DOCUMENTED.authToken, DOCUMENTED.url, DOCUMENTED.params, DOCUMENTED.signature),
    ).toBe(true);
  });

  it("matches a plain HMAC-SHA1 over the documented string", () => {
    const direct = createHmac("sha1", DOCUMENTED.authToken).update(DOCUMENTED.payload).digest("base64");
    expect(direct).toBe(DOCUMENTED.signature);
  });

  it("sorts names case-sensitively, by code unit", () => {
    expect(
      twilioSignaturePayload("u", [
        ["b", "1"],
        ["B", "2"],
        ["a", "3"],
        ["A", "4"],
      ]),
    ).toBe("uA4B2a3b1");
  });

  it("accepts a valid signature over fake parameters, in any order", () => {
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    expect(validTwilioSignature(TOKEN, URL, [...PARAMS].reverse(), signature)).toBe(true);
  });

  it.each([
    ["a different token", { token: "other-token" }],
    ["a different URL", { url: `${URL}?x=1` }],
    ["http instead of https", { url: URL.replace("https:", "http:") }],
    ["a port added", { url: "https://hotline.example.test:443/hooks/twilio/sms" }],
    ["a changed parameter", { params: PARAMS.map(([n, v]) => [n, n === "Body" ? "no" : v] as const) }],
    ["an added parameter", { params: [...PARAMS, ["Extra", "1"] as const] }],
    ["a dropped parameter", { params: PARAMS.slice(1) }],
  ])("rejects %s", (_name, change: { token?: string; url?: string; params?: FormParams }) => {
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    expect(
      validTwilioSignature(change.token ?? TOKEN, change.url ?? URL, change.params ?? PARAMS, signature),
    ).toBe(false);
  });

  it("fails closed on a missing or empty header, an empty token and repeated names", () => {
    const signature = twilioSignature(TOKEN, URL, PARAMS);
    expect(validTwilioSignature(TOKEN, URL, PARAMS, undefined)).toBe(false);
    expect(validTwilioSignature(TOKEN, URL, PARAMS, "")).toBe(false);
    expect(validTwilioSignature("", URL, PARAMS, twilioSignature("", URL, PARAMS))).toBe(false);
    const repeated: FormParams = [...PARAMS, ["Body", "yes"]];
    expect(validTwilioSignature(TOKEN, URL, repeated, twilioSignature(TOKEN, URL, repeated))).toBe(false);
    expect(validTwilioSignature(TOKEN, URL, PARAMS, signature.slice(0, -1))).toBe(false);
    expect(validTwilioSignature(TOKEN, URL, PARAMS, `${signature}=`)).toBe(false);
  });
});
