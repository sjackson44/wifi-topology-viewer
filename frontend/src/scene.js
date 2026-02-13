import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const MAX_RENDER_NODES = 120;
const MAX_RENDER_EDGES = 160;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const center = size / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, 'rgba(180, 255, 210, 1)');
  gradient.addColorStop(0.25, 'rgba(80, 255, 150, 0.75)');
  gradient.addColorStop(0.55, 'rgba(20, 160, 90, 0.25)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createClusterColorGetter() {
  const cache = new Map([[0, new THREE.Color(0x5bff9d)]]);
  return (clusterId) => {
    const normalized = Number.isFinite(clusterId) ? Math.max(0, clusterId) : 0;
    if (cache.has(normalized)) {
      return cache.get(normalized);
    }

    const hue = ((normalized * 67) % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.85, 0.62);
    cache.set(normalized, color);
    return color;
  };
}

function createSpritePool(scene, glowTexture) {
  const pool = [];

  for (let i = 0; i < MAX_RENDER_NODES; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color(0x5bff9d),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.scale.setScalar(0.1);
    scene.add(sprite);

    pool.push({
      id: null,
      sprite,
      material,
      lastSeenFrame: -1,
    });
  }

  return pool;
}

export function createWifiScene(container) {
  const getClusterColor = createClusterColorGetter();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x010703);
  scene.fog = new THREE.FogExp2(0x03130b, 0.012);

  const camera = new THREE.PerspectiveCamera(
    58,
    container.clientWidth / container.clientHeight,
    0.1,
    600,
  );
  camera.position.set(0, 18, 130);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 45;
  controls.maxDistance = 240;

  scene.add(new THREE.AmbientLight(0x4eff97, 0.35));
  const keyLight = new THREE.PointLight(0x52ff9f, 1.5, 460);
  keyLight.position.set(30, 52, 60);
  scene.add(keyLight);

  const worldSphere = new THREE.Mesh(
    new THREE.SphereGeometry(72, 48, 32),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x2fff8f),
      wireframe: true,
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  const innerSphere = new THREE.Mesh(
    new THREE.SphereGeometry(46, 32, 22),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x15a25c),
      wireframe: true,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  scene.add(worldSphere);
  scene.add(innerSphere);

  const edgePositions = new Float32Array(MAX_RENDER_EDGES * 2 * 3);
  const edgeColors = new Float32Array(MAX_RENDER_EDGES * 2 * 3);
  const edgeGeometry = new THREE.BufferGeometry();

  const edgePositionAttr = new THREE.BufferAttribute(edgePositions, 3);
  edgePositionAttr.setUsage(THREE.DynamicDrawUsage);
  const edgeColorAttr = new THREE.BufferAttribute(edgeColors, 3);
  edgeColorAttr.setUsage(THREE.DynamicDrawUsage);

  edgeGeometry.setAttribute('position', edgePositionAttr);
  edgeGeometry.setAttribute('color', edgeColorAttr);
  edgeGeometry.setDrawRange(0, 0);

  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.frustumCulled = false;
  scene.add(edgeLines);

  const coverageGeometry = new THREE.SphereGeometry(1, 22, 16);
  const coverageMaterial = new THREE.MeshBasicMaterial({
    wireframe: true,
    transparent: true,
    opacity: 0.24,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
  });
  const coverageMesh = new THREE.InstancedMesh(coverageGeometry, coverageMaterial, MAX_RENDER_NODES);
  coverageMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  coverageMesh.count = 0;
  coverageMesh.frustumCulled = false;
  scene.add(coverageMesh);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    1,
    0.38,
    0.18,
  );
  composer.addPass(bloomPass);

  const glowTexture = createGlowTexture();
  const spritePool = createSpritePool(scene, glowTexture);
  const freePool = [...spritePool];
  const activePoolById = new Map();

  const tempPosition = new THREE.Vector3();
  const tempScale = new THREE.Vector3();
  const tempMatrix = new THREE.Matrix4();
  const identityQuaternion = new THREE.Quaternion();
  const tempColor = new THREE.Color();

  let frameId = 0;

  function acquireNode(id) {
    if (activePoolById.has(id)) {
      return activePoolById.get(id);
    }

    const node = freePool.pop();
    if (!node) {
      return null;
    }

    node.id = id;
    node.sprite.visible = true;
    node.material.opacity = 0.9;
    activePoolById.set(id, node);
    return node;
  }

  function releaseNode(id) {
    const node = activePoolById.get(id);
    if (!node) {
      return;
    }

    activePoolById.delete(id);
    node.id = null;
    node.lastSeenFrame = -1;
    node.sprite.visible = false;
    node.sprite.scale.setScalar(0.1);
    node.material.opacity = 0;
    freePool.push(node);
  }

  function update(snapshot) {
    frameId += 1;

    const positions = snapshot.positions ?? {};
    const aps = (snapshot.aps ?? []).slice(0, MAX_RENDER_NODES);
    const clusterById = new Map(aps.map((ap) => [ap.bssid, ap.clusterId || 0]));
    const edgeThreshold = Number.isFinite(snapshot.meta?.edgeThreshold)
      ? snapshot.meta.edgeThreshold
      : 0.6;

    for (const ap of aps) {
      const node = acquireNode(ap.bssid);
      if (!node) {
        continue;
      }

      node.lastSeenFrame = frameId;

      const target = positions[ap.bssid] ?? { x: 0, y: 0, z: 0 };
      node.sprite.position.x += (target.x - node.sprite.position.x) * 0.35;
      node.sprite.position.y += (target.y - node.sprite.position.y) * 0.35;
      node.sprite.position.z += (target.z - node.sprite.position.z) * 0.35;

      const strength = clamp((ap.rssi + 90) / 60, 0, 1);
      const nodeSize = 1.7 + strength * 4.3;
      node.sprite.scale.set(nodeSize, nodeSize, 1);

      const clusterColor = getClusterColor(ap.clusterId || 0);
      node.material.color.copy(clusterColor);
      node.material.opacity = ap.rssiEstimated ? 0.68 : 0.95;
    }

    for (const [id, node] of activePoolById.entries()) {
      if (node.lastSeenFrame !== frameId) {
        releaseNode(id);
      }
    }

    let coverageIndex = 0;
    for (const ap of aps) {
      const node = activePoolById.get(ap.bssid);
      if (!node || coverageIndex >= MAX_RENDER_NODES) {
        continue;
      }

      const strength = clamp((ap.rssi + 90) / 60, 0, 1);
      const sphereRadius = 5 + strength * 20;

      tempPosition.copy(node.sprite.position);
      tempScale.setScalar(sphereRadius);
      tempMatrix.compose(tempPosition, identityQuaternion, tempScale);

      coverageMesh.setMatrixAt(coverageIndex, tempMatrix);
      coverageMesh.setColorAt(coverageIndex, getClusterColor(ap.clusterId || 0));
      coverageIndex += 1;
    }

    coverageMesh.count = coverageIndex;
    coverageMesh.instanceMatrix.needsUpdate = true;
    if (coverageMesh.instanceColor) {
      coverageMesh.instanceColor.needsUpdate = true;
    }

    let edgeCount = 0;
    for (const edge of snapshot.edges ?? []) {
      if (edgeCount >= MAX_RENDER_EDGES) {
        break;
      }
      if (edge.corr < edgeThreshold) {
        continue;
      }

      const a = positions[edge.a];
      const b = positions[edge.b];
      if (!a || !b) {
        continue;
      }

      const base = edgeCount * 6;
      edgePositions[base] = a.x;
      edgePositions[base + 1] = a.y;
      edgePositions[base + 2] = a.z;
      edgePositions[base + 3] = b.x;
      edgePositions[base + 4] = b.y;
      edgePositions[base + 5] = b.z;

      const corrIntensity = clamp((edge.corr - edgeThreshold) / (1 - edgeThreshold), 0, 1);
      const colorA = getClusterColor(clusterById.get(edge.a) || 0);
      const colorB = getClusterColor(clusterById.get(edge.b) || 0);
      tempColor.copy(colorA).lerp(colorB, 0.5).multiplyScalar(0.45 + corrIntensity * 0.85);

      edgeColors[base] = tempColor.r;
      edgeColors[base + 1] = tempColor.g;
      edgeColors[base + 2] = tempColor.b;
      edgeColors[base + 3] = tempColor.r;
      edgeColors[base + 4] = tempColor.g;
      edgeColors[base + 5] = tempColor.b;

      edgeCount += 1;
    }

    edgeGeometry.setDrawRange(0, edgeCount * 2);
    edgePositionAttr.needsUpdate = true;
    edgeColorAttr.needsUpdate = true;
  }

  const clock = new THREE.Clock();
  let animationFrameId = 0;

  function renderLoop() {
    animationFrameId = requestAnimationFrame(renderLoop);

    const t = clock.getElapsedTime();
    worldSphere.rotation.y += 0.0009;
    innerSphere.rotation.x -= 0.0006;
    innerSphere.rotation.z += 0.0004;

    keyLight.position.x = Math.sin(t * 0.35) * 56;
    keyLight.position.z = Math.cos(t * 0.28) * 56;

    controls.target.y = Math.sin(t * 0.45) * 2;
    controls.update();

    composer.render();
  }

  renderLoop();

  function onResize() {
    const { clientWidth, clientHeight } = container;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
    composer.setSize(clientWidth, clientHeight);
  }

  window.addEventListener('resize', onResize);

  return {
    update,
    dispose() {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', onResize);

      for (const node of spritePool) {
        scene.remove(node.sprite);
        node.material.dispose();
      }

      edgeGeometry.dispose();
      edgeMaterial.dispose();
      coverageGeometry.dispose();
      coverageMaterial.dispose();
      worldSphere.geometry.dispose();
      worldSphere.material.dispose();
      innerSphere.geometry.dispose();
      innerSphere.material.dispose();
      glowTexture.dispose();
      controls.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
