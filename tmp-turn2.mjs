import net from "node:net";
import crypto from "node:crypto";
import { turnCheck, stunCheck } from "./scripts/turn-check.mjs";

const hosts = [
  ["standard.relay.metered.ca", 3478, "openrelayproject", "openrelayproject"],
  ["global.relay.metered.ca", 3478, "openrelayproject", "openrelayproject"],
  ["standard.relay.metered.ca", 80, "openrelayproject", "openrelayproject"],
];
for (const [h, p, u, pw] of hosts) {
  const stun = await stunCheck(h, p);
  console.log(h + ":" + p, "stun", JSON.stringify(stun));
  if (stun.ok) console.log("   turn", JSON.stringify(await turnCheck(h, p, u, pw)));
}
