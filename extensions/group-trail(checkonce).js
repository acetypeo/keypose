// ============================================================
// KeyPose Extension: Group Vertex Trails + Point Cloud
// - White dots for all vertices (edit mode)
// - Shift+Click: toggle vertex in active group (orange sphere)
// - One wide trail per group follows group centroid
// ============================================================

let trails = new Map();           // groupId -> trail object
let groups = new Map();           // groupId -> { name, vertices: Set(key), markerSpheres: Map }
let activeGroupId = null;
let animationFrameId = null;
let frameCounter = 0;

let trailLength = 30;
let trailWidth = 0.35;            // wider default for group trail
let fadeStart = 0.2;
let fadeEnd = 0.85;
let trailColorHex = '#ff3366';
let glowIntensity = 1.3;
let twistAngle = 0.0;
let sampleRate = 1;

let apiRef = null;
let activeTab = 'edit';

// ========== VERTEX POINT CLOUDS (WHITE DOTS) ==========
let vertexPointClouds = new Map();   // mesh -> { pointsMesh, pointCount }

function createVertexPointCloud(mesh) {
    const THREE = apiRef.THREE;
    const geom = mesh.geometry;
    if (!geom || !geom.attributes.position) return null;
    const pointCount = geom.attributes.position.count;
    if (pointCount === 0) return null;
    const dummyPositions = new Float32Array(pointCount * 3);
    const pointsGeom = new THREE.BufferGeometry();
    pointsGeom.setAttribute('position', new THREE.BufferAttribute(dummyPositions, 3));
    const pointsMat = new THREE.PointsMaterial({ 
        color: 0xffffff, size: 0.065, transparent: true, opacity: 0.85, depthTest: false
    });
    const pointsMesh = new THREE.Points(pointsGeom, pointsMat);
    apiRef.scene.add(pointsMesh);
    return { pointsMesh, pointCount };
}

function updatePointCloud(mesh, data) {
    const pointCount = data.pointCount;
    const positions = new Float32Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
        const worldPos = getVertexWorldPosition(mesh, i);
        if (worldPos) {
            positions[i*3] = worldPos.x;
            positions[i*3+1] = worldPos.y;
            positions[i*3+2] = worldPos.z;
        }
    }
    data.pointsMesh.geometry.attributes.position.array = positions;
    data.pointsMesh.geometry.attributes.position.needsUpdate = true;
}

function ensurePointCloudsForAllMeshes() {
    const models = apiRef.getLoadedModels ? apiRef.getLoadedModels() : [];
    const currentMeshes = new Set();
    for (const model of models) {
        if (!model.userData.inScene) continue;
        model.traverse(child => {
            if (child.isMesh && child.geometry && child.geometry.attributes.position) {
                currentMeshes.add(child);
                if (!vertexPointClouds.has(child)) {
                    const viz = createVertexPointCloud(child);
                    if (viz) vertexPointClouds.set(child, viz);
                }
            }
        });
    }
    for (let [mesh, data] of vertexPointClouds.entries()) {
        if (!currentMeshes.has(mesh) || !mesh.parent) {
            apiRef.scene.remove(data.pointsMesh);
            data.pointsMesh.geometry.dispose();
            vertexPointClouds.delete(mesh);
        }
    }
}

// ========== CORRECT VERTEX WORLD POSITION ==========
function getVertexWorldPosition(mesh, vertexIndex) {
    const THREE = apiRef.THREE;
    const geom = mesh.geometry;
    if (!geom) return null;
    const posAttr = geom.attributes.position;
    if (!posAttr) return null;
    const localPos = new THREE.Vector3(posAttr.getX(vertexIndex), posAttr.getY(vertexIndex), posAttr.getZ(vertexIndex));
    mesh.updateWorldMatrix(true, true);
    if (mesh.isSkinnedMesh && mesh.skeleton) {
        mesh.skeleton.update();
        const skinIndexAttr = geom.attributes.skinIndex;
        const skinWeightAttr = geom.attributes.skinWeight;
        if (skinIndexAttr && skinWeightAttr) {
            const skeleton = mesh.skeleton;
            const boneInverses = skeleton.boneInverses;
            const bones = skeleton.bones;
            const idx = [skinIndexAttr.getX(vertexIndex), skinIndexAttr.getY(vertexIndex), skinIndexAttr.getZ(vertexIndex), skinIndexAttr.getW(vertexIndex)];
            const wgt = [skinWeightAttr.getX(vertexIndex), skinWeightAttr.getY(vertexIndex), skinWeightAttr.getZ(vertexIndex), skinWeightAttr.getW(vertexIndex)];
            const finalPos = new THREE.Vector3(0,0,0);
            for (let i = 0; i < 4; i++) {
                const boneIdx = idx[i];
                if (boneIdx === undefined || boneIdx < 0) continue;
                const weight = wgt[i];
                if (weight <= 0) continue;
                const bone = bones[boneIdx];
                const inverseBind = boneInverses[boneIdx];
                if (!bone || !inverseBind) continue;
                const bindSpacePos = localPos.clone().applyMatrix4(inverseBind);
                const worldPos = bindSpacePos.applyMatrix4(bone.matrixWorld);
                finalPos.add(worldPos.multiplyScalar(weight));
            }
            return finalPos;
        }
    }
    return localPos.clone().applyMatrix4(mesh.matrixWorld);
}

// ========== GROUP CENTROID ==========
function getGroupCentroid(group) {
    const THREE = apiRef.THREE;
    let sum = new THREE.Vector3(0,0,0);
    let count = 0;
    for (const key of group.vertices) {
        const [meshUuid, vertexIdx] = key.split(':');
        const mesh = findMeshByUuid(meshUuid);
        if (mesh && mesh.parent) {
            const pos = getVertexWorldPosition(mesh, parseInt(vertexIdx));
            if (pos) { sum.add(pos); count++; }
        }
    }
    if (count === 0) return null;
    return sum.divideScalar(count);
}

function findMeshByUuid(uuid) {
    const models = apiRef.getLoadedModels ? apiRef.getLoadedModels() : [];
    for (const model of models) {
        let found = null;
        model.traverse(child => { if (child.isMesh && child.uuid === uuid) found = child; });
        if (found) return found;
    }
    return null;
}

// ========== RIBBON TRAIL (PER GROUP) ==========
function rebuildRibbonForGroup(groupId) {
    const trail = trails.get(groupId);
    if (!trail) return;
    const THREE = apiRef.THREE;
    const points = trail.historyPositions;
    if (points.length < 2) {
        if (trail.ribbonMesh && trail.ribbonMesh.parent) trail.ribbonMesh.parent.remove(trail.ribbonMesh);
        return;
    }
    const numPoints = points.length;
    const vertices = [], indices = [], alphas = [];
    for (let i = 0; i < numPoints; i++) {
        const t = (numPoints - 1 - i) / (numPoints - 1);
        let dir = new THREE.Vector3(0,0,1);
        if (i < numPoints-1) dir = new THREE.Vector3().subVectors(points[i+1], points[i]).normalize();
        else if (i > 0) dir = new THREE.Vector3().subVectors(points[i], points[i-1]).normalize();
        const up = new THREE.Vector3(0,1,0);
        let right = new THREE.Vector3().crossVectors(dir, up).normalize();
        if (Math.abs(right.length()) < 0.01) right = new THREE.Vector3(1,0,0);
        const twistRad = twistAngle * (1-t) * Math.PI;
        if (Math.abs(twistRad) > 0.001) {
            const twistQuat = new THREE.Quaternion().setFromAxisAngle(dir, twistRad);
            right.applyQuaternion(twistQuat);
        }
        const leftOffset = right.clone().multiplyScalar(-trail.width * 0.5);
        const rightOffset = right.clone().multiplyScalar(trail.width * 0.5);
        const leftPos = points[i].clone().add(leftOffset);
        const rightPos = points[i].clone().add(rightOffset);
        let alpha = 1.0;
        if (t <= fadeStart) alpha = 1.0;
        else if (t >= fadeEnd) alpha = 0.0;
        else alpha = 1.0 - ((t-fadeStart)/(fadeEnd-fadeStart));
        alpha = Math.min(1.0, Math.max(0.0, alpha)) * 0.95;
        vertices.push(leftPos.x, leftPos.y, leftPos.z);
        vertices.push(rightPos.x, rightPos.y, rightPos.z);
        alphas.push(alpha, alpha);
    }
    const segments = numPoints-1;
    for (let i=0; i<segments; i++) {
        const base = i*2;
        indices.push(base, base+1, base+2);
        indices.push(base+1, base+3, base+2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(alphas), 1));
    geometry.setIndex(indices);
    const vertexShader = `
        attribute float alpha;
        varying float vAlpha;
        void main() {
            vAlpha = alpha;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = 1.0;
            gl_Position = projectionMatrix * mvPosition;
        }
    `;
    const fragmentShader = `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vAlpha;
        void main() {
            gl_FragColor = vec4(uColor * uIntensity, vAlpha);
        }
    `;
    if (trail.material) trail.material.dispose();
    trail.material = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(trail.colorHex) }, uIntensity: { value: trail.intensity } },
        vertexShader, fragmentShader, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    });
    if (trail.ribbonMesh) trail.ribbonMesh.parent?.remove(trail.ribbonMesh);
    trail.ribbonMesh = new THREE.Mesh(geometry, trail.material);
    apiRef.scene.add(trail.ribbonMesh);
}

function addGroupSample(groupId) {
    const group = groups.get(groupId);
    const trail = trails.get(groupId);
    if (!group || !trail) return;
    const centroid = getGroupCentroid(group);
    if (!centroid) return;
    trail.historyPositions.push(centroid.clone());
    while (trail.historyPositions.length > trailLength+1) trail.historyPositions.shift();
    rebuildRibbonForGroup(groupId);
}

// ========== VERTEX MARKERS (ORANGE SPHERES) ==========
function addVertexMarker(mesh, vertexIdx) {
    const THREE = apiRef.THREE;
    const pos = getVertexWorldPosition(mesh, vertexIdx);
    if (!pos) return null;
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xff8844, emissive: 0xff4400, emissiveIntensity: 0.8 })
    );
    sphere.position.copy(pos);
    apiRef.scene.add(sphere);
    return sphere;
}

function updateAllMarkers() {
    // Update positions and existence of markers for all groups
    for (let [groupId, group] of groups.entries()) {
        for (let key of group.vertices) {
            let marker = group.markerSpheres.get(key);
            if (!marker) {
                const [meshUuid, vertexIdx] = key.split(':');
                const mesh = findMeshByUuid(meshUuid);
                if (mesh) {
                    marker = addVertexMarker(mesh, parseInt(vertexIdx));
                    if (marker) group.markerSpheres.set(key, marker);
                }
            } else {
                const [meshUuid, vertexIdx] = key.split(':');
                const mesh = findMeshByUuid(meshUuid);
                if (mesh && mesh.parent) {
                    const newPos = getVertexWorldPosition(mesh, parseInt(vertexIdx));
                    if (newPos) marker.position.copy(newPos);
                }
            }
        }
        // Remove markers for vertices no longer in group
        for (let [key, marker] of group.markerSpheres.entries()) {
            if (!group.vertices.has(key)) {
                apiRef.scene.remove(marker);
                group.markerSpheres.delete(key);
            }
        }
    }
    // Also remove orphaned markers (if any)
    const allGroupKeys = new Set();
    for (let group of groups.values()) {
        for (let key of group.markerSpheres.keys()) allGroupKeys.add(key);
    }
    for (let [key, marker] of vertexPointClouds) {} // not used
}

// ========== GROUP MANAGEMENT ==========
function createGroup(name) {
    const id = 'group_' + Date.now() + '_' + Math.random().toString(36);
    groups.set(id, { name, vertices: new Set(), markerSpheres: new Map() });
    updateGroupUI();
    return id;
}

function deleteGroup(groupId) {
    const group = groups.get(groupId);
    if (group) {
        for (let marker of group.markerSpheres.values()) apiRef.scene.remove(marker);
        groups.delete(groupId);
    }
    const trail = trails.get(groupId);
    if (trail) {
        if (trail.ribbonMesh) apiRef.scene.remove(trail.ribbonMesh);
        if (trail.material) trail.material.dispose();
        trails.delete(groupId);
    }
    if (activeGroupId === groupId) activeGroupId = null;
    updateGroupUI();
}

function setActiveGroup(groupId) {
    activeGroupId = groupId;
    updateGroupUI();
}

function toggleVertexInActiveGroup(mesh, vertexIdx) {
    if (!activeGroupId) {
        alert('Create or select a group first (click "New Group" or choose from list)');
        return false;
    }
    const group = groups.get(activeGroupId);
    if (!group) return false;
    const key = `${mesh.uuid}:${vertexIdx}`;
    if (group.vertices.has(key)) {
        group.vertices.delete(key);
        // marker will be removed in updateAllMarkers
    } else {
        group.vertices.add(key);
    }
    updateAllMarkers();
    updateGroupUI();
    return true;
}

function createTrailForGroup(groupId) {
    const group = groups.get(groupId);
    if (!group || group.vertices.size === 0) {
        alert('Group has no vertices selected');
        return;
    }
    if (trails.has(groupId)) {
        const old = trails.get(groupId);
        if (old.ribbonMesh) apiRef.scene.remove(old.ribbonMesh);
        if (old.material) old.material.dispose();
        trails.delete(groupId);
    }
    trails.set(groupId, {
        groupId,
        historyPositions: [],
        ribbonMesh: null,
        material: null,
        width: trailWidth,
        colorHex: trailColorHex,
        intensity: glowIntensity
    });
    const centroid = getGroupCentroid(group);
    if (centroid) trails.get(groupId).historyPositions.push(centroid.clone());
    updateGroupUI();
}

function removeTrailForGroup(groupId) {
    const trail = trails.get(groupId);
    if (trail) {
        if (trail.ribbonMesh) apiRef.scene.remove(trail.ribbonMesh);
        if (trail.material) trail.material.dispose();
        trails.delete(groupId);
    }
    updateGroupUI();
}

// ========== UI RENDERING ==========
function updateGroupUI() {
    const container = document.getElementById('group-list');
    if (!container) return;
    let html = '';
    for (let [id, group] of groups.entries()) {
        const isActive = (id === activeGroupId);
        const hasTrail = trails.has(id);
        html += `
            <div style="background:#2a2a3a; margin:4px 0; padding:6px; border-radius:6px; ${isActive ? 'border-left: 3px solid #ff8844;' : ''}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:11px;"><strong>${group.name}</strong> (${group.vertices.size} verts)</span>
                    <div>
                        <button class="group-select" data-id="${id}" style="background:#555; border:none; color:white; border-radius:4px; margin:0 2px; font-size:9px;">${isActive ? '✔ Active' : 'Select'}</button>
                        <button class="group-trail" data-id="${id}" style="background:#3a6a3a; border:none; color:white; border-radius:4px; margin:0 2px; font-size:9px;">${hasTrail ? '🔄 Recreate Trail' : '✨ Create Trail'}</button>
                        <button class="group-removetrail" data-id="${id}" style="background:#aa6644; border:none; color:white; border-radius:4px; margin:0 2px; font-size:9px;">🗑️ Trail</button>
                        <button class="group-delete" data-id="${id}" style="background:#aa3333; border:none; color:white; border-radius:4px; margin:0 2px; font-size:9px;">✕</button>
                    </div>
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
    document.querySelectorAll('.group-select').forEach(btn => btn.onclick = () => setActiveGroup(btn.dataset.id));
    document.querySelectorAll('.group-trail').forEach(btn => btn.onclick = () => createTrailForGroup(btn.dataset.id));
    document.querySelectorAll('.group-removetrail').forEach(btn => btn.onclick = () => removeTrailForGroup(btn.dataset.id));
    document.querySelectorAll('.group-delete').forEach(btn => btn.onclick = () => deleteGroup(btn.dataset.id));
}

function setActiveTab(tab) {
    activeTab = tab;
    // Show/hide point clouds
    for (let [mesh, data] of vertexPointClouds.entries()) {
        data.pointsMesh.visible = (tab === 'edit');
    }
    // Show/hide group markers (orange spheres)
    for (let group of groups.values()) {
        for (let marker of group.markerSpheres.values()) {
            marker.visible = (tab === 'edit');
        }
    }
    const editPanel = document.getElementById('trail-edit-panel');
    const paramsPanel = document.getElementById('trail-params-panel');
    if (editPanel && paramsPanel) {
        editPanel.style.display = (tab === 'edit') ? 'block' : 'none';
        paramsPanel.style.display = (tab === 'params') ? 'block' : 'none';
    }
}

// ========== ANIMATION LOOP ==========
function updateAll() {
    frameCounter++;
    if (frameCounter % sampleRate === 0) {
        for (let groupId of trails.keys()) addGroupSample(groupId);
    }
    // Update point clouds (white dots)
    ensurePointCloudsForAllMeshes();
    if (activeTab === 'edit') {
        for (let [mesh, data] of vertexPointClouds.entries()) {
            if (mesh.parent) {
                mesh.updateWorldMatrix(true, true);
                if (mesh.isSkinnedMesh && mesh.skeleton) mesh.skeleton.update();
                updatePointCloud(mesh, data);
            }
        }
    }
    // Update markers positions
    updateAllMarkers();
}

function startAnimationLoop() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    function loop() { updateAll(); animationFrameId = requestAnimationFrame(loop); }
    loop();
}

// ========== VERTEX SELECTION (TOGGLE) ==========
function getNearestVertex(mesh, point) {
    const THREE = apiRef.THREE;
    const geom = mesh.geometry;
    if (!geom || !geom.attributes.position) return null;
    mesh.updateWorldMatrix(true, true);
    const localPoint = mesh.worldToLocal(point.clone());
    const positions = geom.attributes.position.array;
    let minDist = Infinity, nearest = -1;
    for (let i = 0; i < positions.length / 3; i++) {
        const v = new THREE.Vector3(positions[i*3], positions[i*3+1], positions[i*3+2]);
        const d = v.distanceTo(localPoint);
        if (d < minDist) { minDist = d; nearest = i; }
    }
    return nearest;
}

// ========== EXTENSION EXPORT ==========
export default {
    id: 'vertex-mesh-trail-group',
    name: '🗡️ Group Vertex Trails (Wide Slash)',
    type: 'per-model',
    params: {
        trailLength: 30,
        trailWidth: 0.35,
        fadeStart: 0.2,
        fadeEnd: 0.85,
        color: '#ff3366',
        intensity: 1.3,
        twist: 0.0,
        sampleRate: 1
    },
    init(api) {
        apiRef = api;
        const THREE = api.THREE;
        if (this.params) {
            trailLength = this.params.trailLength;
            trailWidth = this.params.trailWidth;
            fadeStart = this.params.fadeStart;
            fadeEnd = this.params.fadeEnd;
            trailColorHex = this.params.color;
            glowIntensity = this.params.intensity;
            twistAngle = this.params.twist;
            sampleRate = this.params.sampleRate;
        }
        ensurePointCloudsForAllMeshes();
        const canvas = api.renderer.domElement;
        const onVertexClick = (e) => {
            if (!e.shiftKey) return;
            if (activeTab !== 'edit') return;
            e.stopPropagation();
            const rect = canvas.getBoundingClientRect();
            const mouse = new THREE.Vector2();
            mouse.x = ((e.clientX - rect.left)/rect.width)*2 -1;
            mouse.y = -((e.clientY - rect.top)/rect.height)*2 +1;
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, api.camera);
            const meshes = [];
            const models = api.getLoadedModels ? api.getLoadedModels() : [];
            for (let model of models) {
                if (model.userData.inScene) model.traverse(c => { if (c.isMesh) meshes.push(c); });
            }
            const hits = raycaster.intersectObjects(meshes);
            if (hits.length) {
                const mesh = hits[0].object;
                const vertexIdx = getNearestVertex(mesh, hits[0].point);
                if (vertexIdx !== null) {
                    toggleVertexInActiveGroup(mesh, vertexIdx);
                }
            }
        };
        canvas.addEventListener('click', onVertexClick);
        this._cleanup = () => canvas.removeEventListener('click', onVertexClick);
        if (groups.size === 0) {
            createGroup('Slash Group');
            setActiveGroup(Array.from(groups.keys())[0]);
        }
        startAnimationLoop();
    },
    onSelect() {
        const panel = document.getElementById('param-panel');
        const title = document.getElementById('param-title');
        const content = document.getElementById('param-content');
        if (!panel || !title || !content) return;
        title.textContent = this.name;
        content.innerHTML = `
            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <button id="tab-edit-btn" style="flex:1; background:#ff8844;">✏️ Edit Trails</button>
                <button id="tab-params-btn" style="flex:1; background:#333;">⚙️ Parameters</button>
            </div>
            <div id="trail-edit-panel">
                <div style="background:#2a2a3a; padding:6px; border-radius:6px; margin-bottom:10px;">
                    <small>💡 <strong>Shift+Click</strong> on a vertex to add/remove from active group.<br>
                    <span style="color:#aaa;">White dots</span> = all vertices.<br>
                    <span style="color:#ff8844;">Orange spheres</span> = vertices in active group.<br>
                    Groups create a <strong>single wide trail</strong> following the group's center.</small>
                </div>
                <button id="new-group-btn" style="background:#3a6a3a; width:100%; margin-bottom:8px;">➕ New Group</button>
                <div id="group-list" style="max-height:200px; overflow-y:auto; margin-bottom:8px;"></div>
                <button id="clear-all-groups-btn" style="background:#aa4444; width:100%;">🗑️ Remove All Groups & Trails</button>
            </div>
            <div id="trail-params-panel" style="display:none;">
                <div class="param-row"><label>📏 Trail Length (frames)</label><input type="range" id="trail-length" min="5" max="80" step="1" value="${trailLength}"><span id="trail-length-val">${trailLength}</span></div>
                <div class="param-row"><label>📐 Trail Width</label><input type="range" id="trail-width" min="0.05" max="1.2" step="0.01" value="${trailWidth}"><span id="trail-width-val">${trailWidth}</span></div>
                <div class="param-row"><label>🌀 Fade Start</label><input type="range" id="fade-start" min="0" max="0.9" step="0.01" value="${fadeStart}"><span id="fade-start-val">${fadeStart}</span></div>
                <div class="param-row"><label>🌀 Fade End</label><input type="range" id="fade-end" min="0.1" max="1" step="0.01" value="${fadeEnd}"><span id="fade-end-val">${fadeEnd}</span></div>
                <div class="param-row"><label>🎨 Trail Color</label><input type="color" id="trail-color" value="${trailColorHex}"></div>
                <div class="param-row"><label>✨ Glow Intensity</label><input type="range" id="glow-intensity" min="0.2" max="2.5" step="0.01" value="${glowIntensity}"><span id="glow-intensity-val">${glowIntensity}</span></div>
                <div class="param-row"><label>🔁 Twist / Roll</label><input type="range" id="twist" min="-0.8" max="0.8" step="0.01" value="${twistAngle}"><span id="twist-val">${twistAngle}</span></div>
                <div class="param-row"><label>⏱️ Sample Rate (frames)</label><input type="range" id="sample-rate" min="1" max="5" step="1" value="${sampleRate}"><span id="sample-rate-val">${sampleRate}</span></div>
            </div>
        `;
        const editBtn = content.querySelector('#tab-edit-btn');
        const paramsBtn = content.querySelector('#tab-params-btn');
        editBtn.onclick = () => { setActiveTab('edit'); editBtn.style.background='#ff8844'; paramsBtn.style.background='#333'; };
        paramsBtn.onclick = () => { setActiveTab('params'); editBtn.style.background='#333'; paramsBtn.style.background='#ff8844'; };
        document.getElementById('new-group-btn').onclick = () => {
            let name = prompt('Group name:', `Group ${groups.size+1}`);
            if (!name) name = `Group ${groups.size+1}`;
            createGroup(name);
        };
        document.getElementById('clear-all-groups-btn').onclick = () => {
            for (let id of groups.keys()) deleteGroup(id);
            createGroup('Slash Group');
            setActiveGroup(Array.from(groups.keys())[0]);
        };
        const lengthSlider = content.querySelector('#trail-length');
        const lengthVal = content.querySelector('#trail-length-val');
        lengthSlider.oninput = (e) => { trailLength = parseInt(e.target.value); lengthVal.innerText = trailLength; this.params.trailLength = trailLength; };
        const widthSlider = content.querySelector('#trail-width');
        const widthVal = content.querySelector('#trail-width-val');
        widthSlider.oninput = (e) => { trailWidth = parseFloat(e.target.value); widthVal.innerText = trailWidth.toFixed(2); for (let t of trails.values()) { t.width = trailWidth; rebuildRibbonForGroup(t.groupId); } this.params.trailWidth = trailWidth; };
        const fadeStartSlider = content.querySelector('#fade-start');
        const fadeStartVal = content.querySelector('#fade-start-val');
        fadeStartSlider.oninput = (e) => { fadeStart = parseFloat(e.target.value); fadeStartVal.innerText = fadeStart.toFixed(2); for (let t of trails.values()) rebuildRibbonForGroup(t.groupId); this.params.fadeStart = fadeStart; };
        const fadeEndSlider = content.querySelector('#fade-end');
        const fadeEndVal = content.querySelector('#fade-end-val');
        fadeEndSlider.oninput = (e) => { fadeEnd = parseFloat(e.target.value); if (fadeEnd <= fadeStart) fadeEnd = Math.min(1, fadeStart+0.05); fadeEndSlider.value = fadeEnd; fadeEndVal.innerText = fadeEnd.toFixed(2); for (let t of trails.values()) rebuildRibbonForGroup(t.groupId); this.params.fadeEnd = fadeEnd; };
        const colorPicker = content.querySelector('#trail-color');
        colorPicker.oninput = (e) => { trailColorHex = e.target.value; for (let t of trails.values()) { t.colorHex = trailColorHex; if (t.material) t.material.uniforms.uColor.value.set(trailColorHex); } this.params.color = trailColorHex; };
        const intensitySlider = content.querySelector('#glow-intensity');
        const intensityVal = content.querySelector('#glow-intensity-val');
        intensitySlider.oninput = (e) => { glowIntensity = parseFloat(e.target.value); intensityVal.innerText = glowIntensity.toFixed(2); for (let t of trails.values()) { t.intensity = glowIntensity; if (t.material) t.material.uniforms.uIntensity.value = glowIntensity; } this.params.intensity = glowIntensity; };
        const twistSlider = content.querySelector('#twist');
        const twistVal = content.querySelector('#twist-val');
        twistSlider.oninput = (e) => { twistAngle = parseFloat(e.target.value); twistVal.innerText = twistAngle.toFixed(2); for (let t of trails.values()) rebuildRibbonForGroup(t.groupId); this.params.twist = twistAngle; };
        const sampleSlider = content.querySelector('#sample-rate');
        const sampleVal = content.querySelector('#sample-rate-val');
        sampleSlider.oninput = (e) => { sampleRate = parseInt(e.target.value); sampleVal.innerText = sampleRate; this.params.sampleRate = sampleRate; };
        setActiveTab('edit');
        updateGroupUI();
        panel.style.display = 'block';
    },
    onDeselect() {
        const panel = document.getElementById('param-panel');
        if (panel) panel.style.display = 'none';
    },
    getState() {
        return { trailLength, trailWidth, fadeStart, fadeEnd, color: trailColorHex, intensity: glowIntensity, twist: twistAngle, sampleRate };
    },
    restoreState(state) {
        if (state.trailLength) trailLength = state.trailLength;
        if (state.trailWidth) trailWidth = state.trailWidth;
        if (state.fadeStart) fadeStart = state.fadeStart;
        if (state.fadeEnd) fadeEnd = state.fadeEnd;
        if (state.color) trailColorHex = state.color;
        if (state.intensity) glowIntensity = state.intensity;
        if (state.twist) twistAngle = state.twist;
        if (state.sampleRate) sampleRate = state.sampleRate;
        for (let t of trails.values()) { t.width = trailWidth; t.colorHex = trailColorHex; t.intensity = glowIntensity; rebuildRibbonForGroup(t.groupId); }
    },
    dispose() {
        if (this._cleanup) this._cleanup();
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        for (let [id, group] of groups.entries()) deleteGroup(id);
        for (let [mesh, data] of vertexPointClouds.entries()) {
            apiRef.scene.remove(data.pointsMesh);
            data.pointsMesh.geometry.dispose();
        }
        vertexPointClouds.clear();
    }
};