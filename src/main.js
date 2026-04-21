/**
 * main.js — Wildcard 3D Reel Engine
 *
 * Stack: Three.js (scene / render) + GSAP (physics-easing on spin)
 *
 * Architecture is deliberately modular so shader logic, extra reels,
 * and network integrations can be injected later without restructuring.
 */

import * as THREE from 'three';
import { gsap } from 'gsap';

// ─────────────────────────────────────────────────────────────
// 1. SCENE SETUP
// ─────────────────────────────────────────────────────────────

/** @type {THREE.Scene} */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0d0d);

/**
 * Perspective camera — slightly above the reel, looking straight at it.
 * FOV is kept modest to reduce perspective distortion on the cylinder.
 */
const camera = new THREE.PerspectiveCamera(
  50,                                   // FOV (degrees)
  window.innerWidth / window.innerHeight, // aspect ratio
  0.1,                                  // near clip
  100                                   // far clip
);
camera.position.set(0, 0, 6);

/** WebGLRenderer — antialias for crisp label edges */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

/** Keep the canvas and camera in sync with the browser window */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


// ─────────────────────────────────────────────────────────────
// 2. LIGHTING  (harsh, industrial shadow effect)
// ─────────────────────────────────────────────────────────────

/**
 * Dim ambient fill — keeps the dark side from going pitch-black.
 * Intensity is low on purpose to maximise the shadow contrast.
 */
const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambientLight);

/**
 * Primary key light — high and to the left, casts hard shadows.
 * Colour is slightly warm so the metal surface reads as aged steel.
 */
const keyLight = new THREE.DirectionalLight(0xffd4a0, 2.5);
keyLight.position.set(-4, 6, 4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 30;
scene.add(keyLight);

/**
 * Weak rim/fill light from the opposite side — adds separation from
 * the background and highlights the bevelled cylinder edges.
 */
const rimLight = new THREE.DirectionalLight(0x8ab4f8, 0.6);
rimLight.position.set(4, -2, -3);
scene.add(rimLight);


// ─────────────────────────────────────────────────────────────
// 3. LABEL TEXTURE  (Canvas API → THREE.CanvasTexture)
// ─────────────────────────────────────────────────────────────

/**
 * Decision labels that will be mapped evenly around the reel.
 * Extend or replace this array to change what the reel can land on.
 */
const LABELS = ['Pizza', 'Burgers', 'Cook at Home', 'Park', 'Movie'];

/**
 * buildReelTexture()
 *
 * Renders all labels side-by-side onto a single wide canvas, which is
 * then UV-wrapped around the cylinder so each label occupies exactly
 * one face-slot.
 *
 * @returns {THREE.CanvasTexture}
 */
function buildReelTexture() {
  const labelCount = LABELS.length;

  // Canvas dimensions — width is per-slot × count; height is the reel height.
  const SLOT_W  = 512;   // px per label column
  const SLOT_H  = 512;   // px (maps to the cylinder height in UV space)
  const canvas  = document.createElement('canvas');
  canvas.width  = SLOT_W * labelCount;
  canvas.height = SLOT_H;

  const ctx = canvas.getContext('2d');

  // Slot background — dark steel plate
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Slot separators — subtle groove lines
  ctx.strokeStyle = '#333333';
  ctx.lineWidth   = 4;

  LABELS.forEach((label, i) => {
    const x = i * SLOT_W;

    // Slight gradient per slot to fake a convex panel
    const grad = ctx.createLinearGradient(x, 0, x + SLOT_W, 0);
    grad.addColorStop(0,   '#222222');
    grad.addColorStop(0.3, '#2e2e2e');
    grad.addColorStop(0.7, '#2e2e2e');
    grad.addColorStop(1,   '#1a1a1a');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, SLOT_W, SLOT_H);

    // Separator line
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, SLOT_H - 20);
      ctx.stroke();
    }

    // ── Label text ──
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Main label — bold, slightly off-white industrial stencil feel
    ctx.font      = `bold 64px 'Courier New', Courier, monospace`;
    ctx.fillStyle = '#e8e8e8';
    ctx.shadowColor   = '#000';
    ctx.shadowBlur    = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillText(label, x + SLOT_W / 2, SLOT_H / 2);

    // Subtle index number in the corner (useful for debugging / theming)
    ctx.font      = '24px monospace';
    ctx.fillStyle = '#555';
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(`0${i + 1}`, x + SLOT_W / 2, SLOT_H - 40);

    ctx.restore();
  });

  const texture = new THREE.CanvasTexture(canvas);

  // Wrap so the texture tiles once around the circumference
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, 1);

  return texture;
}


// ─────────────────────────────────────────────────────────────
// 4. REEL GEOMETRY
// ─────────────────────────────────────────────────────────────

/**
 * createReel()
 *
 * Builds the large cylinder that acts as the decision reel.
 * The cylinder is oriented so it spins on its X-axis (local "roll").
 *
 * @returns {THREE.Mesh}
 */
function createReel() {
  // CylinderGeometry uses BufferGeometry internally (Three.js r125+).
  // Segments are high enough to keep the silhouette smooth.
  const geometry = new THREE.CylinderGeometry(
    1.2,   // radiusTop
    1.2,   // radiusBottom
    3.0,   // height  (the horizontal axis width visible to camera)
    64,    // radialSegments — smooth circumference
    1,     // heightSegments
    false  // openEnded — caps are included
  );

  // Rotate geometry so the cylinder lies on its side (horizontal reel).
  geometry.rotateZ(Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    map:         buildReelTexture(),
    color:       0x888888,   // dark metallic base tint
    metalness:   0.75,
    roughness:   0.45,
  });

  const reel = new THREE.Mesh(geometry, material);
  reel.castShadow    = true;
  reel.receiveShadow = true;

  // Centre the reel in the scene
  reel.position.set(0, 0, 0);

  scene.add(reel);
  return reel;
}

const reel = createReel();


// ─────────────────────────────────────────────────────────────
// 5. SPIN MECHANIC
// ─────────────────────────────────────────────────────────────

/** Track whether a spin is in progress to prevent overlapping tweens */
let isSpinning = false;

/**
 * getTargetRotation()
 *
 * Picks a random label index and converts it to the X-axis rotation
 * (in radians) the reel must stop at so that label faces the camera.
 *
 * The cylinder's label texture is wrapped around its circumference, so
 * rotating by  (2π / labelCount) * index  brings the chosen slot front-
 * and-centre.
 *
 * Extra full rotations are added for dramatic wind-up effect.
 *
 * @param {number} currentRotation — current reel.rotation.x value
 * @returns {{ rotation: number, label: string }}
 */
function getTargetRotation(currentRotation) {
  const labelCount  = LABELS.length;
  const labelIndex  = Math.floor(Math.random() * labelCount);
  const slotAngle   = (2 * Math.PI) / labelCount;

  // Extra full spins (between 4 and 8) for a visceral, long wind-down
  const extraSpins  = (4 + Math.floor(Math.random() * 5)) * 2 * Math.PI;

  // Align to the chosen slot — negate because we're rotating "forward"
  const targetAngle = currentRotation + extraSpins - (slotAngle * labelIndex);

  return { rotation: targetAngle, label: LABELS[labelIndex] };
}

/**
 * spinReel()
 *
 * Triggers when the user clicks the screen.
 * Uses GSAP's power4.out ease to simulate heavy mechanical deceleration.
 *
 * To swap in a custom ease, replace the `ease` string with any GSAP
 * ease identifier or a CustomEase instance registered beforehand.
 */
function spinReel() {
  if (isSpinning) return;
  isSpinning = true;

  const { rotation, label } = getTargetRotation(reel.rotation.x);

  // GSAP tween — duration and ease are the main "feel" knobs
  gsap.to(reel.rotation, {
    x:        rotation,
    duration: 4 + Math.random() * 2,   // 4–6 s spin time
    ease:     'power4.out',            // heavy mechanical deceleration
    onComplete: () => {
      isSpinning = false;
      console.log(`Wildcard landed on: ${label}`);

      // Normalise rotation to avoid floating-point drift on repeated spins
      reel.rotation.x = reel.rotation.x % (2 * Math.PI);
    },
  });
}

/** Attach the spin trigger to the renderer canvas */
renderer.domElement.addEventListener('click', spinReel);


// ─────────────────────────────────────────────────────────────
// 6. RENDER LOOP
// ─────────────────────────────────────────────────────────────

/**
 * animate()
 *
 * Standard requestAnimationFrame loop.
 * GSAP drives the reel rotation; this loop only needs to render.
 * Extend this function to add per-frame custom shader uniforms,
 * particle updates, or audio-reactive effects later.
 */
function animate() {
  requestAnimationFrame(animate);

  // Placeholder for future per-frame logic (e.g., shader uniform updates)
  // uniformTime.value = performance.now() / 1000;

  renderer.render(scene, camera);
}

animate();


// ─────────────────────────────────────────────────────────────
// 7. LOBBY UI
// ─────────────────────────────────────────────────────────────

const lobbyUI   = document.getElementById('lobby-ui');
const toggleBtn = document.getElementById('toggle-btn');
const spinBtn   = document.getElementById('spin-btn');

/**
 * toggleLobbyUI()
 *
 * Shows or hides the #lobby-panel by toggling the `panel-hidden` class
 * on #lobby-ui. The toggle button label flips between ✕ and ☰.
 */
function toggleLobbyUI() {
  const hidden = lobbyUI.classList.toggle('panel-hidden');
  toggleBtn.setAttribute('aria-expanded', String(!hidden));
  toggleBtn.innerHTML = hidden ? '&#x2630;' : '&#x2715;';
  toggleBtn.setAttribute('aria-label', hidden ? 'Show UI panel' : 'Hide UI panel');
}

/**
 * updateReelLabels()
 *
 * Reads the current values from the 5 option inputs and logs them.
 * TODO: pass this array to the Three.js texture builder (buildReelTexture)
 * once the canvas-texture integration is wired up.
 *
 * @returns {string[]} Array of 5 option strings (may be empty strings if blank).
 */
function updateReelLabels() {
  const options = [1, 2, 3, 4, 5].map(
    (n) => document.getElementById(`option-${n}`).value.trim()
  );
  console.log('Reel options:', options);
  return options;
}

toggleBtn.addEventListener('click', toggleLobbyUI);

spinBtn.addEventListener('click', () => {
  updateReelLabels();
  spinReel();
});
