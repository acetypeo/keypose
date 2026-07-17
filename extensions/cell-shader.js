export default {
    id: 'cel-shading',
    name: 'Cel Shading (Model)',
    type: 'per-model',
    params: {
        colorSteps: 2,
        shadowSoftness: 0.15,
        highlightThreshold: 0.7,
        shadowThreshold: 0.3,
        contrast: 1.0,
        brightness: 1.0
    },

    _shaderUniforms: [],

    init(api) {
        this.api = api;
        const models = api.getLoadedModels?.() || [];
        models.forEach(m => this._applyToModel(m));
        this._buildUI();
    },

    _applyToModel(model) {
        if (!model) return;
        const self = this;

        model.traverse(child => {
            if (child.isMesh && child.material && !child.material.userData._celApplied) {
                const original = child.material;
                const mat = original.clone();
                mat.userData._celApplied = true;
                mat.userData._originalMaterial = original;

                mat.onBeforeCompile = (shader) => {
                    // Add our custom uniforms
                    const uniformDecl = `
                        uniform float uColorSteps;
                        uniform float uShadowSoftness;
                        uniform float uHighlightThreshold;
                        uniform float uShadowThreshold;
                        uniform float uContrast;
                        uniform float uBrightness;
                    `;
                    shader.fragmentShader = shader.fragmentShader.replace(
                        'void main() {',
                        `${uniformDecl}\nvoid main() {`
                    );

                    // Link them to current parameter values
                    shader.uniforms.uColorSteps = { value: self.params.colorSteps };
                    shader.uniforms.uShadowSoftness = { value: self.params.shadowSoftness };
                    shader.uniforms.uHighlightThreshold = { value: self.params.highlightThreshold };
                    shader.uniforms.uShadowThreshold = { value: self.params.shadowThreshold };
                    shader.uniforms.uContrast = { value: self.params.contrast };
                    shader.uniforms.uBrightness = { value: self.params.brightness };

                    // Store for instant slider updates
                    self._shaderUniforms.push(shader.uniforms);

                    // ----- FIX: Band the scene‑lit colour instead of hardcoded light -----
                    shader.fragmentShader = shader.fragmentShader.replace(
                        'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
                        `
                        vec3 litColor = outgoingLight;   // already lit by ALL scene lights

                        // Cel banding based on brightness of lit colour
                        float luma = dot(litColor, vec3(0.299, 0.587, 0.114));
                        float banded = floor(luma * uColorSteps) / uColorSteps;
                        if (luma < uShadowThreshold) banded *= 1.0 - uShadowSoftness * 0.5;
                        if (luma > uHighlightThreshold) banded += (1.0 - banded) * 0.5;
                        litColor *= banded / max(luma, 0.01);

                        // Post‑banding adjustments (same sliders)
                        litColor = (litColor - 0.5) * uContrast + 0.5;
                        litColor *= uBrightness;
                        litColor = clamp(litColor, 0.0, 1.0);

                        gl_FragColor = vec4(litColor, diffuseColor.a);
                        `
                    );
                };

                child.material = mat;
            }
        });
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

        const specs = [
            { key: 'colorSteps',         uname: 'uColorSteps' },
            { key: 'shadowSoftness',     uname: 'uShadowSoftness' },
            { key: 'highlightThreshold', uname: 'uHighlightThreshold' },
            { key: 'shadowThreshold',    uname: 'uShadowThreshold' },
            { key: 'contrast',           uname: 'uContrast' },
            { key: 'brightness',         uname: 'uBrightness' }
        ];

        specs.forEach(spec => {
            const row = document.createElement('div');
            row.className = 'param-row';
            row.innerHTML = `
                <label>${spec.key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</label>
                <input type="range" min="0" max="2" step="0.01" value="${this.params[spec.key]}">
                <span>${this.params[spec.key]}</span>`;

            const input = row.querySelector('input');
            const span = row.querySelector('span');
            // Custom ranges for each parameter
            if (spec.key === 'colorSteps') { input.min = 2; input.max = 8; input.step = 1; }
            else if (spec.key === 'shadowSoftness') { input.min = 0.5; input.max = 2.5; }
            else if (spec.key === 'highlightThreshold') { input.min = 0.3; input.max = 1; }
            else if (spec.key === 'shadowThreshold') { input.min = 0; input.max = 0.7; }
            else { input.min = 0; input.max = 2.5; }

            input.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this.params[spec.key] = val;
                span.textContent = val;
                // Instantly update all stored shader uniforms
                for (const unis of this._shaderUniforms) {
                    if (unis[spec.uname]) unis[spec.uname].value = val;
                }
            });
            content.appendChild(row);
        });

        this.ui.panel.style.display = 'block';
    },

    onDeselect() {
        if (this.ui) this.ui.panel.style.display = 'none';
    },

    dispose() {
        const models = this.api.getLoadedModels?.() || [];
        models.forEach(model => {
            model.traverse(child => {
                if (child.material && child.material.userData._originalMaterial) {
                    child.material.dispose();
                    child.material = child.material.userData._originalMaterial;
                }
            });
        });
        this._shaderUniforms = [];
        this.onDeselect();
    }
};