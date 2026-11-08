/* ==========================================================================
   Shinzora — purple flame aurora
   --------------------------------------------------------------------------
   One renderer for every atmospheric background in the product. It draws
   flowing ribbons of violet light — northern-lights bands rather than dots,
   circles or bubbles — onto a canvas and lets CSS blur them into luminous,
   flame-like haze.

   Why a canvas instead of a video or a stack of CSS blobs:
     • It responds to any viewport, including very tall hero sections.
     • The shapes are organic (summed sines), so no two frames repeat.
     • It is cheap: five filled paths per frame, no per-pixel work, no
       shadowBlur, and the expensive softness is a single GPU blur in CSS.

   Performance rules kept here:
     • backing store capped at devicePixelRatio 2, then scaled down again on
       small or low-power devices (the blur hides the lower resolution)
     • 30 fps ceiling — an aurora drifts, it never needs 60
     • paused when the canvas scrolls out of view or the tab is hidden
     • a single static frame for `prefers-reduced-motion: reduce`

   Usage
     <canvas data-aurora></canvas>
   or, for control,
     import { mountAurora } from "./aurora.js";
     const a = mountAurora(canvas, { intensity: 1.1 });
     a.start(); a.stop(); a.destroy();
   ========================================================================== */

const MAX_DPR = 2;
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

/* Palette: deep violet → bright lavender, with one warmer magenta band so the
   aurora reads as flame rather than as a flat blue-purple wash. */
const PALETTE = [
  ["rgba(76, 29, 149, 0)", "rgba(91, 33, 182, 0.55)", "rgba(168, 85, 247, 0.85)", "rgba(76, 29, 149, 0)"],
  ["rgba(46, 16, 101, 0)", "rgba(124, 88, 237, 0.42)", "rgba(196, 181, 253, 0.62)", "rgba(46, 16, 101, 0)"],
  ["rgba(59, 7, 100, 0)", "rgba(147, 51, 234, 0.40)", "rgba(232, 121, 249, 0.52)", "rgba(59, 7, 100, 0)"],
  ["rgba(30, 10, 60, 0)", "rgba(109, 40, 217, 0.34)", "rgba(167, 139, 250, 0.55)", "rgba(30, 10, 60, 0)"],
  ["rgba(24, 8, 48, 0)", "rgba(88, 28, 135, 0.30)", "rgba(139, 92, 246, 0.45)", "rgba(24, 8, 48, 0)"]
];

/* Each ribbon is a vertical band whose centreline and thickness wander with
   three summed sines. Base values are fractions of the canvas height so the
   composition holds at every size. */
const RIBBONS = [
  { base: 0.30, amp: 0.105, amp2: 0.045, freq: 0.62, freq2: 1.35, freq3: 0.9, thick: 0.115, speed: 0.42, phase: 0.0 },
  { base: 0.46, amp: 0.088, amp2: 0.055, freq: 0.85, freq2: 1.10, freq3: 1.4, thick: 0.090, speed: -0.31, phase: 1.7 },
  { base: 0.62, amp: 0.115, amp2: 0.035, freq: 0.48, freq2: 1.62, freq3: 1.1, thick: 0.130, speed: 0.24, phase: 3.4 },
  { base: 0.78, amp: 0.075, amp2: 0.040, freq: 0.72, freq2: 0.95, freq3: 1.7, thick: 0.085, speed: -0.21, phase: 5.1 },
  { base: 0.22, amp: 0.062, amp2: 0.030, freq: 1.05, freq2: 1.75, freq3: 0.8, thick: 0.070, speed: 0.36, phase: 2.2 }
];

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function isLowPower() {
  const cores = navigator.hardwareConcurrency || 8;
  const memory = navigator.deviceMemory || 8;
  const connection = navigator.connection || {};
  return (
    cores <= 2 ||
    memory <= 2 ||
    connection.saveData === true ||
    /(^|-)2g$/.test(connection.effectiveType || "")
  );
}

/**
 * Mount the aurora renderer on a canvas element.
 * Returns { start, stop, destroy, redraw }.
 */
export function mountAurora(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") return null;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  const intensity = options.intensity ?? 1;
  const lowPower = options.lowPower ?? isLowPower();
  let width = 0;
  let height = 0;
  let scale = 1;
  let raf = 0;
  let running = false;
  let destroyed = false;
  let last = 0;
  let t = 0;

  function resize() {
    let rect = canvas.getBoundingClientRect();
    /* Belt and braces: a canvas with no grown box (missing CSS, or a wrapper
       that sizes after us) would paint a 1×1 surface and look like a dead
       background. Fall back to the parent's box. */
    if (rect.width < 2 || rect.height < 2) {
      const parent = canvas.parentElement;
      if (parent) rect = parent.getBoundingClientRect();
    }
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    if (cssW === width && cssH === height) return;

    width = cssW;
    height = cssH;
    /* Extra downscale on small screens and low-power devices. The CSS blur is
       far larger than the lost resolution, so nothing looks soft-edged. */
    const base = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    scale = base * (lowPower ? 0.5 : cssW < 720 ? 0.7 : 0.85);

    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw(t);
  }

  function draw(time) {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";

    for (let r = 0; r < RIBBONS.length; r += 1) {
      const cfg = RIBBONS[r];
      const colours = PALETTE[r % PALETTE.length];
      const steps = width < 480 ? 32 : 52;
      const top = [];
      const bottom = [];
      const centreLine = [];

      for (let i = 0; i <= steps; i += 1) {
        const nx = i / steps;
        const x = nx * width;

        /* Two counter-moving waves plus a third that only shapes the edge:
           counter-motion is what makes a band look alive instead of swaying. */
        const centre =
          height * cfg.base +
          Math.sin(nx * cfg.freq * Math.PI * 2 + time * cfg.speed + cfg.phase) * height * cfg.amp +
          Math.sin(nx * cfg.freq2 * Math.PI * 2 - time * cfg.speed * 0.7 + cfg.phase * 1.7) *
            height * cfg.amp2;

        const thickness =
          height *
          cfg.thick *
          (0.55 + 0.45 * Math.sin(nx * cfg.freq3 * Math.PI * 2 + time * cfg.speed * 0.9 + cfg.phase * 0.6));

        top.push([x, centre - thickness]);
        bottom.push([x, centre + thickness]);
        centreLine.push([x, centre]);
      }

      const centreAt = height * cfg.base;
      const gradient = ctx.createLinearGradient(0, centreAt - height * 0.34, 0, centreAt + height * 0.34);
      gradient.addColorStop(0, colours[0]);
      gradient.addColorStop(0.34, colours[1]);
      gradient.addColorStop(0.52, colours[2]);
      gradient.addColorStop(1, colours[3]);

      ctx.globalAlpha = Math.min(1, 0.9 * intensity);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i += 1) ctx.lineTo(top[i][0], top[i][1]);
      for (let i = bottom.length - 1; i >= 0; i -= 1) ctx.lineTo(bottom[i][0], bottom[i][1]);
      ctx.closePath();
      ctx.fill();

      /* A thin, brighter filament along the centre of each band. This is what
         separates an aurora from a soft gradient: the eye reads a luminous
         edge with haze around it. Width tapers toward the ends so the ribbon
         never terminates on a hard stroke cap. */
      const filament = ctx.createLinearGradient(0, 0, width, 0);
      filament.addColorStop(0, "rgba(196, 181, 253, 0)");
      filament.addColorStop(0.28, colours[1]);
      filament.addColorStop(0.52, colours[2]);
      filament.addColorStop(0.78, colours[1]);
      filament.addColorStop(1, "rgba(196, 181, 253, 0)");
      ctx.globalAlpha = Math.min(1, 0.55 * intensity);
      ctx.strokeStyle = filament;
      ctx.lineWidth = Math.max(1.2, height * 0.004);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(centreLine[0][0], centreLine[0][1]);
      for (let i = 1; i < centreLine.length; i += 1) ctx.lineTo(centreLine[i][0], centreLine[i][1]);
      ctx.stroke();
    }

    /* A single warm bloom near the top third gives the aurora a "source" so it
       does not read as an abstract gradient. */
    const bloom = ctx.createRadialGradient(
      width * 0.34,
      height * 0.12,
      0,
      width * 0.34,
      height * 0.12,
      Math.max(width, height) * 0.55
    );
    bloom.addColorStop(0, `rgba(168, 85, 247, ${0.20 * intensity})`);
    bloom.addColorStop(0.45, `rgba(109, 40, 217, ${0.10 * intensity})`);
    bloom.addColorStop(1, "rgba(24, 8, 48, 0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = "source-over";
  }

  function loop(now) {
    if (!running || destroyed) return;
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS) return;
    const delta = last ? Math.min(now - last, 120) : 16;
    last = now;
    /* Slow, framerate-independent drift: the composition advances ~0.05 rad/s. */
    t += (delta / 1000) * 1.0;
    draw(t);
  }

  function start() {
    if (running || destroyed) return;
    if (reducedMotion()) {
      draw(0);
      return;
    }
    running = true;
    last = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function destroy() {
    stop();
    destroyed = true;
    observer?.disconnect();
    ro?.disconnect();
  }

  /* Pause offscreen and in background tabs: an aurora behind the fold costs
     battery for nothing. */
  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          ([entry]) => (entry.isIntersecting && !document.hidden ? start() : stop()),
          { rootMargin: "80px" }
        )
      : null;

  const ro = "ResizeObserver" in window ? new ResizeObserver(() => resize()) : null;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (observer) start();
  });

  /* The footer's pause switch (WCAG 2.2.2) stops the canvas on a still frame
     and resumes the drift when motion is turned back on. */
  document.documentElement.addEventListener("shinzora:motion", (event) => {
    if (event.detail.paused) {
      stop();
      draw(0);
    } else if (!document.hidden) {
      start();
    }
  });

  const onMotionChange = (event) => {
    if (event.matches) {
      stop();
      draw(0);
    } else {
      start();
    }
  };
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", onMotionChange);

  resize();
  observer?.observe(canvas);
  ro?.observe(canvas);

  /* Without an observer (very old browsers) just run. */
  if (!observer) start();

  return { start, stop, destroy, redraw: () => draw(t) };
}

/**
 * Mount every `<canvas data-aurora>` on the page. Safe to call more than once;
 * an already-mounted canvas is skipped. Any element carrying
 * `data-aurora-fallback` gets a static CSS gradient instead, which is also what
 * happens when canvas 2D is unavailable.
 */
export function autoMountAurora() {
  const canvases = document.querySelectorAll("canvas[data-aurora]");
  const mounted = [];

  for (const canvas of canvases) {
    if (canvas.dataset.auroraMounted === "true") continue;
    const instance = mountAurora(canvas, {
      intensity: Number(canvas.dataset.auroraIntensity || 1)
    });
    if (instance) {
      canvas.dataset.auroraMounted = "true";
      mounted.push({ canvas, instance });
    } else {
      canvas.hidden = true;
    }
  }

  if (mounted.length) {
    document.documentElement.classList.add("has-aurora");
    window.addEventListener("pagehide", () => mounted.forEach(({ instance }) => instance.stop()));
  }

  return mounted;
}

/* Module scripts execute after parsing, so the DOM is ready here. */
if (typeof document !== "undefined") autoMountAurora();

export default autoMountAurora;
