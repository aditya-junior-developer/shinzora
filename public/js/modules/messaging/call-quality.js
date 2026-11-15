/* ==========================================================================
   Shinzora · Call quality (P8)
   --------------------------------------------------------------------------
   Pure functions that turn WebRTC statistics into one quality level and one
   video bitrate ceiling. Kept free of browser APIs so the thresholds can be
   tested exactly. The engine feeds them numbers from getStats(); nothing here
   guesses at a network it cannot measure.

   Levels: good, fair, poor, unknown. "unknown" means no measurement yet, and
   the UI must not show a warning for it.
   ========================================================================== */

/* Round-trip time (seconds), packet loss (0..1) and outgoing bitrate headroom
   (bits per second). These are the standard getStats() fields. */
export function classifyQuality({ rttSeconds, lossRatio, availableOutgoingBps } = {}) {
  const measured = [rttSeconds, lossRatio, availableOutgoingBps].some((v) => Number.isFinite(v));
  if (!measured) return "unknown";

  const rttMs = Number.isFinite(rttSeconds) ? rttSeconds * 1000 : 0;
  const loss = Number.isFinite(lossRatio) ? lossRatio : 0;
  const headroom = Number.isFinite(availableOutgoingBps) ? availableOutgoingBps : Infinity;

  if (loss >= 0.08 || rttMs >= 600 || headroom < 150_000) return "poor";
  if (loss >= 0.03 || rttMs >= 300 || headroom < 500_000) return "fair";
  return "good";
}

/* The most video a sender should push for each level. Audio is never capped:
   a call with a broken picture is still usable, a call with broken audio is not. */
export const VIDEO_BITRATE_BPS = Object.freeze({
  good: 1_500_000,
  fair: 600_000,
  poor: 200_000,
  unknown: 1_500_000
});

export function videoBitrateFor(level) {
  return VIDEO_BITRATE_BPS[level] ?? VIDEO_BITRATE_BPS.unknown;
}

/* Reduces a getStats() report to the three numbers classifyQuality needs.
   Accepts a Map or an array of report entries, as browsers differ. */
export function summariseStats(report) {
  /* A Map (the browser's own report) and an array both enumerate with forEach. */
  const entries = [];
  if (report && typeof report.forEach === "function") report.forEach((entry) => entries.push(entry));

  let rttSeconds;
  let availableOutgoingBps;
  let packetsSent = 0;
  let packetsLost = 0;

  for (const entry of entries) {
    if (entry.type === "candidate-pair" && entry.nominated && entry.state !== "failed") {
      if (Number.isFinite(entry.currentRoundTripTime)) rttSeconds = entry.currentRoundTripTime;
      if (Number.isFinite(entry.availableOutgoingBitrate)) availableOutgoingBps = entry.availableOutgoingBitrate;
    }
    if (entry.type === "remote-inbound-rtp") {
      if (Number.isFinite(entry.packetsLost)) packetsLost += Math.max(0, entry.packetsLost);
      if (Number.isFinite(entry.roundTripTime) && rttSeconds === undefined) rttSeconds = entry.roundTripTime;
    }
    if (entry.type === "outbound-rtp" && Number.isFinite(entry.packetsSent)) {
      packetsSent += Math.max(0, entry.packetsSent);
    }
  }

  const lossRatio = packetsSent > 0 ? Math.min(1, packetsLost / (packetsSent + packetsLost)) : undefined;
  return { rttSeconds, lossRatio, availableOutgoingBps };
}

/* Whether to show the user a warning. Only sustained poor or fair links count,
   so a single bad sample does not flash a banner. */
export function shouldWarn(history = []) {
  const recent = history.slice(-3);
  return recent.length === 3 && recent.every((level) => level === "poor" || level === "fair")
    ? recent.includes("poor") ? "poor" : "fair"
    : null;
}
