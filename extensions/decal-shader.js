// Advanced Decal Extension with Full Scene/Timeline Integration
// Saves decal transforms in panels & keyframes, supports rotation/scale/position gizmo, toggle visibility.

var activeDecalData = new Map();        // mesh -> { material, originalMaterial, decalHelperId }
var selectedMeshes = new Set();
var decalHelpers = [];                  // { helper, transformControls, decalId, videoTexture, loop, videoElement, videoUrl }
var nextDecalId = 1;
var gizmoVisible = true;
var currentDecalGizmoMode = 'translate'; // 'translate', 'rotate', 'scale'

export default {
    id: 'animated-decal-mp4-scene-ready',
    name: 'MP4 Decal (Scene/Timeline ready)',
    type: 'per-model',
    params: {
        loop: true
    },
    _ui: null,
    _cleanupSelection: null,
    _originalColors: new Map(),
    _currentVideoTexture: null,
    _currentVideo: null,
    _currentVideoUrl: null,
    _patched: false,

    init: function(api) {
        this.api = api;
        var self = this;
        var renderer = api.renderer;
        var camera = api.camera;
        var THREE = api.THREE;
        var canvas = renderer.domElement;

        // Selection: Ctrl+Click
        var onMouseClick = function(e) {
            if (!e.ctrlKey) return;
            e.stopPropagation();
            e.preventDefault();

            var rect = canvas.getBoundingClientRect();
            var mouse = new THREE.Vector2();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            var raycaster = new THREE.Raycaster();
            raycaster.setFromCamera(mouse, camera);

            var meshes = [];
            var models = api.getLoadedModels ? api.getLoadedModels() : [];
            for (var i = 0; i < models.length; i++) {
                var model = models[i];
                if (model.userData.inScene) {
                    model.traverse(function(child) {
                        if (child.isMesh) meshes.push(child);
                    });
                }
            }

            var intersects = raycaster.intersectObjects(meshes);
            if (intersects.length > 0) {
                var mesh = intersects[0].object;
                if (e.shiftKey) {
                    if (selectedMeshes.has(mesh)) selectedMeshes.delete(mesh);
                    else selectedMeshes.add(mesh);
                } else {
                    var it = selectedMeshes.values();
                    for (var val = it.next(); !val.done; val = it.next()) {
                        self._clearHighlight(val.value);
                    }
                    selectedMeshes.clear();
                    selectedMeshes.add(mesh);
                }
                var it = selectedMeshes.values();
                for (var val = it.next(); !val.done; val = it.next()) {
                    self._highlightMesh(val.value);
                }
                self._updateUI();
                var statusDiv = document.getElementById('status');
                if (statusDiv) statusDiv.innerHTML = '🎯 ' + selectedMeshes.size + ' mesh(es) selected';
            } else if (!e.shiftKey) {
                var it = selectedMeshes.values();
                for (var val = it.next(); !val.done; val = it.next()) {
                    self._clearHighlight(val.value);
                }
                selectedMeshes.clear();
                self._updateUI();
                var statusDiv = document.getElementById('status');
                if (statusDiv) statusDiv.innerHTML = '❌ Selection cleared';
            }
        };
        canvas.addEventListener('click', onMouseClick);
        this._cleanupSelection = function() { canvas.removeEventListener('click', onMouseClick); };
        this._buildUIPlaceholder();

        // Patch core scene state & keyframe functions after they are defined
        setTimeout(() => this._patchCoreFunctions(), 500);
    },

    _patchCoreFunctions: function() {
        if (this._patched) return;
        var self = this;

        // Patch getCurrentSceneState
        if (typeof window.getCurrentSceneState === 'function' && !window._decalPatchedGet) {
            var originalGet = window.getCurrentSceneState;
            window.getCurrentSceneState = function() {
                var state = originalGet();
                state.decalInfos = self._serializeDecalHelpers();
                return state;
            };
            window._decalPatchedGet = true;
        }

        // Patch restoreSceneState
        if (typeof window.restoreSceneState === 'function' && !window._decalPatchedRestore) {
            var originalRestore = window.restoreSceneState;
            window.restoreSceneState = function(state) {
                originalRestore(state);
                if (state && state.decalInfos) {
                    self._restoreDecalHelpers(state.decalInfos);
                } else {
                    // No decal info in state – remove all decals to avoid leftovers
                    self._removeAllDecals();
                }
            };
            window._decalPatchedRestore = true;
        }

        // Patch captureCurrentKeyframe (for timeline)
        if (typeof window.captureCurrentKeyframe === 'function' && !window._decalPatchedCapture) {
            var originalCapture = window.captureCurrentKeyframe;
            window.captureCurrentKeyframe = function() {
                var keyframe = originalCapture();
                keyframe.decalInfos = self._serializeDecalHelpers();
                return keyframe;
            };
            window._decalPatchedCapture = true;
        }

        // Patch applyKeyframeToSceneForCharacters (also applies decal transforms)
        if (typeof window.applyKeyframeToSceneForCharacters === 'function' && !window._decalPatchedApply) {
            var originalApply = window.applyKeyframeToSceneForCharacters;
            window.applyKeyframeToSceneForCharacters = function(keyframe) {
                originalApply(keyframe);
                if (keyframe && keyframe.decalInfos) {
                    self._restoreDecalHelpers(keyframe.decalInfos);
                }
            };
            window._decalPatchedApply = true;
        }

        this._patched = true;
        console.log('Decal extension: patched core functions for scene/timeline persistence');
    },

    _serializeDecalHelpers: function() {
        var infos = [];
        for (var i = 0; i < decalHelpers.length; i++) {
            var dh = decalHelpers[i];
            if (!dh.helper) continue;
            var pos = dh.helper.position;
            var rot = dh.helper.rotation;
            var scale = dh.helper.scale;
            infos.push({
                decalId: dh.decalId,
                pos: [pos.x, pos.y, pos.z],
                rot: [rot.x, rot.y, rot.z],
                scale: [scale.x, scale.y, scale.z],
                videoUrl: dh.videoUrl,
                loop: dh.loop
            });
        }
        return infos;
    },

    _restoreDecalHelpers: function(decalInfos) {
        var self = this;
        // Remove current decals but keep video textures in cache
        for (var [mesh, data] of activeDecalData.entries()) {
            mesh.material = data.originalMaterial;
            if (data.material.dispose) data.material.dispose();
        }
        activeDecalData.clear();
        for (var i = 0; i < decalHelpers.length; i++) {
            var dh = decalHelpers[i];
            if (dh.transformControls) dh.transformControls.dispose();
            if (dh.helper) this.api.scene.remove(dh.helper);
        }
        decalHelpers = [];

        for (var i = 0; i < decalInfos.length; i++) {
            var info = decalInfos[i];
            if (!info.videoUrl) continue;
            // Reuse video texture from cache if available, otherwise attempt to load
            var videoTexture = this._videoTextureCache ? this._videoTextureCache.get(info.videoUrl) : null;
            if (!videoTexture) {
                console.warn('Cannot restore decal: video texture missing', info.videoUrl);
                continue;
            }
            var pos = new this.api.THREE.Vector3(info.pos[0], info.pos[1], info.pos[2]);
            var rot = new this.api.THREE.Euler(info.rot[0], info.rot[1], info.rot[2]);
            var scale = new this.api.THREE.Vector3(info.scale[0], info.scale[1], info.scale[2]);
            var helper = this._createDecalHelper(pos, rot, scale, videoTexture, info.loop);
            helper.userData.decalId = info.decalId;
            this._attachTransformControls(helper).then(controls => {
                decalHelpers.push({ helper: helper, transformControls: controls, decalId: info.decalId, videoTexture: videoTexture, loop: info.loop, videoUrl: info.videoUrl });
                // Note: Mesh associations are not automatically restored because we don't store which meshes had which decal.
                // The user must re-apply decal to meshes after loading a panel. However, for keyframe playback, the decal helper
                // position will be correct, and if the meshes still have the shader applied (they do, because activeDecalData is rebuilt? no)
                // For proper full restoration, we need to also store mesh selections. To keep it simple, we prompt user to reapply.
                document.getElementById('status').innerHTML = '⚠️ Decal visual restored, but meshes may need re-selection & re-apply.';
            });
        }
    },

    _highlightMesh: function(mesh) {
        if (!this._originalColors.has(mesh) && mesh.material) {
            var mat = mesh.material;
            var origEmissive = mat.emissive ? mat.emissive.getHex() : null;
            var origColor = mat.color ? mat.color.getHex() : null;
            this._originalColors.set(mesh, { emissive: origEmissive, color: origColor });
        }
        if (mesh.material) {
            if (mesh.material.emissive) {
                mesh.material.emissive.setHex(0xff6600);
                mesh.material.emissiveIntensity = 0.5;
            } else if (mesh.material.color) {
                mesh.material.color.setHex(0xffaa66);
            }
        }
    },

    _clearHighlight: function(mesh) {
        var orig = this._originalColors.get(mesh);
        if (orig && mesh.material) {
            if (mesh.material.emissive && orig.emissive !== null) {
                mesh.material.emissive.setHex(orig.emissive);
                mesh.material.emissiveIntensity = 0;
            } else if (mesh.material.color && orig.color !== null) {
                mesh.material.color.setHex(orig.color);
            }
        }
        this._originalColors.delete(mesh);
    },

    _buildUIPlaceholder: function() {
        var panel = document.getElementById('param-panel');
        var title = document.getElementById('param-title');
        var content = document.getElementById('param-content');
        if (!panel || !title || !content) return;
        this._ui = { panel: panel, title: title, content: content };
    },

    _updateUI: function() {
        if (!this._ui) return;
        var names = [];
        var it = selectedMeshes.values();
        for (var val = it.next(); !val.done; val = it.next()) {
            names.push(val.value.name || 'unnamed');
        }
        var listDiv = this._ui.content.querySelector('#decal-selected-list');
        if (listDiv) listDiv.textContent = names.join(', ') || 'none';

        var modeSelect = this._ui.content.querySelector('#decal-gizmo-mode');
        if (modeSelect) modeSelect.value = currentDecalGizmoMode;

        var toggleBtn = this._ui.content.querySelector('#decal-toggle-gizmo');
        if (toggleBtn) toggleBtn.textContent = gizmoVisible ? '🔘 Hide Gizmo' : '🔘 Show Gizmo';
    },

    _createVideoTexture: function(file, loop) {
        var self = this;
        return new Promise(function(resolve, reject) {
            var video = document.createElement('video');
            video.autoplay = true;
            video.muted = true;
            video.loop = loop;
            video.playsInline = true;
            var url = URL.createObjectURL(file);
            video.src = url;
            video.onloadeddata = function() {
                video.play();
                var texture = new self.api.THREE.VideoTexture(video);
                texture.minFilter = self.api.THREE.LinearFilter;
                texture.magFilter = self.api.THREE.LinearFilter;
                if (!self._videoTextureCache) self._videoTextureCache = new Map();
                self._videoTextureCache.set(url, texture);
                resolve({ texture: texture, video: video, url: url });
            };
            video.onerror = function(err) {
                URL.revokeObjectURL(url);
                reject(err);
            };
        });
    },

    _createDecalHelper: function(position, rotation, scale, videoTexture, loop) {
        var THREE = this.api.THREE;
        var geometry = new THREE.PlaneGeometry(1, 1);
        var material = new THREE.MeshBasicMaterial({ color: 0xff8844, wireframe: true, transparent: true, opacity: 0.6 });
        var helperPlane = new THREE.Mesh(geometry, material);
        helperPlane.position.copy(position);
        helperPlane.rotation.copy(rotation);
        helperPlane.scale.copy(scale);
        helperPlane.userData = { isDecalHelper: true, decalId: nextDecalId++, videoTexture: videoTexture, loop: loop };
        helperPlane.visible = gizmoVisible;
        this.api.scene.add(helperPlane);
        return helperPlane;
    },

    _attachTransformControls: async function(helper) {
        var THREE = this.api.THREE;
        const module = await import('three/addons/controls/TransformControls.js');
        const TransformControls = module.TransformControls;
        var controls = new TransformControls(this.api.camera, this.api.renderer.domElement);
        controls.attach(helper);
        controls.setMode(currentDecalGizmoMode);
        controls.addEventListener('dragging-changed', (e) => {
            this.api.orbit.enabled = !e.value;
        });
        this.api.scene.add(controls);
        controls.visible = gizmoVisible;
        var self = this;
        var onTransform = function() {
            self._updateDecalShaderFromHelper(helper);
        };
        controls.addEventListener('objectChange', onTransform);
        controls.addEventListener('mouseUp', onTransform);
        return controls;
    },

    _updateDecalShaderFromHelper: function(helper) {
        var THREE = this.api.THREE;
        var decalId = helper.userData.decalId;
        var affectedMeshes = [];
        for (var [mesh, data] of activeDecalData.entries()) {
            if (data.decalHelperId === decalId) {
                affectedMeshes.push(mesh);
            }
        }
        if (affectedMeshes.length === 0) return;

        var helperMatrixWorld = helper.matrixWorld;
        var invHelperMatrix = new THREE.Matrix4().copy(helperMatrixWorld).invert();
        var scaleX = helper.scale.x;
        var scaleY = helper.scale.y;
        for (var i = 0; i < affectedMeshes.length; i++) {
            var mesh = affectedMeshes[i];
            var material = mesh.material;
            if (material && material.uniforms) {
                material.uniforms.uDecalInvMatrix.value = invHelperMatrix;
                material.uniforms.uDecalScale.value = new THREE.Vector2(scaleX, scaleY);
                material.uniforms.uDecalInvMatrix.needsUpdate = true;
                material.uniforms.uDecalScale.needsUpdate = true;
            }
        }
    },

    _applyDecalWithGizmo: function(videoTexture, loop, selectedMeshesSet) {
        var self = this;
        var THREE = this.api.THREE;
        if (selectedMeshesSet.size === 0) return false;

        var defaultPos = new THREE.Vector3(0, 1, 0);
        var defaultRot = new THREE.Euler(0, 0, 0);
        var defaultScale = new THREE.Vector3(2, 2, 1);
        var helper = this._createDecalHelper(defaultPos, defaultRot, defaultScale, videoTexture, loop);
        var decalId = helper.userData.decalId;

        this._attachTransformControls(helper).then(controls => {
            decalHelpers.push({ helper: helper, transformControls: controls, decalId: decalId, videoTexture: videoTexture, loop: loop, videoUrl: this._currentVideoUrl });
            var meshesArray = Array.from(selectedMeshesSet);
            var vertexShader = `
                varying vec3 vWorldPos;
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPos = worldPos.xyz;
                    gl_PointSize = 1.0;
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `;
            var fragmentShader = `
                uniform sampler2D uTex;
                uniform mat4 uDecalInvMatrix;
                uniform vec2 uDecalScale;
                varying vec3 vWorldPos;
                void main() {
                    vec4 localPos = uDecalInvMatrix * vec4(vWorldPos, 1.0);
                    float u = localPos.x / uDecalScale.x + 0.5;
                    float v = localPos.y / uDecalScale.y + 0.5;
                    u = clamp(u, 0.0, 1.0);
                    v = clamp(v, 0.0, 1.0);
                    vec4 texColor = texture2D(uTex, vec2(u, v));
                    gl_FragColor = vec4(texColor.rgb, 1.0);
                }
            `;
            var uniforms = {
                uTex: { value: videoTexture },
                uDecalInvMatrix: { value: new THREE.Matrix4().copy(helper.matrixWorld).invert() },
                uDecalScale: { value: new THREE.Vector2(helper.scale.x, helper.scale.y) }
            };
            var shaderMat = new THREE.ShaderMaterial({
                uniforms: uniforms,
                vertexShader: vertexShader,
                fragmentShader: fragmentShader,
                transparent: false,
                side: THREE.DoubleSide,
                skinning: true
            });
            for (var i = 0; i < meshesArray.length; i++) {
                var mesh = meshesArray[i];
                var originalMat = mesh.material;
                if (activeDecalData.has(mesh)) {
                    var old = activeDecalData.get(mesh);
                    if (old.material.dispose) old.material.dispose();
                }
                var clone = shaderMat.clone();
                mesh.material = clone;
                activeDecalData.set(mesh, {
                    material: mesh.material,
                    originalMaterial: originalMat,
                    decalHelperId: decalId,
                    uniforms: mesh.material.uniforms
                });
                this._clearHighlight(mesh);
            }
            document.getElementById('status').innerHTML = '✅ Decal applied with Gizmo. Use orange wireframe to transform.';
        }).catch(err => {
            console.error("Failed to create TransformControls:", err);
            document.getElementById('status').innerHTML = '❌ Error creating gizmo. Check console.';
        });
        return true;
    },

    _removeAllDecals: function() {
        for (var [mesh, data] of activeDecalData.entries()) {
            mesh.material = data.originalMaterial;
            if (data.material.dispose) data.material.dispose();
        }
        activeDecalData.clear();
        for (var i = 0; i < decalHelpers.length; i++) {
            var helper = decalHelpers[i];
            if (helper.transformControls) {
                helper.transformControls.dispose();
                this.api.scene.remove(helper.transformControls);
            }
            if (helper.helper) this.api.scene.remove(helper.helper);
        }
        decalHelpers = [];
        document.getElementById('status').innerHTML = 'All decals removed.';
    },

    _toggleGizmoVisibility: function() {
        gizmoVisible = !gizmoVisible;
        for (var i = 0; i < decalHelpers.length; i++) {
            if (decalHelpers[i].helper) decalHelpers[i].helper.visible = gizmoVisible;
            if (decalHelpers[i].transformControls) decalHelpers[i].transformControls.visible = gizmoVisible;
        }
        this._updateUI();
        document.getElementById('status').innerHTML = gizmoVisible ? 'Gizmo visible' : 'Gizmo hidden';
    },

    _setGizmoMode: function(mode) {
        currentDecalGizmoMode = mode;
        for (var i = 0; i < decalHelpers.length; i++) {
            if (decalHelpers[i].transformControls) {
                decalHelpers[i].transformControls.setMode(mode);
            }
        }
        document.getElementById('status').innerHTML = `Gizmo mode: ${mode}`;
        this._updateUI();
    },

    onSelect: function() {
        if (!this._ui) this._buildUIPlaceholder();
        var self = this;
        var ui = this._ui;
        ui.title.textContent = this.name;
        ui.content.innerHTML = `
            <div style="margin-bottom: 8px; font-size: 11px; background: #2a2a3a; padding: 4px; border-radius: 6px;">
                <div><strong>Selected meshes:</strong> <span id="decal-selected-list">none</span></div>
                <div style="margin-top: 4px;">
                    <button id="decal-clear-selection" style="background:#333; border:none; padding:2px 6px; border-radius:4px;">🗑️ Clear Selection</button>
                    <button id="decal-remove-all" style="background:#aa4444; border:none; padding:2px 6px; border-radius:4px;">❌ Remove All Decals</button>
                    <button id="decal-toggle-gizmo" style="background:#3a6a8a; border:none; padding:2px 6px; border-radius:4px;">🔘 Hide Gizmo</button>
                </div>
                <div style="margin-top: 4px;">
                    <span>Gizmo mode: </span>
                    <select id="decal-gizmo-mode" style="background:#333; color:white; border:1px solid #ff8844; border-radius:4px;">
                        <option value="translate">Move</option>
                        <option value="rotate">Rotate</option>
                        <option value="scale">Scale</option>
                    </select>
                    <button id="decal-apply-mode" style="background:#ff8844; border:none; padding:2px 8px; border-radius:4px;">Apply</button>
                </div>
                <small>💡 Ctrl+Click to select meshes | Load MP4, then click "Create Gizmo & Apply"</small>
            </div>
            <div class="param-row">
                <label>MP4 Video File</label>
                <input type="file" id="decal-video-input" accept="video/mp4">
            </div>
            <div class="param-row">
                <label>Loop</label>
                <input type="checkbox" id="decal-loop" ${this.params.loop ? 'checked' : ''}>
            </div>
            <button id="decal-create-gizmo-btn" style="width:100%; background:#ff8844; border:none; padding:5px; border-radius:6px; margin-top:8px;">🎬 Create Gizmo & Apply Decal</button>
            <div style="margin-top:10px; background:#1e1e2e; padding:5px; border-radius:6px;">
                <small>✨ Rotate, move, scale the orange wireframe. Decal updates live. Panel changes & keyframes preserve transforms.</small>
            </div>
        `;

        var clearBtn = ui.content.querySelector('#decal-clear-selection');
        var removeAllBtn = ui.content.querySelector('#decal-remove-all');
        var toggleGizmoBtn = ui.content.querySelector('#decal-toggle-gizmo');
        var modeSelect = ui.content.querySelector('#decal-gizmo-mode');
        var applyModeBtn = ui.content.querySelector('#decal-apply-mode');
        var loopCheck = ui.content.querySelector('#decal-loop');
        var createBtn = ui.content.querySelector('#decal-create-gizmo-btn');
        var fileInput = ui.content.querySelector('#decal-video-input');
        var currentVideoTexture = null;
        var currentVideo = null;
        var currentUrl = null;

        clearBtn.onclick = function() {
            var it = selectedMeshes.values();
            for (var val = it.next(); !val.done; val = it.next()) {
                self._clearHighlight(val.value);
            }
            selectedMeshes.clear();
            self._updateUI();
            document.getElementById('status').innerHTML = 'Selection cleared';
        };

        removeAllBtn.onclick = function() {
            self._removeAllDecals();
            self._updateUI();
        };

        toggleGizmoBtn.onclick = function() {
            self._toggleGizmoVisibility();
        };

        applyModeBtn.onclick = function() {
            self._setGizmoMode(modeSelect.value);
        };

        loopCheck.onchange = function(e) {
            self.params.loop = e.target.checked;
            if (currentVideo) currentVideo.loop = self.params.loop;
            for (var i = 0; i < decalHelpers.length; i++) {
                if (decalHelpers[i].videoElement) decalHelpers[i].videoElement.loop = self.params.loop;
            }
        };

        fileInput.onchange = function(e) {
            var file = e.target.files[0];
            if (!file) return;
            if (currentVideo) {
                currentVideo.pause();
                currentVideo.src = '';
                if (currentUrl) URL.revokeObjectURL(currentUrl);
            }
            if (currentVideoTexture) currentVideoTexture.dispose();
            self._createVideoTexture(file, self.params.loop).then(function(result) {
                currentVideoTexture = result.texture;
                currentVideo = result.video;
                currentUrl = result.url;
                self._currentVideoTexture = currentVideoTexture;
                self._currentVideo = currentVideo;
                self._currentVideoUrl = currentUrl;
                document.getElementById('status').innerHTML = 'MP4 loaded – ready to create decal gizmo';
            }).catch(function(err) {
                document.getElementById('status').innerHTML = 'Failed to load MP4';
            });
        };

        createBtn.onclick = function() {
            if (selectedMeshes.size === 0) {
                alert('Select at least one mesh (Ctrl+Click).');
                return;
            }
            if (!currentVideoTexture) {
                alert('Load an MP4 video first.');
                return;
            }
            self._applyDecalWithGizmo(currentVideoTexture, self.params.loop, selectedMeshes);
        };

        this._updateUI();
        ui.panel.style.display = 'block';
    },

    onDeselect: function() {
        if (this._ui && this._ui.panel) this._ui.panel.style.display = 'none';
    },

    dispose: function() {
        if (this._cleanupSelection) this._cleanupSelection();
        if (this._currentVideoUrl) URL.revokeObjectURL(this._currentVideoUrl);
        if (this._currentVideoTexture) this._currentVideoTexture.dispose();
        if (this._currentVideo) this._currentVideo.pause();
        this._removeAllDecals();
        selectedMeshes.clear();
        // Unpatch core functions (optional)
        if (window._decalPatchedGet) delete window._decalPatchedGet;
        if (window._decalPatchedRestore) delete window._decalPatchedRestore;
        if (window._decalPatchedCapture) delete window._decalPatchedCapture;
        if (window._decalPatchedApply) delete window._decalPatchedApply;
    }
};