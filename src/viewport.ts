import * as THREE from 'three/webgpu';
import { getPsdLivePreview, type PsdLivePreview } from './psdComposite';
import { type Doc, leaves, effVisible, effOpacity } from './model';

/**
 * three.js always sends `swizzle: 'rgba'` (the identity) when it makes a texture view. Some Chrome/Edge versions
 * reject that property and throw. Dropping an identity swizzle changes nothing, so strip it to stay compatible.
 */
function patchTextureViewSwizzle() {
  const proto = (globalThis as unknown as { GPUTexture?: { prototype: { createView: (d?: Record<string, unknown>) => unknown } } }).GPUTexture?.prototype;
  if (!proto || (proto as { __swizzlePatched?: boolean }).__swizzlePatched) return;
  const orig = proto.createView;
  proto.createView = function (this: unknown, desc?: Record<string, unknown>) {
    if (desc && desc.swizzle === 'rgba') {
      const { swizzle: _identity, ...rest } = desc;
      void _identity;
      return orig.call(this, rest);
    }
    return orig.call(this, desc);
  };
  (proto as { __swizzlePatched?: boolean }).__swizzlePatched = true;
}

/**
 * three.js is only the *view*. The source of truth is the Doc model:
 * every edit changes the model, then syncDoc() pushes it into the scene.
 * World units are document pixels, +y up (so doc y is negated).
 */
export class Viewport {
  renderer!: THREE.WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  cx = 0;
  cy = 0;
  zoom = 1;
  width = 1;
  height = 1;
  backendName = 'unknown';
  lastRenderMs = 0;
  onFrame: () => void = () => {};

  private geo = new THREE.PlaneGeometry(1, 1);
  private meshes = new Map<string, THREE.Mesh>();
  private bgs = new Map<string, THREE.Mesh>();
  private bgDims = new Map<string, { w: number; h: number }>();
  private checker: THREE.CanvasTexture | null = null;
  private docIndex = new Map<string, number>();
  private docMeshIds = new Map<string, string[]>();
  private meshCanvas = new Map<string, HTMLCanvasElement>();
  private compositeMeshes = new Map<string, THREE.Mesh>();
  private compositeCanvas = new Map<string, HTMLCanvasElement>();
    private plateSerials = new Map<string, number>();
  private overlayMeshes = new Map<string, THREE.Mesh>();
  private overlayCanvas = new Map<string, HTMLCanvasElement>();
  private overlaySerials = new Map<string, number>();
  private pending = false;

  async init(el: HTMLElement) {
    patchTextureViewSwizzle();
    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    await this.renderer.init();
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    el.appendChild(this.renderer.domElement);
    const backend = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    this.backendName = backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (WebGPU not available, fallback)';
    new ResizeObserver(() => this.resize(el)).observe(el);
    this.resize(el);
  }

  private resize(el: HTMLElement) {
    this.width = Math.max(1, el.clientWidth);
    this.height = Math.max(1, el.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.updateCamera();
  }

  private updateCamera() {
    const c = this.camera;
    c.left = -this.width / 2;
    c.right = this.width / 2;
    c.top = this.height / 2;
    c.bottom = -this.height / 2;
    c.zoom = this.zoom;
    c.position.set(this.cx, this.cy, 10);
    c.updateProjectionMatrix();
    this.updateCheckers();
    this.requestRender();
  }

  /** Checkerboard squares stay ~10 screen px at every zoom level, like Photoshop's transparency grid. */
  private updateCheckers() {
    const sq = 10 / this.zoom;
    for (const [id, bg] of this.bgs) {
      const d = this.bgDims.get(id);
      const map = (bg.material as THREE.MeshBasicMaterial).map;
      if (d && map) map.repeat.set(d.w / (2 * sq), d.h / (2 * sq));
    }
  }

  private makeCheckerTexture(): THREE.CanvasTexture {
    if (!this.checker) {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 2, 2);
      g.fillStyle = '#cfcfcf';
      g.fillRect(1, 0, 1, 1);
      g.fillRect(0, 1, 1, 1);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      this.checker = t;
    }
    const t = this.checker.clone(); // own texture per document so each can have its own repeat
    t.needsUpdate = true;
    return t;
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const t0 = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.lastRenderMs = performance.now() - t0;
      this.onFrame();
    });
  }
private ensureDocQuad(map: Map<string, THREE.Mesh>, docId: string): THREE.Mesh {
    let mesh = map.get(docId);
    if (!mesh) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      mesh = new THREE.Mesh(this.geo, mat);
      this.scene.add(mesh);
      map.set(docId, mesh);
    }
    return mesh;
  }
 
  private placeDocQuad(mesh: THREE.Mesh, doc: Doc, order: number) {
    mesh.visible = true;
    mesh.renderOrder = order;
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(doc.width, doc.height, 1);
    mesh.position.set(doc.offsetX + doc.width / 2, -(doc.offsetY + doc.height / 2), 0);
  }
 
  /** Upload a canvas only when its pixels or size changed. Dragging reuses the plate texture. */
  private bindCanvas(
    mesh: THREE.Mesh,
    canvas: HTMLCanvasElement,
    serial: number,
    canvasMap: Map<string, HTMLCanvasElement>,
    serialMap: Map<string, number>,
    docId: string,
  ) {
    const mat = mesh.material as THREE.MeshBasicMaterial;
    const prev = canvasMap.get(docId);
    const prevSerial = serialMap.get(docId);
    const image = mat.map?.image as HTMLCanvasElement | undefined;
    const sizeChanged = !!image && (image.width !== canvas.width || image.height !== canvas.height);
    if (!mat.map || prev !== canvas || sizeChanged) {
      mat.map?.dispose();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
      canvasMap.set(docId, canvas);
      serialMap.set(docId, serial);
      return;
    }
    if (prevSerial !== serial) {
      mat.map.needsUpdate = true;
      serialMap.set(docId, serial);
    }
  }
 
  private syncLivePreview(doc: Doc, live: PsdLivePreview, docIdx: number) {
    const plate = this.ensureDocQuad(this.compositeMeshes, doc.id);
    this.placeDocQuad(plate, doc, docIdx * 100000 + 50000);
    this.bindCanvas(plate, live.base, live.baseSerial, this.compositeCanvas, this.plateSerials, doc.id);
 
    if (live.overlay) {
      const overlay = this.ensureDocQuad(this.overlayMeshes, doc.id);
      this.placeDocQuad(overlay, doc, docIdx * 100000 + 50001);
      this.bindCanvas(overlay, live.overlay, live.overlaySerial, this.overlayCanvas, this.overlaySerials, doc.id);
    } else {
      const overlay = this.overlayMeshes.get(doc.id);
      if (overlay) overlay.visible = false;
    }
 
    for (const id of this.docMeshIds.get(doc.id) ?? []) {
      const m = this.meshes.get(id);
      if (m) m.visible = false;
    }
    this.requestRender();
  }
  addDoc(doc: Doc, index: number) {
    this.docIndex.set(doc.id, index);
    const bg = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ map: this.makeCheckerTexture(), depthTest: false, depthWrite: false }));
    bg.renderOrder = index * 100000;
    this.scene.add(bg);
    this.bgs.set(doc.id, bg);
    this.bgDims.set(doc.id, { w: doc.width, h: doc.height });
    this.updateCheckers();
    const meshIds: string[] = [];
    this.docMeshIds.set(doc.id, meshIds);
    leaves(doc).forEach((n, i) => {
      if (!n.canvas || n.w === 0 || n.h === 0) return;
      const tex = new THREE.CanvasTexture(n.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.renderOrder = index * 100000 + i + 1;
      this.scene.add(mesh);
      this.meshes.set(n.id, mesh);
      this.meshCanvas.set(n.id, n.canvas);
      meshIds.push(n.id);
    });
    this.syncDoc(doc);
  }

  syncDoc(doc: Doc) {
    const bg = this.bgs.get(doc.id);
    if (bg) {
      bg.visible = true;
      bg.scale.set(doc.width, doc.height, 1);
      bg.position.set(doc.offsetX + doc.width / 2, -(doc.offsetY + doc.height / 2), 0);
    }
    const docIdx = this.docIndex.get(doc.id) ?? 0;
    const live = doc.format === 'psd' ? getPsdLivePreview(doc) : null;
    if (live) {
      this.syncLivePreview(doc, live, docIdx);
      return;
    }
 
    const compositeMesh = this.compositeMeshes.get(doc.id);
    if (compositeMesh) compositeMesh.visible = false;
    const overlayMesh = this.overlayMeshes.get(doc.id);
    if (overlayMesh) overlayMesh.visible = false;
 
    const liveIds = new Set<string>();
    const meshIds = this.docMeshIds.get(doc.id) ?? [];
    leaves(doc).forEach((n, i) => {
      liveIds.add(n.id);
      let m = this.meshes.get(n.id);
      if (!m) {
        if (!n.canvas || n.w === 0 || n.h === 0) return;
        const tex = new THREE.CanvasTexture(n.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        m = new THREE.Mesh(this.geo, mat);
        this.scene.add(m);
        this.meshes.set(n.id, m);
        this.meshCanvas.set(n.id, n.canvas);
        meshIds.push(n.id);
      }
      if (n.canvas && this.meshCanvas.get(n.id) !== n.canvas) {
        // the layer's pixels were replaced (text/colour edit, undo): upload a new texture
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        const tex = new THREE.CanvasTexture(n.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map = tex;
        mat.needsUpdate = true;
        this.meshCanvas.set(n.id, n.canvas);
      }
      m.renderOrder = docIdx * 100000 + i + 1;
      m.visible = effVisible(n);
      (m.material as THREE.MeshBasicMaterial).opacity = effOpacity(n);
      m.scale.set(n.w, n.h, 1);
      m.rotation.z = (-n.rotation * Math.PI) / 180; // doc y points down, world y up
      m.position.set(doc.offsetX + n.x + n.w / 2, -(doc.offsetY + n.y + n.h / 2), 0);
    });
    this.docMeshIds.set(doc.id, meshIds);
    // layers removed from the model (deleted): hide their meshes, keep them so undo can bring them back
    for (const id of meshIds) {
      if (!liveIds.has(id)) {
        const m = this.meshes.get(id);
        if (m) m.visible = false;
      }
    }
    this.requestRender();
  }

  getView() {
    return { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  setView(v: { cx: number; cy: number; zoom: number }) {
    this.cx = v.cx;
    this.cy = v.cy;
    this.zoom = Math.min(32, Math.max(0.02, v.zoom));
    this.updateCamera();
  }

  /** Hide or show every mesh of a document (used by Close file and its undo). */
  setDocVisible(doc: Doc, visible: boolean) {
    const bg = this.bgs.get(doc.id);
    if (bg) bg.visible = visible;
    const cm = this.compositeMeshes.get(doc.id);
    if (cm) cm.visible = visible;
    const om = this.overlayMeshes.get(doc.id);
    if (om && !visible) om.visible = false;
    for (const id of this.docMeshIds.get(doc.id) ?? []) {
      const m = this.meshes.get(id);
      if (m && !visible) m.visible = false;
    }
    if (visible) this.syncDoc(doc);
    else this.requestRender();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(32, Math.max(0.02, this.zoom * factor));
    this.cx = before.x - (sx - this.width / 2) / this.zoom;
    this.cy = before.y + (sy - this.height / 2) / this.zoom;
    this.updateCamera();
  }

  panBy(dxScreen: number, dyScreen: number) {
    this.cx -= dxScreen / this.zoom;
    this.cy += dyScreen / this.zoom;
    this.updateCamera();
  }

  fit(docs: Doc[]) {
    if (!docs.length) return;
    const x1 = Math.min(...docs.map((d) => d.offsetX));
    const y1 = Math.min(...docs.map((d) => d.offsetY));
    const x2 = Math.max(...docs.map((d) => d.offsetX + d.width));
    const y2 = Math.max(...docs.map((d) => d.offsetY + d.height));
    const pad = 80;
    this.zoom = Math.min(this.width / (x2 - x1 + pad), this.height / (y2 - y1 + pad));
    this.cx = (x1 + x2) / 2;
    this.cy = -(y1 + y2) / 2;
    this.updateCamera();
  }

  screenToWorld(sx: number, sy: number) {
    return {
      x: this.cx + (sx - this.width / 2) / this.zoom,
      y: this.cy - (sy - this.height / 2) / this.zoom,
    };
  }

  screenToDoc(doc: Doc, sx: number, sy: number) {
    const w = this.screenToWorld(sx, sy);
    return { x: w.x - doc.offsetX, y: -w.y - doc.offsetY };
  }

  docToScreen(doc: Doc, x: number, y: number) {
    const wx = doc.offsetX + x;
    const wy = -(doc.offsetY + y);
    return {
      x: (wx - this.cx) * this.zoom + this.width / 2,
      y: -(wy - this.cy) * this.zoom + this.height / 2,
    };
  }
}
