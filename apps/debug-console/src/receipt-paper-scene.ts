import * as THREE from 'three';
import type { SessionReceipt } from './session-receipt';
import { drawPaperBump, drawReceiptTexture } from './receipt-paper-texture';
import { feedProgress, paperPoint, PRINT_DURATION_MS } from './receipt-feed';

export function createReceiptScene(host: HTMLElement, receipt: SessionReceipt, onFinished: () => void, onFailure: () => void) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-128, 128, 0, -300, .1, 1000);
  camera.position.z = 500;
  const geometry = new THREE.PlaneGeometry(224, 300, 64, 48);
  const bump = new THREE.CanvasTexture(drawPaperBump());
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(3, 4);
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide, bumpMap: bump, bumpScale: .12 });
  const paper = new THREE.Mesh(geometry, material);
  paper.castShadow = true; paper.receiveShadow = true; scene.add(paper);
  const backingGeometry = new THREE.PlaneGeometry(400, 800);
  const backingMaterial = new THREE.ShadowMaterial({ opacity: .12 });
  const backing = new THREE.Mesh(backingGeometry, backingMaterial);
  backing.position.set(0, -250, -4); backing.receiveShadow = true; scene.add(backing);
  scene.add(new THREE.AmbientLight('#ffffff', 1.8));
  const light = new THREE.DirectionalLight('#ffffff', 1.8);
  light.position.set(-80, -10, 300); light.target.position.set(0, -120, 0);
  light.castShadow = true; light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.left = -240; light.shadow.camera.right = 240;
  light.shadow.camera.top = 400; light.shadow.camera.bottom = -400;
  light.shadow.camera.near = .1; light.shadow.camera.far = 1000;
  light.shadow.bias = -.0004; light.shadow.normalBias = .3; light.shadow.radius = 5; light.shadow.blurSamples = 12;
  scene.add(light, light.target);
  let height = 300, current = receipt, texture: THREE.CanvasTexture | undefined;
  let frame = 0, started = performance.now(), elapsed = 0, hiddenAt = document.hidden ? started : 0, disposed = false, finished = false;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateTexture = () => {
    const next = new THREE.CanvasTexture(drawReceiptTexture(current, 224, height));
    next.colorSpace = THREE.SRGBColorSpace;
    next.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
    material.map = next; material.needsUpdate = true; texture?.dispose(); texture = next;
  };
  const render = () => {
    const p = finished || media.matches ? 1 : feedProgress(elapsed);
    const positions = geometry.attributes.position as THREE.BufferAttribute;
    for (let row = 0; row <= 48; row++) {
      for (let column = 0; column <= 64; column++) {
        const point = paperPoint(column / 64, row / 48, p, 224, height);
        positions.setXYZ(row * 65 + column, point.x, point.y, point.z);
      }
    }
    positions.needsUpdate = true; geometry.computeVertexNormals();
    // Only exposed paper casts a shadow; an unprinted page stays above the viewport.
    paper.visible = p > 0;
    renderer.render(scene, camera);
  };
  const resize = () => {
    if (disposed || !host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    const worldHeight = host.clientHeight / host.clientWidth * 256;
    camera.bottom = -worldHeight; camera.updateProjectionMatrix();
    height = worldHeight - 10;
    updateTexture(); render();
  };
  const tick = (now: number) => {
    if (disposed || document.hidden) return;
    elapsed = now - started; render();
    if (media.matches || elapsed >= PRINT_DURATION_MS) {
      if (!finished) { finished = true; onFinished(); }
    } else frame = requestAnimationFrame(tick);
  };
  const visibility = () => {
    if (document.hidden) { hiddenAt = performance.now(); cancelAnimationFrame(frame); }
    else { if (hiddenAt) started += performance.now() - hiddenAt; hiddenAt = 0; if (!finished) frame = requestAnimationFrame(tick); }
  };
  const motion = () => { if (media.matches) { cancelAnimationFrame(frame); tick(performance.now()); } };
  const lost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(frame); onFailure(); };
  const observer = new ResizeObserver(resize); observer.observe(host);
  renderer.domElement.addEventListener('webglcontextlost', lost);
  document.addEventListener('visibilitychange', visibility); media.addEventListener('change', motion);
  const dispose = () => {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(frame); observer.disconnect();
    document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion);
    renderer.domElement.removeEventListener('webglcontextlost', lost);
    geometry.dispose(); material.dispose(); texture?.dispose(); bump.dispose(); backingGeometry.dispose(); backingMaterial.dispose();
    light.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  };
  try { resize(); frame = requestAnimationFrame(tick); } catch (error) { dispose(); throw error; }
  return {
    update(next: SessionReceipt) { if (!disposed) { current = next; updateTexture(); render(); } },
    dispose,
  };
}
