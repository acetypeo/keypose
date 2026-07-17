export default {
    id: 'outline',
    name: 'Outline (Model)',
    type: 'per-model',
    params: {
        thickness: 0.02,
        color: '#000000'
    },

    _outlineData: [],

    init(api) {
        this.api = api;
        const models = api.getLoadedModels?.() || [];
        models.forEach(m => this._applyToModel(m));
        this._buildUI();
    },

    _applyToModel(model) {
        if (!model || model.userData._outlineApplied) return;
        model.userData._outlineApplied = true;

        const group = { model, meshes: [] };

        model.traverse(child => {
            if (child.isMesh && child.geometry) {
                const isSkinned = child.isSkinnedMesh;
                const geo = child.geometry.clone();

                // Vertex shader with complete skinning (r128) + outline offset
                const vertexShader = `
                    uniform float uThickness;

                    ${isSkinned ? `
                    attribute vec4 skinIndex;
                    attribute vec4 skinWeight;
                    uniform mat4 bindMatrix;
                    uniform mat4 bindMatrixInverse;
                    uniform sampler2D boneTexture;
                    uniform int boneTextureSize;

                    mat4 getBoneMatrix( const in float i ) {
                        float size = float( boneTextureSize );
                        float j = i * 4.0;
                        float x = mod( j, size );
                        float y = floor( j / size );
                        float dx = 1.0 / size;
                        float dy = 1.0 / size;
                        y = dy * ( y + 0.5 );
                        vec4 v1 = texture2D( boneTexture, vec2( dx * ( x + 0.5 ), y ) );
                        vec4 v2 = texture2D( boneTexture, vec2( dx * ( x + 1.5 ), y ) );
                        vec4 v3 = texture2D( boneTexture, vec2( dx * ( x + 2.5 ), y ) );
                        vec4 v4 = texture2D( boneTexture, vec2( dx * ( x + 3.5 ), y ) );
                        return mat4( v1, v2, v3, v4 );
                    }
                    ` : ''}

                    void main() {
                        vec3 outNormal;
                        vec4 outPosition;

                        ${isSkinned ? `
                        vec4 skinnedPos = vec4(0.0);
                        vec4 skinnedNormal = vec4(0.0);
                        mat4 boneMatX = getBoneMatrix( skinIndex.x );
                        mat4 boneMatY = getBoneMatrix( skinIndex.y );
                        mat4 boneMatZ = getBoneMatrix( skinIndex.z );
                        mat4 boneMatW = getBoneMatrix( skinIndex.w );
                        mat4 skinMatrix = skinWeight.x * boneMatX
                                        + skinWeight.y * boneMatY
                                        + skinWeight.z * boneMatZ
                                        + skinWeight.w * boneMatW;
                        skinnedPos = skinMatrix * vec4( position, 1.0 );
                        skinnedNormal = skinMatrix * vec4( normal, 0.0 );
                        outNormal = normalize( skinnedNormal.xyz );
                        outPosition = skinnedPos;
                        ` : `
                        outNormal = normal;
                        outPosition = vec4( position, 1.0 );
                        `}

                        outPosition.xyz += outNormal * uThickness;
                        gl_Position = projectionMatrix * viewMatrix * modelMatrix * outPosition;
                    }
                `;

                const fragmentShader = `
                    uniform vec3 uColor;
                    void main() {
                        gl_FragColor = vec4(uColor, 1.0);
                    }
                `;

                const material = new this.api.THREE.ShaderMaterial({
                    uniforms: {
                        uThickness: { value: this.params.thickness },
                        uColor: { value: new this.api.THREE.Color(this.params.color) },
                        ...(isSkinned ? {
                            boneTexture: { value: child.skeleton.boneTexture },
                            boneTextureSize: { value: child.skeleton.boneTextureSize }
                        } : {})
                    },
                    vertexShader,
                    fragmentShader,
                    side: this.api.THREE.BackSide,
                    skinning: false   // we handle skinning manually
                });

                let outlineMesh;
                if (isSkinned) {
                    outlineMesh = new this.api.THREE.SkinnedMesh(geo, material);
                    outlineMesh.bind(child.skeleton);
                } else {
                    outlineMesh = new this.api.THREE.Mesh(geo, material);
                }

                outlineMesh.position.copy(child.position);
                outlineMesh.quaternion.copy(child.quaternion);
                outlineMesh.scale.copy(child.scale);

                child.parent.add(outlineMesh);
                group.meshes.push({ mesh: outlineMesh, material, isSkinned });
            }
        });

        this._outlineData.push(group);
    },

    _buildUI() {
        const panel = document.getElementById('param-panel');
        const title = document.getElementById('param-title');
        const content = document.getElementById('param-content');
        if (!panel || !title || !content) return;
        this.ui = { panel, title, content };
    },

    onSelect() {
        if (!this.ui) return;
        const { title, content } = this.ui;
        title.textContent = this.name;
        content.innerHTML = '';

        // Thickness slider
        const thickRow = document.createElement('div');
        thickRow.className = 'param-row';
        thickRow.innerHTML = `
            <label>Thickness</label>
            <input type="range" min="0.001" max="0.1" step="0.001" value="${this.params.thickness}">
            <span>${this.params.thickness}</span>`;
        const thickInput = thickRow.querySelector('input');
        const thickSpan = thickRow.querySelector('span');
        thickInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.params.thickness = val;
            thickSpan.textContent = val;
            for (const group of this._outlineData) {
                for (const item of group.meshes) {
                    item.material.uniforms.uThickness.value = val;
                }
            }
        });
        content.appendChild(thickRow);

        // Color picker
        const colorRow = document.createElement('div');
        colorRow.className = 'param-row';
        colorRow.innerHTML = `
            <label>Color</label>
            <input type="color" value="${this.params.color}">`;
        const colorInput = colorRow.querySelector('input');
        colorInput.addEventListener('input', (e) => {
            this.params.color = e.target.value;
            for (const group of this._outlineData) {
                for (const item of group.meshes) {
                    item.material.uniforms.uColor.value.set(this.params.color);
                }
            }
        });
        content.appendChild(colorRow);

        this.ui.panel.style.display = 'block';
    },

    onDeselect() {
        if (this.ui) this.ui.panel.style.display = 'none';
    },

    dispose() {
        for (const group of this._outlineData) {
            for (const item of group.meshes) {
                if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
                item.mesh.geometry.dispose();
                item.material.dispose();
            }
            group.model.userData._outlineApplied = false;
        }
        this._outlineData = [];
        this.onDeselect();
    }
};