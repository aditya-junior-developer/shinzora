/* ==========================================================================
   Shinzora — app packages
   --------------------------------------------------------------------------
   The app builder produces a mobile application. This module is the part that
   knows what a package is, which platform owns which format, what a plan is
   allowed to build, and what is still missing before a package can honestly be
   called finished.

   The rules it encodes are the ones the product must never break:

     • APK and AAB are Android. IPA is iOS. There is no iOS AAB.
     • Free and Pro target one platform. Enterprise targets Android and iOS.
     • A conversion job is only "built" when a file exists with a checksum —
       a status without an artifact is a claim, not a build.
     • An IPA cannot be produced without an Apple Developer team, a
       distribution certificate and a provisioning profile. Saying otherwise
       would be a lie in a button label.

   Pure module: no DOM, no network.
   ========================================================================== */

import { APP_TARGETS } from "../modules/dashboard/builder/stages.js";

export { APP_TARGETS };

/** Every format, with the platform it belongs to — the whole truth, once. */
export const PACKAGE_FORMATS = {
  apk: { platform: "android", label: "Android APK", extension: ".apk" },
  aab: { platform: "android", label: "Android AAB", extension: ".aab" },
  ipa: { platform: "ios", label: "iOS IPA", extension: ".ipa" }
};

/** True only for the pairings that can install on a device. */
export function isCorrectPairing(platform, target) {
  const format = PACKAGE_FORMATS[target];
  return Boolean(format) && format.platform === platform;
}

/** What a plan may build, given the number of platform slots it is entitled to. */
export function packageOptions(slots) {
  const allowance = Number(slots) >= 2 ? 2 : 1;
  return APP_TARGETS.map((option) => {
    const locked = option.platform === "ios" && allowance < 2;
    return {
      platform: option.platform,
      target: option.target,
      label: option.label,
      note: option.note,
      extension: option.extension,
      locked,
      reason: locked
        ? "Your plan targets one platform. Android APK and AAB are available; building for Android and iOS at once needs Enterprise."
        : ""
    };
  });
}

/** The option a customer picked, resolved from the two identifiers. */
export function resolveTarget(target) {
  const format = PACKAGE_FORMATS[target];
  if (!format) return null;
  return {
    target,
    platform: format.platform,
    label: format.label,
    extension: format.extension
  };
}

/** A package id must be a reverse-DNS name that a device can install. */
export function isValidPackageId(value) {
  const text = String(value || "").trim();
  /* At least two segments, each starting with a letter, no underscores, and not
     starting with the reserved "java." prefix. */
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,}$/.test(text)) return false;
  if (text.startsWith("java.") || text.startsWith("android.")) return false;
  if (text.length > 155) return false;
  return true;
}

/** Suggest a package id from a business name, which the customer can change. */
export function suggestPackageId(name, domainish = "in.shinzora") {
  const slug = String(name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
  return `${domainish}.${slug || "app"}`;
}

/**
 * What is genuinely required before a format can be produced.
 *
 * These are not UI hints: they are the inputs the toolchain needs, and until
 * they exist no build can happen.
 */
export function signingRequirements(target) {
  const format = PACKAGE_FORMATS[target];
  if (!format) return [];
  if (format.platform === "android") {
    return [
      { id: "toolchain", label: "Android build toolchain", detail: "A JDK, the Android SDK and the build tools on the build server." },
      { id: "keystore", label: "Signing keystore", detail: "A .jks keystore, its alias and its two passwords. Held server-side only." },
      {
        id: "wrapper",
        label: "WebView wrapper",
        detail: "The native project that loads the generated index.html inside a WebView."
      }
    ];
  }
  return [
    { id: "toolchain", label: "macOS build host with Xcode", detail: "An IPA can only be built on macOS with Xcode; there is no cross-platform path." },
    { id: "team", label: "Apple Developer team", detail: "A paid Apple Developer account with a team identifier." },
    { id: "certificate", label: "Distribution certificate", detail: "The signing certificate (.p12) and its password." },
    { id: "profile", label: "Provisioning profile", detail: "A profile that matches the bundle id and the certificate." }
  ];
}

/**
 * Checks that the generated document is an app, not a website in a phone-sized
 * window. Each result is measured from the document, never assumed.
 */
export function validateMobileApp(html) {
  const doc = String(html || "");
  const issues = [];
  const add = (level, code, title, detail) => issues.push({ level, code, title, detail });

  const viewportTag = doc.match(/<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i)?.[0] || "";
  const hasViewport = Boolean(viewportTag);
  const deviceWidth = /width\s*=\s*device-width/i.test(viewportTag);
  const zoomLocked = /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i.test(viewportTag);

  if (!hasViewport) {
    add("error", "app-viewport", "Not a mobile layout", "There is no viewport meta tag, so the app would render as a zoomed-out desktop page on a phone.");
  } else if (!deviceWidth) {
    add("error", "app-device-width", "Not a mobile layout", "The viewport does not set width=device-width, so the layout is not sized to the device.");
  }
  if (zoomLocked) {
    add("warning", "app-zoom", "Pinch zoom disabled", "user-scalable=no or maximum-scale=1 stops the user zooming, which hurts accessibility.");
  }

  const mediaQueries = (doc.match(/@media[^{]*\([^)]*(max|min)-width/gi) || []).length;
  const mobileFirst = (doc.match(/@media[^{]*\(max-width/gi) || []).length;
  const fluid = (doc.match(/(\d+(\.\d+)?)(%|vw|dvh|vh|rem|fr)\b/gi) || []).length;
  const fixedWide = [...doc.matchAll(/(?:^|[;{\s])width\s*:\s*(\d{3,4})px/gi)]
    .map((match) => Number(match[1]))
    .filter((pixels) => pixels > 480);

  if (fixedWide.length) {
    add("error", "app-fixed-width", "Desktop-sized layout", `${fixedWide.length} element(s) are wider than a phone screen (fixed widths above 480px), so the app will overflow on a handset.`);
  }
  if (!mediaQueries && fluid < 4) {
    add("warning", "app-no-breakpoints", "No responsive rules", "The layout uses no media queries and very few fluid units, so it will not adapt between a small phone and a large one.");
  }

  /* A touch interface, not a pointer one. */
  const hasTouchSignals = /touch-action|tap-highlight|-webkit-overflow-scrolling|pointerdown|touchstart|ontouchstart|hairline/i.test(doc);
  const hasHover = /:hover\s*\{/i.test(doc);
  if (!hasTouchSignals) {
    add("warning", "app-touch", "No touch handling", "The document has no touch-related styles or handlers; taps may fight with hover states meant for a mouse.");
  }
  if (hasHover && !/pointer:\s*coarse/.test(doc)) {
    add("info", "app-hover", "Hover effects on a touch screen", "Hover rules without a pointer: coarse guard can leave controls looking stuck after a tap.");
  }

  /* An app has screens and a way between them. */
  const routes = new Set([...doc.matchAll(/data-route\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]));
  if (routes.size < 2) {
    add("warning", "app-screens", "Only one screen", "The app has a single screen; an app normally needs at least a home screen and one more.");
  }
  const navigates = /href\s*=\s*["']#\/|location\.hash|history\.pushState|data-screen/i.test(doc);
  if (routes.size >= 2 && !navigates) {
    add("warning", "app-navigation", "Screens are not reachable", "There is more than one screen but nothing links between them.");
  }

  const forbidden = /<iframe\b/i.test(doc) ? 1 : 0;
  if (forbidden) {
    add("warning", "app-iframe", "Embedded frame", "The app embeds another page in an iframe, which will not work inside a WebView wrapper without a permission change.");
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.level] += 1;

  return {
    issues,
    counts,
    ok: counts.error === 0,
    mobile: hasViewport && deviceWidth && fixedWide.length === 0,
    routes: [...routes],
    metrics: { mediaQueries, mobileFirst, fluid, fixedWide: fixedWide.length }
  };
}

/**
 * The honest label for a conversion job.
 *
 * The status alone is not enough: a job marked 'built' without an artifact and
 * a checksum is not a build, and this function refuses to describe it as one.
 */
export function describeConversionJob(job) {
  const status = String(job?.status || "queued");
  const hasArtifact = Boolean(job?.artifact_path) && Boolean(job?.artifact_sha256 || job?.artifact_bytes);
  const target = String(job?.target || "");

  if (status === "built" && hasArtifact) {
    return {
      state: "built",
      label: "Package built",
      detail: `${PACKAGE_FORMATS[target]?.label || target} · checksum recorded. Download it from this page.`,
      downloadable: true
    };
  }
  if (status === "built" && !hasArtifact) {
    /* Never happens with the database constraints in place; if it ever does,
       the customer is told the truth rather than shown a download button. */
    return {
      state: "unverified",
      label: "Reported built, but no file is attached",
      detail: "No package file or checksum is recorded, so there is nothing to download. This is a fault, not a build.",
      downloadable: false
    };
  }

  const table = {
    queued: {
      state: "queued",
      label: "Queued",
      detail: "The build request is saved. No package exists yet — the build service has not started on it.",
      downloadable: false
    },
    running: {
      state: "running",
      label: "Building",
      detail: "The build service is assembling and signing the package now.",
      downloadable: false
    },
    awaiting_toolchain: {
      state: "awaiting_toolchain",
      label: "Waiting on a build toolchain",
      detail:
        PACKAGE_FORMATS[target]?.platform === "ios"
          ? "No package exists yet. An IPA needs a macOS build host, an Apple Developer team, a distribution certificate and a provisioning profile."
          : "No package exists yet. An APK or AAB needs a JDK, the Android SDK, the WebView wrapper project and a signing keystore on the build server.",
      downloadable: false
    },
    failed: {
      state: "failed",
      label: "Build failed",
      detail: job?.error ? String(job.error).slice(0, 300) : "The build service reported a failure.",
      downloadable: false
    },
    expired: {
      state: "expired",
      label: "Expired",
      detail: "The artifact was removed from storage. Request the build again.",
      downloadable: false
    }
  };

  return (
    table[status] || {
      state: status,
      label: status,
      detail: "This build has an unrecognised status.",
      downloadable: false
    }
  );
}

/** Everything the customer has to supply before a package can be requested. */
export function packageReadiness({ target, appName, packageId, icon }) {
  const problems = [];
  const format = PACKAGE_FORMATS[target];
  if (!format) problems.push({ field: "target", message: "Choose a package format: APK, AAB or IPA." });
  if (!String(appName || "").trim()) problems.push({ field: "appName", message: "The app needs a name — it appears under the icon." });
  if (String(appName || "").trim().length > 60) problems.push({ field: "appName", message: "Keep the app name under 60 characters." });
  if (!isValidPackageId(packageId)) {
    problems.push({ field: "packageId", message: "The package id must look like in.shinzora.yourapp — letters, digits and dots, at least two parts." });
  }
  if (!icon) problems.push({ field: "icon", message: "An app icon is required (512×512 PNG is the safe choice)." });
  return problems;
}
