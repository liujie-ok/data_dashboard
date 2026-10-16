import * as THREE from 'three';

let scene, camera, renderer, carGroup, gridHelper, keyLight;
let targetPitch = 0, targetRoll = 0;
let currentPitch = 0, currentRoll = 0;

// All edge/fill materials stored so we can recolor on theme change
const edgeMats = [];
const fillMats = [];
const wheelMats = [];

const C = {
  dark:  { bg: 0x080c14, edge: 0x00d4ff, fill: 0x00d4ff, wheel: 0x00d4ff, light: 0x00d4ff, grid1: 0x003344, grid2: 0x001122 },
  light: { bg: 0xeef2f7, edge: 0x0070bb, fill: 0x0070bb, wheel: 0x0070bb, light: 0x4499cc, grid1: 0x99bbd0, grid2: 0xd8e8f2 },
};

let currentTheme = 'dark';

// ── Helpers ───────────────────────────────────────────────────────────────────
function addPart(group, geo, fillMat, edgeMat, pos, rot) {
  const mesh  = new THREE.Mesh(geo, fillMat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
  if (pos) { mesh.position.set(...pos);  edges.position.set(...pos); }
  if (rot) { mesh.rotation.set(...rot);  edges.rotation.set(...rot); }
  group.add(mesh, edges);
}

function makeGrid(t) {
  const g = new THREE.GridHelper(7, 14, C[t].grid1, C[t].grid2);
  g.position.y = -0.52;
  return g;
}

// ── Car geometry ──────────────────────────────────────────────────────────────
function buildCar(t) {
  const group = new THREE.Group();
  const c = C[t];

  const fillMat  = new THREE.MeshPhongMaterial({ color: c.fill,  transparent: true, opacity: 0.1,  side: THREE.DoubleSide });
  const edgeMat  = new THREE.LineBasicMaterial({ color: c.edge });
  const wheelMat = new THREE.MeshPhongMaterial({ color: c.wheel, transparent: true, opacity: 0.22 });
  const wedgeMat = new THREE.LineBasicMaterial({ color: c.edge,  transparent: true, opacity: 0.7  });

  fillMats.push(fillMat, wheelMat);
  edgeMats.push(edgeMat, wedgeMat);

  // Chassis
  addPart(group, new THREE.BoxGeometry(2.0, 0.16, 0.82), fillMat, edgeMat);

  // Nose cone — CylinderGeometry(topR, bottomR, h) with tip at +Y, rotated to point +X
  addPart(group, new THREE.CylinderGeometry(0, 0.36, 0.75, 5), fillMat, edgeMat,
    [1.38, 0, 0], [0, Math.PI * 0.1, -Math.PI / 2]);

  // Tail taper — tip points -X
  addPart(group, new THREE.CylinderGeometry(0, 0.28, 0.55, 4), fillMat, edgeMat,
    [-1.28, 0, 0], [0, Math.PI * 0.25, Math.PI / 2]);

  // Canopy
  addPart(group, new THREE.BoxGeometry(0.52, 0.24, 0.48), fillMat, edgeMat, [-0.05, 0.2, 0]);

  // Wheel arch covers
  const archGeo = new THREE.BoxGeometry(0.3, 0.07, 0.17);
  addPart(group, archGeo, fillMat, edgeMat, [ 0.65, 0.1,  0.46]);
  addPart(group, archGeo, fillMat, edgeMat, [ 0.65, 0.1, -0.46]);
  addPart(group, archGeo, fillMat, edgeMat, [-0.7,  0.1,  0]);

  // 3 wheels: 2 front, 1 rear (classic supermileage config)
  const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.07, 10);
  addPart(group, wheelGeo, wheelMat, wedgeMat, [ 0.7, -0.17,  0.5],  [0, 0, Math.PI / 2]);
  addPart(group, wheelGeo, wheelMat, wedgeMat, [ 0.7, -0.17, -0.5],  [0, 0, Math.PI / 2]);
  addPart(group, wheelGeo, wheelMat, wedgeMat, [-0.85, -0.17, 0],    [0, 0, Math.PI / 2]);

  return group;
}

// ── Public API ────────────────────────────────────────────────────────────────
export function initThreeView(container) {
  const W = container.clientWidth  || 420;
  const H = container.clientHeight || 360;

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
  camera.position.set(3.2, 1.7, 3.2);
  camera.lookAt(0, 0.1, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(C[currentTheme].bg);
  container.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  keyLight = new THREE.DirectionalLight(C[currentTheme].light, 2.8);
  keyLight.position.set(4, 6, 3);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.2);
  fillLight.position.set(-3, 2, -3);
  scene.add(fillLight);

  gridHelper = makeGrid(currentTheme);
  scene.add(gridHelper);

  carGroup = buildCar(currentTheme);
  scene.add(carGroup);

  new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }).observe(container);

  animate();
}

export function updateCarOrientation(ax, ay) {
  // pitch: nose dips under braking (ax < 0), lifts under accel (ax > 0)
  targetPitch = -ax * 0.28;
  // roll: tilts into corners from lateral g
  targetRoll  =  ay * 0.38;
}

export function setTheme(isDark) {
  currentTheme = isDark ? 'dark' : 'light';
  if (!renderer) return;

  const c = C[currentTheme];

  renderer.setClearColor(c.bg);

  for (const m of edgeMats)  { m.color.setHex(c.edge);  }
  for (const m of fillMats)  { m.color.setHex(c.fill);  }
  keyLight.color.setHex(c.light);

  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper = makeGrid(currentTheme);
    scene.add(gridHelper);
  }
}

function animate() {
  requestAnimationFrame(animate);
  currentPitch += (targetPitch - currentPitch) * 0.08;
  currentRoll  += (targetRoll  - currentRoll)  * 0.08;
  if (carGroup) {
    carGroup.rotation.x = currentPitch;
    carGroup.rotation.z = currentRoll;
  }
  renderer.render(scene, camera);
}
