import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  noteFromSlackMessage,
  signLinkToken,
  slackTextToPlain,
  verifyLinkToken,
  verifySlackRequest,
} from "../lib/slack.ts";

const secret = "test-signing-secret";
const sign = (body, ts) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

test("accepts a correctly signed, fresh Slack request", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  assert.equal(
    verifySlackRequest("payload=x", ts, sign("payload=x", ts), secret, now),
    true,
  );
});

test("rejects tampered bodies, wrong secrets, stale timestamps, and missing headers", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sig = sign("payload=x", ts);
  assert.equal(verifySlackRequest("payload=y", ts, sig, secret, now), false);
  assert.equal(verifySlackRequest("payload=x", ts, sig, "other", now), false);
  assert.equal(
    verifySlackRequest("payload=x", ts, sig, secret, now + 6 * 60_000),
    false,
  );
  assert.equal(verifySlackRequest("payload=x", null, sig, secret, now), false);
  assert.equal(verifySlackRequest("payload=x", ts, null, secret, now), false);
  assert.equal(
    verifySlackRequest("payload=x", ts, "v0=short", secret, now),
    false,
  );
});

test("converts Slack mrkdwn entities to plain text", () => {
  assert.equal(
    slackTextToPlain(
      "Hey <@U123> see <https://x.com/a|the doc> in <#C9|general> &amp; <https://y.com> &lt;3 <!here>",
    ),
    "Hey @U123 see the doc (https://x.com/a) in #general & https://y.com <3 @here",
  );
});

const action = {
  type: "message_action",
  callback_id: "send_to_orbit",
  response_url: "https://hooks.slack.com/actions/T/1/x",
  team: { id: "T1", domain: "acme" },
  user: { id: "U1" },
  channel: { id: "C1", name: "ops" },
  message: {
    ts: "1700000000.123456",
    text: "Ship the release notes\nby Friday",
    user: "U2",
  },
};

test("builds an inbox note with provenance and a stable source ref", () => {
  const { note, sourceRef } = noteFromSlackMessage(action);
  assert.equal(note.title, "Ship the release notes");
  assert.equal(note.bucket, "inbox");
  assert.equal(note.source, "slack");
  assert.deepEqual(note.tags, ["slack"]);
  assert.equal(sourceRef, "slack:T1:C1:1700000000.123456");
  assert.equal(
    note.origin.permalink,
    "https://acme.slack.com/archives/C1/p1700000000123456",
  );
  assert.match(
    note.plainText,
    /^Ship the release notes\nby Friday\n\nForwarded from #ops: https:/,
  );
  assert.equal(noteFromSlackMessage(action).sourceRef, sourceRef);
});

test("thread replies link to the thread; empty messages still get a title", () => {
  const reply = {
    ...action,
    message: { ts: "2.5", thread_ts: "1.5", text: "" },
  };
  const { note } = noteFromSlackMessage(reply);
  assert.equal(note.title, "Slack message");
  assert.match(note.origin.permalink, /p25\?thread_ts=1\.5&cid=C1$/);
});

test("link tokens round-trip, expire, and reject tampering", () => {
  const now = 1_800_000_000_000;
  const token = signLinkToken(
    { teamId: "T1", userId: "U1", teamName: "acme" },
    secret,
    now,
  );
  assert.deepEqual(verifyLinkToken(token, secret, now), {
    teamId: "T1",
    userId: "U1",
    teamName: "acme",
  });
  assert.equal(verifyLinkToken(token, secret, now + 16 * 60_000), null);
  assert.equal(verifyLinkToken(token, "other", now), null);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ teamId: "T1", userId: "U999", exp: 9e9 }),
  ).toString("base64url");
  assert.equal(verifyLinkToken(`${forged}.${sig}`, secret, now), null);
  assert.equal(verifyLinkToken(`${body}.${sig}.x`, secret, now), null);
});
