import {
  FilesetResolver,
  FaceLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

let faceLandmarker = null;
let isLoadingTracker = false;
let lastVideoTime = -1;
let faceRafId = null;

export async function initFaceTracker() {
  if (faceLandmarker) return faceLandmarker;
  if (isLoadingTracker) return null;

  isLoadingTracker = true;
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });

    return faceLandmarker;
  } finally {
    isLoadingTracker = false;
  }
}

export function startFaceOverlayLoop(videoEl, overlayCanvas, getEffectName, isMirroredFn) {
  stopFaceOverlayLoop();
  if (!videoEl || !overlayCanvas) return;

  const ctx = overlayCanvas.getContext("2d");

  function loop() {
    faceRafId = requestAnimationFrame(loop);

    const w = overlayCanvas.width;
    const h = overlayCanvas.height;
    if (!w || !h) return;

    ctx.clearRect(0, 0, w, h);

    const effectName = typeof getEffectName === "function" ? getEffectName() : getEffectName;
    if (!faceLandmarker || !effectName || effectName === "none") return;
    if (videoEl.readyState < 2) return;

    if (videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      const results = faceLandmarker.detectForVideo(videoEl, performance.now());

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const mirrored = typeof isMirroredFn === "function" ? isMirroredFn() : false;
        drawFaceLandmarksEffect(ctx, results.faceLandmarks[0], w, h, effectName, mirrored);
      }
    }
  }

  loop();
}

export function stopFaceOverlayLoop() {
  if (faceRafId) {
    cancelAnimationFrame(faceRafId);
    faceRafId = null;
  }
}

function drawFaceLandmarksEffect(ctx, landmarks, width, height, effectName, mirrored) {
  const mapX = nx => (mirrored ? (1 - nx) * width : nx * width);
  const mapY = ny => ny * height;

  const leftEye = landmarks[33];
  const rightEye = landmarks[263];

  const x1 = mapX(leftEye.x);
  const y1 = mapY(leftEye.y);
  const x2 = mapX(rightEye.x);
  const y2 = mapY(rightEye.y);

  const eyeDist = Math.hypot(x2 - x1, y2 - y1);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  if (effectName === "glasses") {
    ctx.strokeStyle = "#D4AF37";
    ctx.lineWidth = Math.max(3, eyeDist * 0.06);
    const lensW = eyeDist * 0.44;
    const lensH = eyeDist * 0.28;
    const bridge = eyeDist * 0.1;

    ctx.strokeRect(-bridge / 2 - lensW, -lensH / 2, lensW, lensH);
    ctx.strokeRect(bridge / 2, -lensH / 2, lensW, lensH);
    ctx.beginPath();
    ctx.moveTo(-bridge / 2, 0);
    ctx.lineTo(bridge / 2, 0);
    ctx.stroke();
  } else if (effectName === "sparkle") {
    ctx.fillStyle = "#F1D78A";
    const points = [
      [-eyeDist * 0.55, -eyeDist * 0.25],
      [eyeDist * 0.55, -eyeDist * 0.25],
      [0, eyeDist * 0.25],
      [0, -eyeDist * 0.65]
    ];
    for (const [px, py] of points) {
      ctx.beginPath();
      ctx.arc(px, py, Math.max(4, eyeDist * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}