#!/usr/bin/env node
/* ==========================================================================
   Shinzora — is there a relay we can actually reach?
   --------------------------------------------------------------------------
   Two browsers on the same Wi-Fi connect directly. Two browsers on different
   networks often cannot, and then the call needs a TURN relay. This deployment
   has STUN only, which is why a call between two networks can open the room and
   never carry a frame.

   A TURN server is either reachable or it is not, and that is testable without a
   browser: send a STUN binding request, then a real TURN Allocate with
   long-term credentials (RFC 5389 / 5766) and read the answer. No Dependencies.

     node scripts/turn-check.mjs                       # every candidate below
     node scripts/turn-check.mjs --json                # machine readable
   ========================================================================== */

import dgram from "node:dgram";
import crypto from "node:crypto";

const MAGIC = 0x2112a442;

const TYPES = {
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_SUCCESS: 0x0103,
  ALLOCATE_ERROR: 0x0113
};

const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  REALM: 0x0014,
  NONCE: 0x0015,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_RELAYED_ADDRESS: 0x0016,
  XOR_MAPPED_ADDRESS: 0x0020,
  LIFETIME: 0x000d
};

function encode(type, transactionId, attributes = []) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

function attribute(type, value) {
  const padded = Buffer.alloc(Math.ceil(value.length / 4) * 4);
  value.copy(padded);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, padded]);
}

function decode(buffer) {
  const type = buffer.readUInt16BE(0);
  const length = buffer.readUInt16BE(2);
  const attributes = {};
  let offset = 20;
  while (offset < 20 + length) {
    const attrType = buffer.readUInt16BE(offset);
    const attrLength = buffer.readUInt16BE(offset + 2);
    attributes[attrType] = buffer.subarray(offset + 4, offset + 4 + attrLength);
    offset += 4 + Math.ceil(attrLength / 4) * 4;
  }
  return { type, attributes };
}

/** The long-term credential key: MD5(username:realm:password). */
const longTermKey = (username, realm, password) =>
  crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest();

/** MESSAGE-INTEGRITY: HMAC-SHA1 over the message so far, with the length fixed. */
function messageIntegrity(message, key) {
  const copy = Buffer.from(message);
  copy.writeUInt16BE(message.length - 20 + 24, 2);
  const digest = crypto.createHmac("sha1", key).update(copy).digest();
  return attribute(ATTR.MESSAGE_INTEGRITY, digest);
}

function decodeAddress(value) {
  const family = value[1];
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (family !== 0x01) return `port ${port}`;
  /* XOR with the magic cookie, byte for byte, as RFC 5389 §15.2 defines it. */
  const address = value.readUInt32BE(4) ^ MAGIC;
  const ip = [(address >>> 24) & 255, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join(".");
  return `${ip}:${port}`;
}

function send(socket, host, port, message, timeout = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const onMessage = (data) => {
      clearTimeout(timer);
      socket.removeListener("message", onMessage);
      resolve(data);
    };
    socket.on("message", onMessage);
    socket.send(message, port, host, (error) => {
      if (error) {
        clearTimeout(timer);
        socket.removeListener("message", onMessage);
        resolve(null);
      }
    });
  });
}

/** A plain STUN binding request: proves the server answers at all. */
export async function stunCheck(host, port = 3478, timeout = 3000) {
  const socket = dgram.createSocket("udp4");
  try {
    const reply = await send(socket, host, port, encode(TYPES.BINDING_REQUEST, crypto.randomBytes(12)), timeout);
    if (!reply) return { ok: false, reason: "no reply" };
    const { type, attributes } = decode(reply);
    if (type !== TYPES.BINDING_SUCCESS) return { ok: false, reason: `unexpected type 0x${type.toString(16)}` };
    const mapped = attributes[ATTR.XOR_MAPPED_ADDRESS];
    return { ok: true, mapped: mapped ? decodeAddress(mapped) : null };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    socket.close();
  }
}

/**
 * A full TURN allocation: Allocate → 401 with a nonce → Allocate with
 * credentials → success means this relay will carry a call from this network.
 */
export async function turnCheck(host, port, username, password, timeout = 4000) {
  const socket = dgram.createSocket("udp4");
  try {
    const first = await send(
      socket,
      host,
      port,
      encode(TYPES.ALLOCATE_REQUEST, crypto.randomBytes(12), [
        attribute(ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))
      ]),
      timeout
    );
    if (!first) return { ok: false, reason: "no reply to Allocate" };

    const challenge = decode(first);
    if (challenge.type === TYPES.ALLOCATE_SUCCESS) {
      return { ok: true, note: "allocated without credentials", relayed: null };
    }
    const nonce = challenge.attributes[ATTR.NONCE];
    const realm = challenge.attributes[ATTR.REALM];
    if (!nonce || !realm) {
      const code = challenge.attributes[ATTR.ERROR_CODE];
      return { ok: false, reason: `no challenge (code ${code ? code[2] : "?"})` };
    }

    const realmText = realm.toString("utf8");
    const key = longTermKey(username, realmText, password);
    const transactionId = crypto.randomBytes(12);
    const attributes = [
      attribute(ATTR.USERNAME, Buffer.from(username, "utf8")),
      attribute(ATTR.REALM, realm),
      attribute(ATTR.NONCE, nonce),
      attribute(ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))
    ];
    const partial = encode(TYPES.ALLOCATE_REQUEST, transactionId, attributes);
    const request = Buffer.concat([partial, messageIntegrity(partial, key)]);

    const second = await send(socket, host, port, request, timeout);
    if (!second) return { ok: false, reason: "no reply to the authenticated Allocate" };
    const answer = decode(second);
    if (answer.type === TYPES.ALLOCATE_SUCCESS) {
      const relayed = answer.attributes[ATTR.XOR_RELAYED_ADDRESS];
      return { ok: true, relayed: relayed ? decodeAddress(relayed) : null };
    }
    const code = answer.attributes[ATTR.ERROR_CODE];
    return {
      ok: false,
      reason: code ? `error ${code[2]}${code[3] ? `0${code[3]}` : ""} ${code.subarray(4).toString("utf8")}` : "not allocated"
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    socket.close();
  }
}

/* ------------------------------------------------------------------ report */

const STUN_CANDIDATES = [
  ["stun.l.google.com", 19302],
  ["stun1.l.google.com", 19302],
  ["stun.cloudflare.com", 3478],
  ["stun.nextcloud.com", 3478]
];

/* Free TURN relays. None of these is promised: the point of the script is to
   find out, from a real network, today. */
const TURN_CANDIDATES = [
  { name: "Open Relay (Metered) udp 80", host: "openrelay.metered.ca", port: 80, username: "openrelayproject", password: "openrelayproject" },
  { name: "Open Relay (Metered) udp 443", host: "openrelay.metered.ca", port: 443, username: "openrelayproject", password: "openrelayproject" },
  { name: "Open Relay standard turn 3478", host: "standard.relay.metered.ca", port: 3478, username: "openrelayproject", password: "openrelayproject" },
  { name: "freeturn.net udp 3478", host: "freeturn.net", port: 3478, username: null, password: null },
  { name: "turnix.io udp 3478", host: "turnix.io", port: 3478, username: null, password: null }
];

export async function runChecks({ json = false } = {}) {
  const report = { stun: [], turn: [] };

  for (const [host, port] of STUN_CANDIDATES) {
    const result = await stunCheck(host, port);
    report.stun.push({ server: `${host}:${port}`, ...result });
  }

  for (const candidate of TURN_CANDIDATES) {
    const bind = await stunCheck(candidate.host, candidate.port);
    if (!bind.ok) {
      report.turn.push({ server: candidate.name, ok: false, reason: `unreachable (${bind.reason})` });
      continue;
    }
    const needsAuth = candidate.username !== null;
    const result = needsAuth
      ? await turnCheck(candidate.host, candidate.port, candidate.username, candidate.password)
      : { ok: true, note: "reachable; credentials required to allocate" };
    report.turn.push({ server: candidate.name, ...result });
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const tick = (ok) => (ok ? "✓" : "✗");
  console.log("\nSTUN (address discovery — free, no account)\n");
  for (const entry of report.stun) {
    console.log(`  ${tick(entry.ok)} ${entry.server.padEnd(28)} ${entry.ok ? `mapped ${entry.mapped || "?"}` : entry.reason}`);
  }
  console.log("\nTURN (relay — needed when two networks cannot reach each other)\n");
  for (const entry of report.turn) {
    const detail = entry.ok ? entry.relayed || entry.note || "allocated" : entry.reason;
    console.log(`  ${tick(entry.ok)} ${entry.server.padEnd(32)} ${detail}`);
  }
  const working = report.turn.filter((entry) => entry.ok);
  console.log(
    working.length
      ? `\n${working.length} free relay(s) answered from this network.\n`
      : "\nNo free relay answered. A call between two different networks will keep failing without one.\n"
  );
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runChecks({ json: process.argv.includes("--json") });
}
