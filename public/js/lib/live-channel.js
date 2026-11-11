/* ==========================================================================
   Shinzora · Live channels
   --------------------------------------------------------------------------
   supabase-js keys Realtime channels by topic, and `removeChannel()` is
   asynchronous. Clicking between two groups therefore did this:

     removeChannel(old)            // starts closing, returns a promise
     channel('group-live:<id>')    // hands back the channel that still exists
     .on('postgres_changes', ...)  // throws:
                                   // "cannot add postgres_changes callbacks
                                   //  for realtime:group-live:<id> after
                                   //  subscribe()"

   Two devices joining the same topic is a second, related problem: the old
   channel must be fully gone before the new one is created, or the socket is
   asked to join a topic it is already on.

   So every live channel here is opened through this module: one channel per
   key, the previous one closed and awaited before its replacement exists, and
   the newest request always wins (a slow close can never resurrect a channel
   for a group the reader has already left).

   Nothing in here touches the topic string, so a private channel keeps the
   exact topic its `realtime.messages` policy checks.
   ========================================================================== */

/** Channel per key, with the promise that covers its whole lifetime. */
const registry = new Map();

function detach(sb, channel) {
  if (!sb || !channel) return Promise.resolve();
  try {
    const result = sb.removeChannel(channel);
    if (result && typeof result.then === "function") return result.catch(() => {});
  } catch {
    /* already gone — nothing to close */
  }
  return Promise.resolve();
}

/**
 * Open (or replace) the live channel stored under `key`.
 *
 * @param {object} sb            the Supabase client
 * @param {string} key           our name for the channel, e.g. "group-live"
 * @param {object} options
 * @param {string} options.topic the Realtime topic to join
 * @param {(channel:object)=>object} options.bind
 *        register every `.on()` handler here and return the channel; this runs
 *        before `subscribe()`, which is the only safe order
 * @param {(status:string)=>void} [options.onStatus]
 * @returns {{ close: () => Promise<void>, ready: Promise<void> }}
 */
export function openLiveChannel(sb, key, { topic, bind, onStatus } = {}) {
  if (!sb || !topic || typeof bind !== "function") {
    return { close: () => Promise.resolve(), ready: Promise.resolve() };
  }

  const previous = registry.get(key);
  const entry = { sb, channel: null, closed: false };
  registry.set(key, entry);

  const close = () => {
    entry.closed = true;
    if (registry.get(key) === entry) registry.delete(key);
    entry.settled = (entry.settled || Promise.resolve()).then(() => detach(sb, entry.channel));
    return entry.settled;
  };

  entry.settled = (async () => {
    /* Wait for the channel we are replacing, then take it out of the client
       entirely — waiting alone would leave it subscribed forever. */
    if (previous) {
      await previous.settled;
      await detach(sb, previous.channel);
    }
    /* Somebody asked for a different channel while we were waiting. */
    if (entry.closed || registry.get(key) !== entry) return;
    const channel = bind(sb.channel(topic));
    entry.channel = channel;
    channel.subscribe(onStatus);
  })().catch(() => {});

  return { close, ready: entry.settled };
}

/** Close the channel stored under `key`, if there is one. */
export function closeLiveChannel(key) {
  const entry = registry.get(key);
  if (!entry) return Promise.resolve();
  entry.closed = true;
  registry.delete(key);
  entry.settled = (entry.settled || Promise.resolve()).then(() => detach(entry.sb, entry.channel));
  return entry.settled;
}

/**
 * Close any channel still holding `topic` and wait until it has left.
 *
 * The call itself owns a topic outright and cannot rename it (its
 * `realtime.messages` policy matches `call-group:<id>` exactly), so before a
 * call joins it must be certain the previous channel for that topic is gone.
 * `sb.channel(topic)` otherwise returns the old, already-subscribed channel and
 * the new join never happens — which surfaced as "The call channel did not
 * open." after a 15-second timeout.
 */
export async function releaseTopic(sb, topic) {
  if (!sb || !topic) return;
  const wanted = topic.startsWith("realtime:") ? topic : `realtime:${topic}`;
  const existing = (typeof sb.getChannels === "function" ? sb.getChannels() : []).filter(
    (channel) => channel?.topic === wanted
  );
  await Promise.all(existing.map((channel) => detach(sb, channel)));
}

/** Close everything — used when the app shell is torn down. */
export function closeAllLiveChannels() {
  const keys = [...registry.keys()];
  return Promise.all(keys.map((key) => closeLiveChannel(key)));
}

/** How many live channels this page currently holds — for the tests. */
export function liveChannelCount() {
  return registry.size;
}
