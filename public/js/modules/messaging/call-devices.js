/* ==========================================================================
   Shinzora · Call devices (P8)
   --------------------------------------------------------------------------
   Lists the microphones, cameras and speakers the browser can use, and builds
   the capture constraints for a chosen device. The browser only reveals device
   labels after the user has granted permission, so an unlabelled device is
   shown with a numbered name rather than a blank.
   ========================================================================== */

/** Group the output of enumerateDevices() into the three kinds a call uses. */
export function groupDevices(list = []) {
  const groups = { microphones: [], cameras: [], speakers: [] };
  let mic = 0;
  let cam = 0;
  let spk = 0;
  for (const device of list) {
    if (device.kind === "audioinput") {
      mic += 1;
      groups.microphones.push({ id: device.deviceId, label: device.label || `Microphone ${mic}` });
    } else if (device.kind === "videoinput") {
      cam += 1;
      groups.cameras.push({ id: device.deviceId, label: device.label || `Camera ${cam}` });
    } else if (device.kind === "audiooutput") {
      spk += 1;
      groups.speakers.push({ id: device.deviceId, label: device.label || `Speaker ${spk}` });
    }
  }
  return groups;
}

/** Capture constraints for a chosen microphone and camera. An empty id means "the default". */
export function captureConstraints({ microphoneId = "", cameraId = "", video = true } = {}) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(microphoneId ? { deviceId: { exact: microphoneId } } : {})
  };
  const camera = video
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, ...(cameraId ? { deviceId: { exact: cameraId } } : {}) }
    : false;
  return { audio, video: camera };
}

/** Whether this browser can route call audio to a chosen speaker. */
export function canChooseSpeaker() {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** Enumerate devices. Returns empty groups where the API is unavailable. */
export async function listCallDevices() {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) {
    return groupDevices([]);
  }
  try {
    return groupDevices(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return groupDevices([]);
  }
}
