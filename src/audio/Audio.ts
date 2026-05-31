/**
 * Audio.ts — Flow Cube synthesized sound system.
 *
 * A tiny, premium-feeling sound-effects engine built entirely on the Web Audio
 * API. No audio asset files: every sound is generated at runtime from
 * oscillators, noise buffers, gain envelopes and filters.
 *
 * iOS-Safari note: an AudioContext starts in the "suspended" state until a
 * user gesture resumes it. Call {@link GameAudio.unlock} from the first
 * pointerdown / touchend handler. All scheduling is wrapped in try/catch and
 * gracefully degrades to no-ops if the Web Audio API is unavailable.
 */

/** Minimal typing for the prefixed webkit AudioContext on older Safari. */
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/** Tiny epsilon used as the target of exponential ramps (never ramp to 0). */
const EPSILON = 0.0001;

export class GameAudio {
  /** The shared AudioContext, or null if creation failed / not yet created. */
  private ctx: AudioContext | null = null;
  /** Master gain node; everything routes through this. */
  private master: GainNode | null = null;
  /** Reusable 1s white-noise buffer, lazily generated once. */
  private noiseBuffer: AudioBuffer | null = null;
  /** Whether audio is currently muted. */
  private _muted = false;
  /** Base master volume when un-muted. */
  private readonly masterVolume = 0.5;
  /** Set if Web Audio is unsupported / construction failed — methods no-op. */
  private failed = false;

  constructor() {
    // Deliberately do NOT create the AudioContext here. We create it lazily
    // (still fine to create suspended) so the first interaction owns it, which
    // keeps iOS Safari happy. The constructor never throws.
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Resume the AudioContext. Call on the first user gesture (pointerdown).
   * Safe to call repeatedly.
   */
  unlock(): void {
    if (this.failed) return;
    try {
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        // resume() returns a promise; ignore rejections (e.g. no gesture yet).
        void ctx.resume().catch(() => undefined);
      }
    } catch {
      this.failed = true;
    }
  }

  /** Layer rotation committed — a soft woody "thock"/snap. */
  snap(): void {
    this.withContext((ctx, now) => {
      // --- Woody body: triangle osc with a fast downward pitch drop. ---
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const oscGain = ctx.createGain();

      // Slight lowpass to round off the edge and keep it "woody", not buzzy.
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.setValueAtTime(1200, now);

      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(90, now + 0.08);

      // Quick percussive envelope (~90ms total).
      const peak = 0.22;
      oscGain.gain.setValueAtTime(EPSILON, now);
      oscGain.gain.linearRampToValueAtTime(peak, now + 0.004);
      oscGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.09);

      osc.connect(oscGain);
      oscGain.connect(tone);
      tone.connect(this.master as GainNode);

      osc.start(now);
      osc.stop(now + 0.12);

      // --- Tiny filtered-noise transient for the initial "tick". ---
      const noise = this.makeNoiseSource(ctx);
      if (noise) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.setValueAtTime(2600, now);
        bp.Q.setValueAtTime(0.8, now);

        const nGain = ctx.createGain();
        nGain.gain.setValueAtTime(0.12, now);
        nGain.gain.exponentialRampToValueAtTime(EPSILON, now + 0.025);

        noise.connect(bp);
        bp.connect(nGain);
        nGain.connect(this.master as GainNode);

        noise.start(now);
        noise.stop(now + 0.05);
      }
    });
  }

  /**
   * A small water splash/trickle — when water reaches an outlet.
   * @param intensity 0..1 (default 0.6); scales loudness and brightness.
   */
  splash(intensity: number = 0.6): void {
    const amt = clamp01(intensity);
    this.withContext((ctx, now) => {
      const noise = this.makeNoiseSource(ctx);
      if (!noise) return;

      // Bandpass that "opens then closes" to give the watery whoosh.
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.setValueAtTime(1.2, now);

      const baseFreq = 500 + amt * 1400; // brighter with intensity
      bp.frequency.setValueAtTime(baseFreq * 0.5, now);
      bp.frequency.linearRampToValueAtTime(baseFreq, now + 0.06);
      bp.frequency.exponentialRampToValueAtTime(baseFreq * 0.35, now + 0.18);

      // Gentle lowpass to keep it soft (no harsh hiss).
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(3500, now);

      const g = ctx.createGain();
      const peak = 0.14 + amt * 0.22;
      g.gain.setValueAtTime(EPSILON, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.03);
      g.gain.exponentialRampToValueAtTime(EPSILON, now + 0.18);

      noise.connect(bp);
      bp.connect(lp);
      lp.connect(g);
      g.connect(this.master as GainNode);

      noise.start(now);
      noise.stop(now + 0.2);
    });
  }

  /** Bright ascending arpeggio for level solved. */
  win(): void {
    this.withContext((ctx, now) => {
      // A major pentatonic ascent: C5 D5 E5 G5 A5 (Hz).
      const notes = [523.25, 587.33, 659.25, 783.99, 880.0];
      const step = 0.12; // ~120ms between note onsets → ~700ms total tail.

      // Fake a sense of space with a short feedback delay shared by all notes.
      const delay = ctx.createDelay(0.5);
      delay.delayTime.setValueAtTime(0.13, now);
      const feedback = ctx.createGain();
      feedback.gain.setValueAtTime(0.28, now);
      const wet = ctx.createGain();
      wet.gain.setValueAtTime(0.35, now);

      delay.connect(feedback);
      feedback.connect(delay); // feedback loop
      delay.connect(wet);
      wet.connect(this.master as GainNode);

      notes.forEach((freq, i) => {
        const t = now + i * step;

        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t);

        // Subtle sine partial for a softer, sweeter timbre.
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(freq, t);

        const g = ctx.createGain();
        const peak = 0.16;
        g.gain.setValueAtTime(EPSILON, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.012);
        g.gain.exponentialRampToValueAtTime(EPSILON, t + 0.35);

        osc.connect(g);
        sub.connect(g);
        g.connect(this.master as GainNode); // dry
        g.connect(delay); // send to reverb-ish delay

        osc.start(t);
        sub.start(t);
        osc.stop(t + 0.4);
        sub.stop(t + 0.4);
      });
    });
  }

  /** Soft low "uh-uh" thud for an invalid/blocked move or a leak warning. */
  thud(): void {
    this.withContext((ctx, now) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.18);

      const g = ctx.createGain();
      const peak = 0.2;
      g.gain.setValueAtTime(EPSILON, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.006);
      g.gain.exponentialRampToValueAtTime(EPSILON, now + 0.2);

      osc.connect(g);
      g.connect(this.master as GainNode);

      osc.start(now);
      osc.stop(now + 0.24);
    });
  }

  /** Light UI tick for button taps. */
  tick(): void {
    this.withContext((ctx, now) => {
      const noise = this.makeNoiseSource(ctx);
      if (!noise) return;

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(4000, now);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.08, now);
      g.gain.exponentialRampToValueAtTime(EPSILON, now + 0.02);

      noise.connect(hp);
      hp.connect(g);
      g.connect(this.master as GainNode);

      noise.start(now);
      noise.stop(now + 0.04);
    });
  }

  /** Toggle all sound. */
  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master && this.ctx) {
      try {
        const now = this.ctx.currentTime;
        const target = m ? 0 : this.masterVolume;
        this.master.gain.cancelScheduledValues(now);
        // Short ramp avoids clicks when toggling.
        this.master.gain.setValueAtTime(this.master.gain.value, now);
        this.master.gain.linearRampToValueAtTime(target, now + 0.02);
      } catch {
        /* ignore */
      }
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Lazily create (or return) the AudioContext + master gain. Returns null if
   * Web Audio is unsupported or creation failed.
   */
  private ensureContext(): AudioContext | null {
    if (this.failed) return null;
    if (this.ctx) return this.ctx;

    try {
      const Ctor =
        window.AudioContext ??
        (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return null;
      }

      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.setValueAtTime(this._muted ? 0 : this.masterVolume, ctx.currentTime);
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      this.failed = true;
      this.ctx = null;
      this.master = null;
      return null;
    }
  }

  /**
   * Run a scheduling callback with a live context + master node + "now" time.
   * No-ops safely when muted, failed, or unsupported, and swallows errors.
   */
  private withContext(fn: (ctx: AudioContext, now: number) => void): void {
    if (this.failed || this._muted) return;
    try {
      const ctx = this.ensureContext();
      if (!ctx || !this.master) return;
      // Best-effort resume: a sound might be triggered by a gesture before
      // unlock() ran. If still suspended it simply won't be audible.
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
      }
      fn(ctx, ctx.currentTime);
    } catch {
      /* swallow — never throw from a sound effect */
    }
  }

  /** Lazily build a 1s mono white-noise buffer (created once, reused). */
  private getNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer) return this.noiseBuffer;
    try {
      const length = Math.floor(ctx.sampleRate * 1);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  /** Create a one-shot BufferSource from the shared noise buffer. */
  private makeNoiseSource(ctx: AudioContext): AudioBufferSourceNode | null {
    const buffer = this.getNoiseBuffer(ctx);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    return src;
  }
}

/** Clamp a value into the 0..1 range. */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
