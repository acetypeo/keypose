import { UnrealBloomPass } from 'https://unpkg.com/three@0.128.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'https://unpkg.com/three@0.128.0/examples/jsm/postprocessing/ShaderPass.js';

export default {
    id: 'post-processing',
    name: 'Post Processing (Bloom + ToneMap)',
    type: 'postprocess',
    params: {
        bloomStrength: 0.5,
        bloomRadius: 0.4,
        bloomThreshold: 0.85,
        toneMappingExposure: 1.0,
        gradingExposure: 1.0,
        gradingContrast: 1.0,
        gradingSaturation: 1.0
    },

    init(api) {
        this.api = api;
        const { composer } = api;

        // 1. UnrealBloomPass (built‑in in r128)
        this.bloomPass = new UnrealBloomPass(
            new api.THREE.Vector2(api.renderer.domElement.width, api.renderer.domElement.height),
            this.params.bloomStrength,
            this.params.bloomRadius,
            this.params.bloomThreshold
        );
        composer.addPass(this.bloomPass);

        // 2. Color grading
        const gradingShader = {
            uniforms: {
                tDiffuse: { value: null },
                uExposure: { value: this.params.gradingExposure },
                uContrast: { value: this.params.gradingContrast },
                uSaturation: { value: this.params.gradingSaturation }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uExposure;
                uniform float uContrast;
                uniform float uSaturation;
                varying vec2 vUv;
                void main() {
                    vec4 tex = texture2D(tDiffuse, vUv);
                    vec3 color = tex.rgb;
                    color *= uExposure;
                    color = (color - 0.5) * uContrast + 0.5;
                    float gray = dot(color, vec3(0.299, 0.587, 0.114));
                    color = mix(vec3(gray), color, uSaturation);
                    gl_FragColor = vec4(color, tex.a);
                }
            `
        };
        this.gradingPass = new ShaderPass(gradingShader);
        composer.addPass(this.gradingPass);

        // 3. ACES tone mapping (custom ShaderPass, instead of OutputPass)
        const acesShader = {
            uniforms: {
                tDiffuse: { value: null },
                uExposure: { value: this.params.toneMappingExposure }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uExposure;
                varying vec2 vUv;

                // Narkowicz 2015 "ACES Filmic Tone Mapping"
                vec3 aces(vec3 x) {
                    float a = 2.51;
                    float b = 0.03;
                    float c = 2.43;
                    float d = 0.59;
                    float e = 0.14;
                    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
                }

                void main() {
                    vec4 tex = texture2D(tDiffuse, vUv);
                    vec3 color = tex.rgb * uExposure;
                    color = aces(color);
                    gl_FragColor = vec4(color, tex.a);
                }
            `
        };
        this.acesPass = new ShaderPass(acesShader);
        composer.addPass(this.acesPass);

        // Ensure last pass outputs to screen
        const passes = composer.passes;
        if (passes.length > 0) passes[passes.length - 1].renderToScreen = true;

        this._buildUI();
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
            { key: 'bloomStrength',      label: 'Bloom Strength',   min: 0, max: 2,   step: 0.01 },
            { key: 'bloomRadius',        label: 'Bloom Radius',     min: 0, max: 1,   step: 0.01 },
            { key: 'bloomThreshold',     label: 'Bloom Threshold',  min: 0, max: 1,   step: 0.01 },
            { key: 'toneMappingExposure',label: 'Tonemap Exposure', min: 0.2, max: 3, step: 0.01 },
            { key: 'gradingExposure',    label: 'Exposure',         min: 0.2, max: 3, step: 0.01 },
            { key: 'gradingContrast',    label: 'Contrast',         min: 0,   max: 2.5, step: 0.01 },
            { key: 'gradingSaturation',  label: 'Saturation',       min: 0,   max: 2,   step: 0.01 }
        ];

        specs.forEach(spec => {
            const row = document.createElement('div');
            row.className = 'param-row';
            row.innerHTML = `
                <label>${spec.label}</label>
                <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${this.params[spec.key]}">
                <span>${this.params[spec.key]}</span>`;

            const input = row.querySelector('input');
            const span = row.querySelector('span');
            input.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this.params[spec.key] = val;
                span.textContent = val;

                if (spec.key === 'bloomStrength')       this.bloomPass.strength = val;
                else if (spec.key === 'bloomRadius')     this.bloomPass.radius = val;
                else if (spec.key === 'bloomThreshold')  this.bloomPass.threshold = val;
                else if (spec.key === 'toneMappingExposure') this.acesPass.uniforms.uExposure.value = val;
                else if (spec.key === 'gradingExposure') this.gradingPass.uniforms.uExposure.value = val;
                else if (spec.key === 'gradingContrast') this.gradingPass.uniforms.uContrast.value = val;
                else if (spec.key === 'gradingSaturation') this.gradingPass.uniforms.uSaturation.value = val;
            });
            content.appendChild(row);
        });

        this.ui.panel.style.display = 'block';
    },

    onDeselect() {
        if (this.ui) this.ui.panel.style.display = 'none';
    },

    dispose() {
        const composer = this.api.composer;
        const passes = composer.passes;
        const toRemove = [this.bloomPass, this.gradingPass, this.acesPass];
        for (const pass of toRemove) {
            const idx = passes.indexOf(pass);
            if (idx !== -1) passes.splice(idx, 1);
        }
        if (passes.length > 0) passes[passes.length - 1].renderToScreen = true;
        this.onDeselect();
    }
};