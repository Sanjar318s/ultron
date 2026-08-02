import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices (MediaPipe hand model)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// Pinch hysteresis: thumb–index distance relative to hand size
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;

// How strongly hand movement rotates the orb (radians per normalized unit)
const ROTATE_SPEED = 5.0;

// One-Euro filter tuning. Low mincutoff kills jitter while the hand is
// nearly still; beta raises the effective cutoff (less smoothing, less lag)
// in proportion to how fast the signal is moving, so fast pinch-drags don't
// feel laggy while slow ones stay jitter-free.
const FILTER_MINCUTOFF = 0.6;
const FILTER_BETA = 0.6;
const FILTER_DCUTOFF = 1.0;
const ZOOM_FILTER_MINCUTOFF = 0.5;
const ZOOM_FILTER_BETA = 0.4;

export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
}

interface Point {
  x: number;
  y: number;
}

/**
 * One-Euro filter (Casiez et al.) — adaptive low-pass filter tuned for
 * interactive signals: heavy smoothing when the input is nearly static,
 * automatically loosening as speed increases so responsive motion doesn't
 * pick up extra lag. Used per-axis for landmark/grab-point smoothing.
 */
class OneEuroFilter {
  private readonly mincutoff: number;
  private readonly beta: number;
  private readonly dcutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(mincutoff: number, beta: number, dcutoff = 1.0) {
    this.mincutoff = mincutoff;
    this.beta = beta;
    this.dcutoff = dcutoff;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param t timestamp in milliseconds, monotonically increasing */
  filter(x: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dt = Math.max(1e-3, (t - this.tPrev) / 1000);
    const dx = (x - this.xPrev) * (1 / dt);
    const aD = OneEuroFilter.alpha(this.dcutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);

    const cutoff = this.mincutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);

    this.tPrev = t;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

interface HandState {
  pinching: boolean;
  grab: Point; // filtered pinch midpoint, mirrored
  filterX: OneEuroFilter;
  filterY: OneEuroFilter;
}

// Some browsers (notably Firefox) don't yet implement requestVideoFrameCallback.
interface VideoFrameMetadata {
  mediaTime: number;
}
type VFCVideoElement = HTMLVideoElement & {
  requestVideoFrameCallback(
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ): number;
  cancelVideoFrameCallback(handle: number): void;
};

function supportsVideoFrameCallback(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    "requestVideoFrameCallback" in HTMLVideoElement.prototype
  );
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private vfcHandle = 0;
  private readonly useVFC = supportsVideoFrameCallback();
  private running = false;
  private lastVideoTime = -1;

  // keyed by handedness label so state survives re-ordering between frames
  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private zoomFilter = new OneEuroFilter(ZOOM_FILTER_MINCUTOFF, ZOOM_FILTER_BETA);
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      // Some browsers/GPUs reject the GPU delegate — fall back to CPU
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
      });
    }

    this.running = true;
    if (this.useVFC) {
      this.vfcHandle = (this.video as VFCVideoElement).requestVideoFrameCallback(
        this.vfcLoop,
      );
    } else {
      this.loop();
    }
  }

  stop(): void {
    this.running = false;
    if (this.useVFC) {
      (this.video as VFCVideoElement).cancelVideoFrameCallback(this.vfcHandle);
    } else {
      cancelAnimationFrame(this.rafId);
    }
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.handStates.clear();
    this.prevMode = "idle";
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    this.zoomFilter.reset();
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
  }

  // Fires exactly once per decoded video frame, with that frame's true
  // presentation time — lower latency and no wasted detections compared to
  // polling on requestAnimationFrame (whose rate can exceed camera fps).
  private vfcLoop = (_now: number, metadata: VideoFrameMetadata) => {
    if (!this.running) return;
    this.vfcHandle = (this.video as VFCVideoElement).requestVideoFrameCallback(
      this.vfcLoop,
    );
    if (!this.landmarker) return;
    const timestampMs = metadata.mediaTime * 1000;
    const result = this.landmarker.detectForVideo(this.video, timestampMs);
    this.processHands(
      result.landmarks,
      result.handedness.map((h) => h[0]?.categoryName ?? "?"),
      timestampMs,
    );
    this.drawOverlay(result.landmarks);
  };

  // Fallback loop for browsers without requestVideoFrameCallback.
  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const timestampMs = performance.now();
    const result = this.landmarker.detectForVideo(this.video, timestampMs);
    this.processHands(
      result.landmarks,
      result.handedness.map((h) => h[0]?.categoryName ?? "?"),
      timestampMs,
    );
    this.drawOverlay(result.landmarks);
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
    timestampMs: number,
  ): void {
    const pinchedGrabs: Point[] = [];
    const seen = new Set<string>();

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      // 3D (x/y/z) distances so a tilted or rotated hand — where the
      // thumb and index finger foreshorten in the 2D image — doesn't get
      // misread as a pinch or a wider/narrower gap than it really is.
      const handScale = dist3d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist3d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;

      // Mirrored so hand-right = screen-right from the user's perspective
      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = {
          pinching: false,
          grab: raw,
          filterX: new OneEuroFilter(FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF),
          filterY: new OneEuroFilter(FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF),
        };
        this.handStates.set(label, state);
      }

      // Hysteresis so the pinch doesn't flicker on/off at the threshold
      if (state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      else if (!state.pinching && pinchRatio < PINCH_ON) state.pinching = true;

      state.grab = {
        x: state.filterX.filter(raw.x, timestampMs),
        y: state.filterY.filter(raw.y, timestampMs),
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
    });

    // Drop state for hands that left the frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    const mode: GestureMode =
      pinchedGrabs.length >= 2 ? "zoom" : pinchedGrabs.length === 1 ? "spin" : "idle";

    // Reset reference points on any mode change to avoid jumps
    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.zoomFilter.reset();
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = grab.x - this.prevSpinGrab.x;
        const dy = grab.y - this.prevSpinGrab.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const dRaw = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      const d = this.zoomFilter.filter(dRaw, timestampMs);
      if (this.prevZoomDist && d > 1e-4) {
        // Spread hands apart -> factor < 1 -> camera moves closer
        const factor = Math.min(1.18, Math.max(0.85, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }

    this.emitStatus({ hands: landmarks.length, mode });
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist3d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 && dist3d(thumb, index) / handScale < PINCH_ON;

      ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function dist3d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
