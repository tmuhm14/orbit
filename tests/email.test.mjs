import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  htmlToText,
  inboundAddress,
  inboxTokens,
  noteFromEmail,
  verifyResendWebhook,
} from "../lib/email.ts";

const key = Buffer.from("orbit-test-webhook-key-0123456789");
const secret = `whsec_${key.toString("base64")}`;
const sign = (id, ts, body) =>
  createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

test("accepts a valid Resend (Svix) signature, including among several", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"email.received"}';
  const signature = `v1,bogus v1,${sign("msg_1", ts, body)}`;
  assert.equal(
    verifyResendWebhook(
      body,
      { id: "msg_1", timestamp: ts, signature },
      secret,
      now,
    ),
    true,
  );
});

test("rejects tampered bodies, wrong ids, stale timestamps, and other versions", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = "{}";
  const good = sign("msg_1", ts, body);
  const check = (b, id, t, s, at = now) =>
    verifyResendWebhook(b, { id, timestamp: t, signature: s }, secret, at);
  assert.equal(check("{ }", "msg_1", ts, `v1,${good}`), false);
  assert.equal(check(body, "msg_2", ts, `v1,${good}`), false);
  assert.equal(check(body, "msg_1", ts, `v1,${good}`, now + 6 * 60_000), false);
  assert.equal(check(body, "msg_1", ts, `v2,${good}`), false);
  assert.equal(check(body, null, ts, `v1,${good}`), false);
});

test("builds and parses workspace addresses", () => {
  const address = inboundAddress(
    "Waltz Health!",
    "a1b2c3d4e5f6",
    "x1.resend.app",
  );
  assert.equal(address, "waltz-health-a1b2c3d4e5f6@x1.resend.app");
  assert.deepEqual(
    inboxTokens(
      [
        `Orbit <${address.toUpperCase()}>`,
        "a1b2c3d4e5f6@other.com",
        "someone@x1.resend.app",
        "0123456789ab@x1.resend.app",
      ],
      "x1.resend.app",
    ),
    ["a1b2c3d4e5f6", "0123456789ab"],
  );
});

test("converts email HTML to readable text", () => {
  assert.equal(
    htmlToText(
      '<style>p{}</style><p>Hi &amp; welcome</p><ul><li>One</li><li>Two</li></ul><a href="https://x.com">the doc</a><br>&#8212; Tony',
    ),
    "Hi & welcome\n• One\n• Two\nthe doc (https://x.com)\n— Tony",
  );
});

test("turns a forwarded email into an inbox note with provenance", () => {
  const { note, sourceRef } = noteFromEmail({
    id: "em_1",
    from: "Pat <pat@waltzhealth.com>",
    subject: "Fwd: FW: Q4 vendor contract",
    text: "Please review by Thursday.",
    html: null,
    message_id: "<abc@mail>",
    attachments: [{ filename: "contract.pdf" }],
  });
  assert.equal(note.title, "Q4 vendor contract");
  assert.equal(note.source, "email");
  assert.deepEqual(note.tags, ["email"]);
  assert.equal(sourceRef, "email:<abc@mail>");
  assert.match(
    note.plainText,
    /^Please review by Thursday\.\n\nEmailed from Pat <pat@waltzhealth\.com>\nAttachments \(not imported\): contract\.pdf$/,
  );
});

test("falls back to HTML (including data URIs) and to the body for a title", () => {
  const html = Buffer.from(
    "<p>Call the pharmacy</p><p>about refills</p>",
  ).toString("base64");
  const { note, sourceRef } = noteFromEmail({
    id: "em_2",
    from: "me@example.com",
    subject: "",
    text: null,
    html: `data:text/html;base64,${html}`,
  });
  assert.equal(note.title, "Call the pharmacy");
  assert.match(note.plainText, /^Call the pharmacy\nabout refills/);
  assert.equal(sourceRef, "email:em_2");
});
