// ============================================================
// KeyPose Extension: Vertex Mesh Trail (FULLY FIXED)
// - Correct skinned mesh vertex world positions (boneInverses)
// - Auto-creates point clouds for ALL meshes in scene
// - White vertex dots + orange selected marker
// - Trail ribbon follows selected vertex
// ============================================================

let trails = new Map();
let animationFrameId = null;
let frameCounter = 0;

let trailLength = 30;
let trailWidth = 0.15;
let fadeStart = 0.2;
let fadeEnd = 0.85;
let trailColorHex = '#ff3366';
let glowIntensity = 1.3;
let twistAngle = 0.0;
let sampleRate = 1;

let apiRef = null;
let activeTab = 'edit';

let vertexPointClouds = new Map();    // mesh -> { pointsMesh, pointCount }
let selectedMarkers = new Map();      // key -> marker sphere

// ========== CORRECT VERTEX WORLD POSITION (SKINNED MESH FIX) ==========
function getVertexWorldPosition(mesh, vertexIndex) {
    const THREE = apiRef.THREE;
    const geom = mesh.geometry;
    if (!geom) return null;
    const posAttr = geom.attributes.position;
    if (!posAttr) return null;
    
    const localPos = new THREE.Vector3(
        posAttr.getX(vertexIndex),
        posAttr.getY(vertexIndex),
        posAttr.getZ(vertexIndex)
    );
    
    // Force matrix updates
    mesh.updateWorldMatrix(true, true);
    
    if (mesh.isSkinnedMesh && mesh.skeleton) {
        mesh.skeleton.update();
        const skinIndexAttr = geom.attributes.skinIndex;
        const skinWeightAttr = geom.attributes.skinWeight;
        
        if (skinIndexAttr && skinWeightAttr) {
            const skeleton = mesh.skeleton;
            const boneInverses = skeleton.boneInverses;
            const bones = skeleton.bones;
            
            const idx = [
                skinIndexAttr.getX(vertexIndex),
                skinIndexAttr.getY(vertexIndex),
                skinIndexAttr.getZ(vertexIndex),
                skinIndexAttr.getW(vertexIndex)
            ];
            const wgt = [
                skinWeightAttr.getX(vertexIndex),
                skinWeightAttr.getY(vertexIndex),
                skinWeightAttr.getZ(vertexIndex),
                skinWeightAttr.getW(vertexIndex)
            ];
            
            const finalPos = new THREE.Vector3(0, 0, 0);
            for (let i = 0; i < 4; i++) {
                const boneIdx = idx[i];
                if (boneIdx === undefined || boneIdx < 0) continue;
                const weight = wgt[i];
                if (weight <= 0) continue;
                
                const bone = bones[boneIdx];
                const inverseBind = boneInverses[boneIdx];
                if (!bone || !inverseBind) continue;
                
                // Transform local position to bone's bind-relative space, then to world
                const bindSpacePos = localPos.clone().applyMatrix4(inverseBind);
                const worldPos = bindSpacePos.applyMatrix4(bone.matrixWorld);
                finalPos.add(worldPos.multiplyScalar(weight));
            }
            return finalPos;
        }
    }
    
    // Non-skinned: just apply mesh's world matrix
    return localPos.clone().applyMatrix4(mesh.matrixWorld);
}

// ========== RIBBON TRAIL FUNCTIONS (UNCHANGED, WORKS) ==========
function rebuildRibbon(trail) {
    const THREE = apiRef.THREE;
    const points = trail.historyPositions;
    if (points.length < 2) {
        if (trail.ribbonMesh && trail.ribbonMesh.parent) trail.ribbonMesh.parent.remove(trail.ribbonMesh);
        return;
    }
    const numPoints = points.length;
    const vertices = [];
    const indices = [];
    const alphas = [];
    for (let i = 0; i < numPoints; i++) {
        const t = (numPoints - 1 - i) / (numPoints - 1);
        let dir = new THREE.Vector3(0, 0, 1);
        if (i < numPoints - 1) {
            dir = new THREE.Vector3().subVectors(points[i+1], points[i]).normalize();
        } else if (i > 0) {
            dir = new THREE.Vector3().subVectors(points[i], points[i-1]).normalize();
        }
        const up = new THREE.Vector3(0, 1, 0);
        let right = new THREE.Vector3().crossVectors(dir, up).normalize();
        if (Math.abs(right.length()) < 0.01) right = new THREE.Vector3(1, 0, 0);
        const twistRad = twistAngle * (1 - t) * Math.PI;
        if (Math.abs(twistRad) > 0.001) {
            const twistQuat = new THREE.Quaternion().setFromAxisAngle(dir, twistRad);
            right.applyQuaternion(twistQuat);
        }
        const leftOffset = right.clone().multiplyScalar(-trailWidth * 0.5);
        const rightOffset = right.clone().multiplyScalar(trailWidth * 0.5);
        const leftPos = points[i].clone().add(leftOffset);
        const rightPos = points[i].clone().add(rightOffset);
        let alpha = 1.0;
        if (t <= fadeStart) alpha = 1.0;
        else if (t >= fadeEnd) alpha = 0.0;
        else alpha = 1.0 - ((t - fadeStart) / (fadeEnd - fadeStart));
        alpha = Math.min(1.0, Math.max(0.0, alpha)) * 0.95;
        vertices.push(leftPos.x, leftPos.y, leftPos.z);
        vertices.push(rightPos.x, rightPos.y, rightPos.z);
        alphas.push(alpha, alpha);
    }
    const segments = numPoints - 1;
    for (let i = 0; i < segments; i++) {
        const baseIdx = i * 2;
        indices.push(baseIdx, baseIdx+1, baseIdx+2);
        indices.push(baseIdx+1, baseIdx+3, baseIdx+2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(alphas), 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
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
            float finalAlpha = vAlpha;
            vec3 finalColor = uColor * uIntensity;
            gl_FragColor = vec4(finalColor, finalAlpha);
        }
    `;
    if (trail.ribbonMaterial) trail.ribbonMaterial.dispose();
    trail.ribbonMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(trailColorHex) },
            uIntensity: { value: glowIntensity }
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    if (trail.ribbonMesh) trail.ribbonMesh.parent?.remove(trail.ribbonMesh);
    trail.ribbonMesh = new THREE.Mesh(geometry, trail.ribbonMaterial);
    apiRef.scene.add(trail.ribbonMesh);
}

function addTrailSample(trail) {
    const pos = getVertexWorldPosition(trail.mesh, trail.vertexIndex);
    if (!pos) return;
    trail.historyPositions.push(pos.clone());
    const maxPoints = trailLength + 1;
    while (trail.historyPositions.length > maxPoints) trail.historyPositions.shift();
    rebuildRibbon(trail);
}

// ========== VERTEX POINT CLOUD (AUTO-CREATE FOR ALL MESHES) ==========
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
        color: 0xffffff, 
        size: 0.065,       // increased for visibility
        transparent: true, 
        opacity: 0.85,
        depthTest: false
    });
    const pointsMesh = new THREE.Points(pointsGeom, pointsMat);
    pointsMesh.userData = { parentMesh: mesh };
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

function addMarkerSphere(mesh, vertexIndex) {
    const THREE = apiRef.THREE;
    const pos = getVertexWorldPosition(mesh, vertexIndex);
    if (!pos) return null;
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xff8844, emissive: 0xff4400, emissiveIntensity: 0.8 })
    );
    sphere.position.copy(pos);
    apiRef.scene.add(sphere);
    return sphere;
}

// Auto-create point clouds for any mesh that doesn't have one yet
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
    
    // Remove point clouds for meshes no longer in scene
    for (let [mesh, data] of vertexPointClouds.entries()) {
        if (!currentMeshes.has(mesh) || !mesh.parent) {
            apiRef.scene.remove(data.pointsMesh);
            data.pointsMesh.geometry.dispose();
            vertexPointClouds.delete(mesh);
        }
    }
}

function updateAllVisuals() {
    // Ensure we have point clouds for all current meshes
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
    
    // Update marker spheres
    for (let [key, marker] of selectedMarkers.entries()) {
        const trail = trails.get(key);
        if (trail && trail.mesh && trail.mesh.parent) {
            trail.mesh.updateWorldMatrix(true, true);
            if (trail.mesh.isSkinnedMesh && trail.mesh.skeleton) trail.mesh.skeleton.update();
            const newPos = getVertexWorldPosition(trail.mesh, trail.vertexIndex);
            if (newPos) marker.position.copy(newPos);
        }
    }
}

function updateAll() {
    frameCounter++;
    if (frameCounter % sampleRate === 0) {
        for (let trail of trails.values()) {
            addTrailSample(trail);
        }
    }
    updateAllVisuals();
}

function startAnimationLoop() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    function loop() {
        updateAll();
        animationFrameId = requestAnimationFrame(loop);
    }
    loop();
}

// ========== VERTEX SELECTION ==========
function getNearestVertex(mesh, point) {
    const THREE = apiRef.THREE;
    const geom = mesh.geometry;
    if (!geom || !geom.attributes.position) return null;
    mesh.updateWorldMatrix(true, true);
    const localPoint = mesh.worldToLocal(point.clone());
    const positions = geom.attributes.position.array;
    let minDist = Infinity;
    let nearestIndex = -1;
    for (let i = 0; i < positions.length / 3; i++) {
        const v = new THREE.Vector3(positions[i*3], positions[i*3+1], positions[i*3+2]);
        const dist = v.distanceTo(localPoint);
        if (dist < minDist) {
            minDist = dist;
            nearestIndex = i;
        }
    }
    return nearestIndex !== -1 ? nearestIndex : null;
}

function removeTrail(key) {
    const trail = trails.get(key);
    if (trail) {
        if (trail.ribbonMesh) apiRef.scene.remove(trail.ribbonMesh);
        if (trail.ribbonMaterial) trail.ribbonMaterial.dispose();
        trails.delete(key);
    }
    const marker = selectedMarkers.get(key);
    if (marker) apiRef.scene.remove(marker);
    selectedMarkers.delete(key);
}

function clearAllTrails() {
    for (let key of trails.keys()) removeTrail(key);
    for (let [mesh, data] of vertexPointClouds.entries()) {
        apiRef.scene.remove(data.pointsMesh);
        data.pointsMesh.geometry.dispose();
    }
    vertexPointClouds.clear();
}

function setActiveTab(tab) {
    activeTab = tab;
    for (let [mesh, data] of vertexPointClouds.entries()) {
        data.pointsMesh.visible = (tab === 'edit');
    }
    for (let marker of selectedMarkers.values()) {
        marker.visible = (tab === 'edit');
    }
    const editPanel = document.getElementById('trail-edit-panel');
    const paramsPanel = document.getElementById('trail-params-panel');
    if (editPanel && paramsPanel) {
        editPanel.style.display = (tab === 'edit') ? 'block' : 'none';
        paramsPanel.style.display = (tab === 'params') ? 'block' : 'none';
    }
}

// ---------- EXTENSION EXPORT ----------
export default {
    id: 'vertex-mesh-trail',
    name: '🗡️ Vertex Mesh Trail (Sword Slash)',
    type: 'per-model',
    params: {
        trailLength: 30,
        trailWidth: 0.15,
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

        // Create point clouds for any existing models immediately
        ensurePointCloudsForAllMeshes();
        
        const canvas = api.renderer.domElement;
        const onVertexSelect = (e) => {
            if (!e.shiftKey) return;
            if (activeTab !== 'edit') return;
            e.stopPropagation();
            const rect = canvas.getBoundingClientRect();
            const mouse = new THREE.Vector2();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            const raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, api.camera);
            const meshes = [];
            const models = api.getLoadedModels ? api.getLoadedModels() : [];
            for (let model of models) {
                if (model.userData.inScene) {
                    model.traverse(child => { if (child.isMesh) meshes.push(child); });
                }
            }
            const hits = raycaster.intersectObjects(meshes);
            if (hits.length) {
                const hit = hits[0];
                const mesh = hit.object;
                const vertexIdx = getNearestVertex(mesh, hit.point);
                if (vertexIdx !== null) {
                    const key = `${mesh.uuid}:${vertexIdx}`;
                    if (!trails.has(key)) {
                        // Ensure point cloud exists for this mesh
                        if (!vertexPointClouds.has(mesh)) {
                            const viz = createVertexPointCloud(mesh);
                            if (viz) vertexPointClouds.set(mesh, viz);
                        }
                        const marker = addMarkerSphere(mesh, vertexIdx);
                        selectedMarkers.set(key, marker);
                        const trail = {
                            key,
                            mesh,
                            vertexIndex: vertexIdx,
                            historyPositions: [],
                            ribbonMesh: null,
                            ribbonMaterial: null
                        };
                        const startPos = getVertexWorldPosition(mesh, vertexIdx);
                        if (startPos) trail.historyPositions.push(startPos.clone());
                        trails.set(key, trail);
                        const statusDiv = document.getElementById('status');
                        if (statusDiv) statusDiv.innerHTML = `✅ Trail added for vertex ${vertexIdx}`;
                    } else {
                        const statusDiv = document.getElementById('status');
                        if (statusDiv) statusDiv.innerHTML = `⚠️ Trail already exists for this vertex`;
                    }
                }
            }
        };
        canvas.addEventListener('click', onVertexSelect);
        this._cleanupSelection = () => canvas.removeEventListener('click', onVertexSelect);
        
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
                    <small>💡 <strong>Shift+Click</strong> on a mesh to select the nearest vertex.<br>
                    All vertices are shown as <span style="color:#aaa;">small white dots</span>.<br>
                    Selected vertices get an <span style="color:#ff8844;">orange sphere</span>.</small>
                </div>
                <button id="clear-all-btn" style="background:#aa4444; width:100%;">🗑️ Remove All Trails</button>
            </div>
            <div id="trail-params-panel" style="display:none;">
                <div class="param-row">
                    <label>📏 Trail Length (frames)</label>
                    <input type="range" id="trail-length" min="5" max="80" step="1" value="${trailLength}">
                    <span id="trail-length-val">${trailLength}</span>
                </div>
                <div class="param-row">
                    <label>📐 Trail Width</label>
                    <input type="range" id="trail-width" min="0.05" max="0.6" step="0.01" value="${trailWidth}">
                    <span id="trail-width-val">${trailWidth}</span>
                </div>
                <div class="param-row">
                    <label>🌀 Fade Start</label>
                    <input type="range" id="fade-start" min="0" max="0.9" step="0.01" value="${fadeStart}">
                    <span id="fade-start-val">${fadeStart}</span>
                </div>
                <div class="param-row">
                    <label>🌀 Fade End</label>
                    <input type="range" id="fade-end" min="0.1" max="1" step="0.01" value="${fadeEnd}">
                    <span id="fade-end-val">${fadeEnd}</span>
                </div>
                <div class="param-row">
                    <label>🎨 Trail Color</label>
                    <input type="color" id="trail-color" value="${trailColorHex}">
                </div>
                <div class="param-row">
                    <label>✨ Glow Intensity</label>
                    <input type="range" id="glow-intensity" min="0.2" max="2.5" step="0.01" value="${glowIntensity}">
                    <span id="glow-intensity-val">${glowIntensity}</span>
                </div>
                <div class="param-row">
                    <label>🔁 Twist / Roll</label>
                    <input type="range" id="twist" min="-0.8" max="0.8" step="0.01" value="${twistAngle}">
                    <span id="twist-val">${twistAngle}</span>
                </div>
                <div class="param-row">
                    <label>⏱️ Sample Rate (frames)</label>
                    <input type="range" id="sample-rate" min="1" max="5" step="1" value="${sampleRate}">
                    <span id="sample-rate-val">${sampleRate}</span>
                </div>
            </div>
        `;
        const editBtn = content.querySelector('#tab-edit-btn');
        const paramsBtn = content.querySelector('#tab-params-btn');
        editBtn.onclick = () => {
            setActiveTab('edit');
            editBtn.style.background = '#ff8844';
            paramsBtn.style.background = '#333';
        };
        paramsBtn.onclick = () => {
            setActiveTab('params');
            editBtn.style.background = '#333';
            paramsBtn.style.background = '#ff8844';
        };
        const clearBtn = content.querySelector('#clear-all-btn');
        clearBtn.onclick = () => clearAllTrails();
        
        // Parameter controls
        const lengthSlider = content.querySelector('#trail-length');
        const lengthVal = content.querySelector('#trail-length-val');
        lengthSlider.oninput = (e) => {
            trailLength = parseInt(e.target.value);
            lengthVal.innerText = trailLength;
            for (let trail of trails.values()) {
                while (trail.historyPositions.length > trailLength + 1) trail.historyPositions.shift();
                rebuildRibbon(trail);
            }
            this.params.trailLength = trailLength;
        };
        const widthSlider = content.querySelector('#trail-width');
        const widthVal = content.querySelector('#trail-width-val');
        widthSlider.oninput = (e) => {
            trailWidth = parseFloat(e.target.value);
            widthVal.innerText = trailWidth.toFixed(2);
            for (let trail of trails.values()) rebuildRibbon(trail);
            this.params.trailWidth = trailWidth;
        };
        const fadeStartSlider = content.querySelector('#fade-start');
        const fadeStartVal = content.querySelector('#fade-start-val');
        fadeStartSlider.oninput = (e) => {
            fadeStart = parseFloat(e.target.value);
            fadeStartVal.innerText = fadeStart.toFixed(2);
            for (let trail of trails.values()) rebuildRibbon(trail);
            this.params.fadeStart = fadeStart;
        };
        const fadeEndSlider = content.querySelector('#fade-end');
        const fadeEndVal = content.querySelector('#fade-end-val');
        fadeEndSlider.oninput = (e) => {
            fadeEnd = parseFloat(e.target.value);
            if (fadeEnd <= fadeStart) fadeEnd = Math.min(1, fadeStart + 0.05);
            fadeEndSlider.value = fadeEnd;
            fadeEndVal.innerText = fadeEnd.toFixed(2);
            for (let trail of trails.values()) rebuildRibbon(trail);
            this.params.fadeEnd = fadeEnd;
        };
        const colorPicker = content.querySelector('#trail-color');
        colorPicker.oninput = (e) => {
            trailColorHex = e.target.value;
            for (let trail of trails.values()) {
                if (trail.ribbonMaterial) trail.ribbonMaterial.uniforms.uColor.value.set(trailColorHex);
            }
            this.params.color = trailColorHex;
        };
        const intensitySlider = content.querySelector('#glow-intensity');
        const intensityVal = content.querySelector('#glow-intensity-val');
        intensitySlider.oninput = (e) => {
            glowIntensity = parseFloat(e.target.value);
            intensityVal.innerText = glowIntensity.toFixed(2);
            for (let trail of trails.values()) {
                if (trail.ribbonMaterial) trail.ribbonMaterial.uniforms.uIntensity.value = glowIntensity;
            }
            this.params.intensity = glowIntensity;
        };
        const twistSlider = content.querySelector('#twist');
        const twistVal = content.querySelector('#twist-val');
        twistSlider.oninput = (e) => {
            twistAngle = parseFloat(e.target.value);
            twistVal.innerText = twistAngle.toFixed(2);
            for (let trail of trails.values()) rebuildRibbon(trail);
            this.params.twist = twistAngle;
        };
        const sampleSlider = content.querySelector('#sample-rate');
        const sampleVal = content.querySelector('#sample-rate-val');
        sampleSlider.oninput = (e) => {
            sampleRate = parseInt(e.target.value);
            sampleVal.innerText = sampleRate;
            this.params.sampleRate = sampleRate;
        };
        setActiveTab('edit');
        panel.style.display = 'block';
    },

    onDeselect() {
        const panel = document.getElementById('param-panel');
        if (panel) panel.style.display = 'none';
    },

    getState() {
        return {
            trailLength,
            trailWidth,
            fadeStart,
            fadeEnd,
            color: trailColorHex,
            intensity: glowIntensity,
            twist: twistAngle,
            sampleRate
        };
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
        for (let trail of trails.values()) rebuildRibbon(trail);
    },

    dispose() {
        if (this._cleanupSelection) this._cleanupSelection();
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        clearAllTrails();
    }
};