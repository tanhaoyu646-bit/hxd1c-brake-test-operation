import * as THREE from '../lib/three/three.module.js';

const SOURCE_PATH = '../assets/msts-neiyi-corridor/neiyi-neijiang-neijiangnan-scene.json';
const ROUTE_PATH = '../assets/msts-neiyi/neiyi-5635-trackdb-path.json';
const TEXTURE_PATH = '../assets/msts-neiyi-corridor/textures/';
const NEXT_STATION_DISTANCE = 12591.44;

export class MstsRouteScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.15 : 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a7bdca');
    this.scene.fog = new THREE.Fog('#a7b9c2', 500, 1600);
    this.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.15, 2200);
    this.routeRoot = new THREE.Group();
    this.routeRoot.name = 'MSTS_ROUTE_ROOT';
    this.scene.add(this.routeRoot);
    this.view = 'front';
    this.distance = 0;
    this.startOffset = 0;
    this.eyeHeight = 3.82;
    this.ready = false;
    this.error = null;
    this.routePoints = [];
    this.routeDistances = [];
    this.pathLength = 0;
    this.forward = new THREE.Vector3(-360.311, 0, 378.593).normalize();
    this.baseYaw = Math.atan2(-this.forward.x, -this.forward.z);
    this.materialCache = new Map();
    this.textureLoader = new THREE.TextureLoader();
    this.addEnvironment();
    this.applyCamera();
    this.loadPromise = this.load();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();
  }

  addEnvironment() {
    this.scene.add(new THREE.HemisphereLight('#eaf6ff', '#687264', 2.0));
    const sun = new THREE.DirectionalLight('#fff2d8', 2.4);
    sun.position.set(-120, 150, 80);
    this.scene.add(sun);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(5200, 5200),
      new THREE.MeshStandardMaterial({ color: '#71806e', roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.18;
    this.ground.frustumCulled = false;
    this.ground.material.depthWrite = false;
    this.ground.renderOrder = -10;
    this.scene.add(this.ground);
  }

  async load() {
    try {
      const [sceneResponse, pathResponse] = await Promise.all([
        fetch(SOURCE_PATH, { cache: 'no-store' }),
        fetch(ROUTE_PATH, { cache: 'no-store' }),
      ]);
      if (!sceneResponse.ok) throw new Error(`路线场景加载失败：HTTP ${sceneResponse.status}`);
      if (!pathResponse.ok) throw new Error(`轨道中心线加载失败：HTTP ${pathResponse.status}`);
      const [sceneData, pathData] = await Promise.all([sceneResponse.json(), pathResponse.json()]);
      this.buildRoute(sceneData);
      this.buildRoutePath(pathData);
      this.buildSelectedRouteTrack(NEXT_STATION_DISTANCE + 350);
      this.buildRailHighlights(NEXT_STATION_DISTANCE + 350);
      this.ready = true;
      this.applyCamera();
      this.canvas.dispatchEvent(new CustomEvent('route-ready', {
        detail: { ...sceneData.summary, ...pathData.summary, pathLength: this.pathLength },
      }));
    } catch (error) {
      this.error = error;
      this.canvas.dispatchEvent(new CustomEvent('route-error', { detail: error }));
      throw error;
    }
  }

  getMaterial(definition) {
    const textureName = definition?.texture || '';
    const key = `${textureName}|${definition?.alphaTestMode || 0}`;
    if (this.materialCache.has(key)) return this.materialCache.get(key);
    let texture = null;
    if (textureName) {
      texture = this.textureLoader.load(`${TEXTURE_PATH}${encodeURIComponent(textureName)}`);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    }
    const isTrackMaterial = /track/i.test(textureName);
    const material = new THREE.MeshStandardMaterial({
      color: texture ? 0xffffff : 0xadb5b3,
      map: texture,
      roughness: isTrackMaterial ? 0.48 : 0.88,
      metalness: isTrackMaterial ? 0.24 : 0.03,
      side: THREE.DoubleSide,
      alphaTest: texture ? 0.08 : 0,
    });
    material.name = definition?.name || textureName || 'MSTS_MATERIAL';
    this.materialCache.set(key, material);
    return material;
  }

  buildRoute(data) {
    const instancesByShape = new Map();
    data.instances.forEach((instance) => {
      if (!instancesByShape.has(instance.shape)) instancesByShape.set(instance.shape, []);
      instancesByShape.get(instance.shape).push(instance);
    });

    Object.values(data.shapes).forEach((shape) => {
      const instances = instancesByShape.get(shape.fileName) || [];
      if (!instances.length) return;
      shape.groups.forEach((group, groupIndex) => {
        if (!group.positions?.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        if (group.uvs?.length === (group.positions.length / 3) * 2) {
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
        }
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const material = this.getMaterial(shape.materials[group.materialIndex]);
        const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
        mesh.name = `${shape.fileName}:${groupIndex}`;
        mesh.frustumCulled = true;
        mesh.userData.sourceShape = shape.fileName;
        const object = new THREE.Object3D();
        instances.forEach((instance, index) => {
          object.position.fromArray(instance.position);
          object.quaternion.fromArray(instance.quaternion).normalize();
          object.scale.setScalar(1);
          object.updateMatrix();
          mesh.setMatrixAt(index, object.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        this.routeRoot.add(mesh);
      });
    });
  }

  buildRoutePath(data) {
    if (!Array.isArray(data.positions) || data.positions.length < 6 || data.positions.length % 3 !== 0) {
      throw new Error('轨道中心线数据格式无效');
    }
    this.routePoints = [];
    this.routeDistances = [0];
    for (let index = 0; index < data.positions.length; index += 3) {
      const point = new THREE.Vector3(data.positions[index], data.positions[index + 1], data.positions[index + 2]);
      this.routePoints.push(point);
      if (this.routePoints.length > 1) {
        const previous = this.routePoints[this.routePoints.length - 2];
        this.routeDistances.push(this.routeDistances[this.routeDistances.length - 1] + previous.distanceTo(point));
      }
    }
    this.pathLength = this.routeDistances[this.routeDistances.length - 1];
  }

  buildRailHighlights(maxDistance) {
    const count = this.routePoints.findIndex((_, index) => this.routeDistances[index] > maxDistance);
    const pointCount = count === -1 ? this.routePoints.length : Math.max(2, count + 1);
    const material = new THREE.MeshPhysicalMaterial({
      color: '#bfc8cd',
      metalness: 0.7,
      roughness: 0.22,
      clearcoat: 0.82,
      clearcoatRoughness: 0.1,
      emissive: '#242b2f',
      emissiveIntensity: 0.24,
      side: THREE.DoubleSide,
    });
    const glintMaterial = new THREE.MeshBasicMaterial({
      color: '#eef6fa',
      transparent: true,
      opacity: 0.58,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const gaugeHalf = 0.7175;
    const railHalfWidth = 0.036;
    for (const railOffset of [-gaugeHalf, gaugeHalf]) {
      const positions = [];
      const normals = [];
      const indices = [];
      for (let index = 0; index < pointCount; index += 1) {
        const point = this.routePoints[index];
        const previous = this.routePoints[Math.max(0, index - 1)];
        const next = this.routePoints[Math.min(pointCount - 1, index + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const center = point.clone().addScaledVector(right, railOffset);
        center.y += 0.008;
        const edgeA = center.clone().addScaledVector(right, -railHalfWidth);
        const edgeB = center.clone().addScaledVector(right, railHalfWidth);
        positions.push(edgeA.x, edgeA.y, edgeA.z, edgeB.x, edgeB.y, edgeB.z);
        normals.push(0, 1, 0, 0, 1, 0);
        if (index < pointCount - 1) {
          const base = index * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const rail = new THREE.Mesh(geometry, material);
      rail.name = railOffset < 0 ? 'SELECTED_ROUTE_RAIL_LEFT' : 'SELECTED_ROUTE_RAIL_RIGHT';
      this.routeRoot.add(rail);

      const glintPositions = [];
      const glintIndices = [];
      const glintHalfWidth = 0.006;
      for (let index = 0; index < pointCount; index += 1) {
        const point = this.routePoints[index];
        const previous = this.routePoints[Math.max(0, index - 1)];
        const next = this.routePoints[Math.min(pointCount - 1, index + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const innerEdge = railOffset - Math.sign(railOffset) * 0.016;
        const center = point.clone().addScaledVector(right, innerEdge);
        center.y += 0.011;
        const edgeA = center.clone().addScaledVector(right, -glintHalfWidth);
        const edgeB = center.clone().addScaledVector(right, glintHalfWidth);
        glintPositions.push(edgeA.x, edgeA.y, edgeA.z, edgeB.x, edgeB.y, edgeB.z);
        if (index < pointCount - 1) {
          const base = index * 2;
          glintIndices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const glintGeometry = new THREE.BufferGeometry();
      glintGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glintPositions, 3));
      glintGeometry.setIndex(glintIndices);
      glintGeometry.computeBoundingSphere();
      const glint = new THREE.Mesh(glintGeometry, glintMaterial);
      glint.name = railOffset < 0 ? 'SELECTED_ROUTE_GLINT_LEFT' : 'SELECTED_ROUTE_GLINT_RIGHT';
      glint.renderOrder = 3;
      this.routeRoot.add(glint);
    }
  }

  buildSelectedRouteTrack(maxDistance) {
    const count = this.routePoints.findIndex((_, index) => this.routeDistances[index] > maxDistance);
    const pointCount = count === -1 ? this.routePoints.length : Math.max(2, count + 1);
    const ribbon = (halfWidth, yOffset, material, name) => {
      const positions = [];
      const normals = [];
      const indices = [];
      for (let index = 0; index < pointCount; index += 1) {
        const point = this.routePoints[index];
        const previous = this.routePoints[Math.max(0, index - 1)];
        const next = this.routePoints[Math.min(pointCount - 1, index + 1)];
        const tangent = new THREE.Vector3().subVectors(next, previous);
        tangent.y = 0;
        if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
        tangent.normalize();
        const right = new THREE.Vector3(tangent.z, 0, -tangent.x);
        const center = point.clone();
        center.y += yOffset;
        const left = center.clone().addScaledVector(right, -halfWidth);
        const rightEdge = center.clone().addScaledVector(right, halfWidth);
        positions.push(left.x, left.y, left.z, rightEdge.x, rightEdge.y, rightEdge.z);
        normals.push(0, 1, 0, 0, 1, 0);
        if (index < pointCount - 1) {
          const base = index * 2;
          indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      this.routeRoot.add(mesh);
    };

    ribbon(1.55, -0.15, new THREE.MeshStandardMaterial({
      color: '#706b62', roughness: 0.98, metalness: 0.01, side: THREE.DoubleSide,
    }), 'SELECTED_ROUTE_BALLAST');

    const sleeperSpacing = 0.82;
    const sleeperCount = Math.floor(Math.min(maxDistance, this.pathLength) / sleeperSpacing) + 1;
    const sleeperGeometry = new THREE.BoxGeometry(2.45, 0.1, 0.2);
    const sleeperMaterial = new THREE.MeshStandardMaterial({
      color: '#625b50', roughness: 0.92, metalness: 0.02,
    });
    const sleepers = new THREE.InstancedMesh(sleeperGeometry, sleeperMaterial, sleeperCount);
    sleepers.name = 'SELECTED_ROUTE_SLEEPERS';
    sleepers.frustumCulled = false;
    const object = new THREE.Object3D();
    const point = new THREE.Vector3();
    const before = new THREE.Vector3();
    const after = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    for (let index = 0; index < sleeperCount; index += 1) {
      const distance = index * sleeperSpacing;
      this.getPathPosition(distance, point);
      this.getPathPosition(Math.max(0, distance - 1), before);
      this.getPathPosition(Math.min(this.pathLength, distance + 1), after);
      tangent.subVectors(after, before);
      tangent.y = 0;
      if (tangent.lengthSq() < 0.000001) tangent.copy(this.forward);
      tangent.normalize();
      object.position.copy(point);
      object.position.y -= 0.085;
      object.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
      object.scale.set(1, 1, 1);
      object.updateMatrix();
      sleepers.setMatrixAt(index, object.matrix);
    }
    sleepers.instanceMatrix.needsUpdate = true;
    this.routeRoot.add(sleepers);
  }

  getPathPosition(distance, target = new THREE.Vector3()) {
    if (this.routePoints.length < 2 || this.pathLength <= 0) {
      return target.copy(this.forward).multiplyScalar(distance);
    }
    const clamped = THREE.MathUtils.clamp(distance, 0, this.pathLength);
    let low = 0;
    let high = this.routeDistances.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (this.routeDistances[middle] <= clamped) low = middle;
      else high = middle;
    }
    const startDistance = this.routeDistances[low];
    const segmentLength = this.routeDistances[high] - startDistance;
    const ratio = segmentLength > 0 ? (clamped - startDistance) / segmentLength : 0;
    return target.lerpVectors(this.routePoints[low], this.routePoints[high], ratio);
  }

  setView(view) {
    this.view = view;
    this.applyCamera();
  }

  update(distance, speed, view = this.view) {
    this.distance = Math.max(0, Number(distance) || 0);
    this.speed = Math.max(0, Number(speed) || 0);
    this.view = view;
    this.canvas.classList.toggle('live', this.ready && (this.distance > 0.2 || view !== 'front'));
    this.applyCamera();
  }

  applyCamera() {
    const routeDistance = this.startOffset + this.distance;
    const position = this.getPathPosition(routeDistance);
    const tangentStart = this.getPathPosition(Math.max(0, routeDistance - 3));
    const tangentEnd = this.getPathPosition(Math.min(this.pathLength || routeDistance + 6, routeDistance + 6));
    const tangent = tangentEnd.sub(tangentStart);
    tangent.y = 0;
    if (tangent.lengthSq() > 0.000001) this.forward.copy(tangent.normalize());
    const baseYaw = Math.atan2(-this.forward.x, -this.forward.z);
    const yawOffsets = { front: 0, left: THREE.MathUtils.degToRad(65), right: THREE.MathUtils.degToRad(-65) };
    const pitchOffsets = { front: -0.22, left: -0.035, right: -0.035 };
    const lateralOffsets = { front: 0, left: -0.7, right: 0.7 };
    const right = new THREE.Vector3(this.forward.z, 0, -this.forward.x);
    this.camera.position.copy(position);
    this.camera.position.addScaledVector(right, lateralOffsets[this.view] || 0);
    this.camera.position.y += this.eyeHeight;
    if (this.ground) this.ground.position.set(position.x, position.y - 0.18, position.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(pitchOffsets[this.view] ?? pitchOffsets.front, baseYaw + (yawOffsets[this.view] || 0), 0);
  }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
