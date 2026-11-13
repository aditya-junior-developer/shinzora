/* ==========================================================================
   Shinzora · Answering a call from anywhere
   --------------------------------------------------------------------------
   A ring can arrive on any page — the inbox, settings, the admin console, a
   background tab. Before this file existed the only button on the ring banner
   was "Join", which navigated to the messages view and dropped the call: the
   callee arrived somewhere that knew nothing about the invite, and the caller
   rang until the invite expired. That is the "ringing but never connects"
   defect, and a link cannot fix it.

   What answering actually needs is a click (for the microphone prompt and the
   audio unlock), the invite, and a call object. All three are available
   outside the messages view, so the answer happens here and the call panel
   opens over whatever page the member is on.

   The database decides whether the answer is allowed: `call_invite_answer`
   checks membership, checks the invite has not expired, writes the response
   row and stops the ring. If it throws, nothing is opened and the reason is
   shown — the browser never grants itself access to a call.
   ========================================================================== */

import { sb, normalizeError } from "../../lib/supabase.js";
import { state } from "../../lib/store.js";
import { toast, toastError } from "../../ui/toast.js";
import { setCallAnswerer } from "../../ui/notify.js";
import { createCall, callTopics } from "./webrtc.js";
import { openCallSurface } from "./call-ui.js";

async function rpc(name, args = {}) {
  if (!sb) throw new Error("Calls are not available right now.");
  const { data, error } = await sb.rpc(name, args);
  if (error) throw normalizeError(error);
  return data;
}

/** The signed-in member, as the call engine and the tiles want it. */
function selfIdentity() {
  const profile = state?.profile || state?.user || {};
  return {
    userId: profile.id || profile.userId || null,
    name: profile.full_name || profile.fullName || profile.name || "You"
  };
}

/* One call surface per tab. Answering a second ring while already in a call
   replaces nothing silently: the new call is refused with a reason. */
let liveCall = null;

/**
 * Accept a ring on `topic`.
 *
 * Returns true when the member is now in the call. Throws (after showing why)
 * when the invite is gone, expired, or not theirs.
 */
export async function answerCall(topic, { kind = "voice", title = "" } = {}) {
  if (!topic) throw new Error("That call invite has no room attached.");
  if (liveCall) {
    toast({ title: "Already in a call", message: "Leave the current call before answering another." }, { tone: "info" });
    return false;
  }

  /* The server is the authority on whether this answer is allowed, and on
     what kind of call it is. */
  const answer = await rpc("call_invite_answer", { p_topic: topic });
  const self = selfIdentity();
  if (!self.userId) {
    /* Signed out between the ring and the click: nothing to join with. */
    throw new Error("Your session has expired. Sign in again to answer calls.");
  }

  const resolvedKind = answer?.kind || kind;
  const call = createCall({
    kind: resolvedKind,
    topic: answer?.topic || topic,
    title: title || answer?.starterName || "Call",
    self
  });
  liveCall = call;

  const subtitle =
    resolvedKind === "video"
      ? "Video call · connected through Shinzora"
      : "Voice call · connected through Shinzora";

  openCallSurface({
    call,
    self,
    subtitle,
    onClose: () => {
      if (liveCall === call) liveCall = null;
    }
  });

  try {
    /* Accepting a video ring with no camera is still a call; the engine falls
       back to audio and says so rather than failing the answer. */
    await call.join({ audioOnly: resolvedKind === "voice" });
    return true;
  } catch (error) {
    const message = String(error?.message || "");
    if (resolvedKind === "video" && /camera|video|permission|denied/i.test(message)) {
      try {
        await call.join({ audioOnly: true });
        toastError(new Error("Joined with the microphone only — the camera was not available."));
        return true;
      } catch (second) {
        toastError(second);
        return false;
      }
    }
    toastError(error);
    return false;
  }
}

/**
 * Refuse a ring.
 *
 * Writes the decline so the caller is told immediately instead of listening to
 * an unanswered ring, and so the caller's surface can show "declined" rather
 * than "no answer".
 */
export async function declineCall(topic, { name = "They" } = {}) {
  if (!topic) return false;
  try {
    await rpc("call_invite_decline", { p_topic: topic });
    toast({ title: "Call declined", message: `You did not join ${name === "They" ? "the call" : `${name}'s`} call.` }, { tone: "info" });
    return true;
  } catch (error) {
    /* An expired invite cannot be declined; that is not worth an error toast,
       but a genuine permission failure is. */
    const message = String(error?.message || "");
    if (/no longer|not part of|gone/i.test(message)) return false;
    toastError(error);
    return false;
  }
}

/** Tell the notification layer how to answer, once per page. */
export function registerIncomingCalls() {
  setCallAnswerer({
    answer: (row) => {
      const meta = row?.meta || {};
      return answerCall(meta.callTopic, {
        kind: meta.callKind || "voice",
        title: meta.senderName || row?.title || "Call"
      });
    },
    decline: (row) => declineCall(row?.meta?.callTopic, { name: row?.meta?.senderName || "They" })
  });
}

export { callTopics };
