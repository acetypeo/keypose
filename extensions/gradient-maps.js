import { ShaderPass } from 'https://unpkg.com/three@0.128.0/examples/jsm/postprocessing/ShaderPass.js';

export default {
    id: 'gradient-map',
    name: 'Gradient Map',
    type: 'postprocess',
    params: {
        stops: [
            { pos: 0, color: [0, 0, 0] },
            { pos: 1, color: [255, 255, 255] }
        ],
        intensity: 1.0
    },

    _gradientTex: null,

    init(api) {
        this.api = api;
        this._rebuildPass();
        this._buildUI();
    },

    _rebuildPass() {
        if (this.pass) {
            const idx = this.api.composer.passes.indexOf(this.pass);
            if (idx !== -1) this.api.composer.passes.splice(idx, 1);
            if (this.pass.uniforms && this.pass.uniforms.gradientTex && this.pass.uniforms.gradientTex.value) {
                this.pass.uniforms.gradientTex.value.dispose();
            }
        }

        const tex = this._createGradientTexture();
        this._gradientTex = tex;

        this.pass = new ShaderPass({
            uniforms: {
                tDiffuse: { value: null },
                gradientTex: { value: tex },
                intensity: { value: this.params.intensity }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform sampler2D gradientTex;
                uniform float intensity;
                varying vec2 vUv;
                void main() {
                    vec4 color = texture2D(tDiffuse, vUv);
                    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
                    vec3 mapped = texture2D(gradientTex, vec2(luma, 0.5)).rgb;
                    gl_FragColor = vec4(mix(color.rgb, mapped, intensity), color.a);
                }
            `
        });

        this.pass.renderToScreen = false;
        this.api.composer.addPass(this.pass);
        const passes = this.api.composer.passes;
        if (passes.length > 0) passes[passes.length - 1].renderToScreen = true;
    },

    _createGradientTexture() {
        const w = 256;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = 1;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, w, 0);
        this.params.stops.forEach(s => {
            g.addColorStop(s.pos, `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`);
        });
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, 1);
        const t = new this.api.THREE.CanvasTexture(c);
        t.needsUpdate = true;
        return t;
    },

    // ---- UI (multi‑stop editor) ----
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

        // Intensity slider
        const intRow = document.createElement('div');
        intRow.className = 'param-row';
        intRow.innerHTML = `
            <label>Intensity</label>
            <input type="range" min="0" max="1.5" step="0.01" value="${this.params.intensity}">
            <span>${this.params.intensity}</span>`;
        const intInput = intRow.querySelector('input');
        const intSpan = intRow.querySelector('span');
        intInput.addEventListener('input', (e) => {
            this.params.intensity = parseFloat(e.target.value);
            intSpan.textContent = this.params.intensity;
            this.pass.uniforms.intensity.value = this.params.intensity;
        });
        content.appendChild(intRow);

        // Stop list
        const stopList = document.createElement('div');
        stopList.className = 'stop-list';
        content.appendChild(stopList);

        // Add stop button
        const addBtn = document.createElement('button');
        addBtn.className = 'add-stop-btn';
        addBtn.textContent = '➕ Add stop (midpoint)';
        content.appendChild(addBtn);

        // Gradient preview
        const preview = document.createElement('div');
        preview.className = 'gradient-preview';
        content.appendChild(preview);

        const updatePreview = () => {
            const c = document.createElement('canvas');
            c.width = 200; c.height = 20;
            const ctx = c.getContext('2d');
            const g = ctx.createLinearGradient(0, 0, 200, 0);
            this.params.stops.forEach(s => g.addColorStop(s.pos, `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 200, 20);
            preview.style.background = `url(${c.toDataURL()})`;
            preview.style.backgroundSize = '100% 100%';
        };

        const renderStops = () => {
            stopList.innerHTML = '';
            this.params.stops.sort((a,b) => a.pos - b.pos);
            this.params.stops.forEach((s, i) => {
                const row = document.createElement('div');
                row.className = 'stop-item';
                row.innerHTML = `
                    <span class="pos">${(s.pos*100).toFixed(0)}%</span>
                    <input type="range" class="stop-pos" min="0" max="1" step="0.01" value="${s.pos}">
                    <div class="color-preview" style="background:rgb(${s.color[0]},${s.color[1]},${s.color[2]})"></div>
                    <button class="delete-stop" ${this.params.stops.length <= 2 ? 'disabled style="opacity:0.5"' : ''}>✕</button>`;

                const posSlider = row.querySelector('.stop-pos');
                const colorPreview = row.querySelector('.color-preview');
                const delBtn = row.querySelector('.delete-stop');

                posSlider.addEventListener('input', (e) => {
                    let newPos = parseFloat(e.target.value);
                    if (i === 0) newPos = 0;
                    if (i === this.params.stops.length - 1) newPos = 1;
                    s.pos = newPos;
                    this._rebuildGradient();
                    renderStops();
                });

                colorPreview.addEventListener('click', () => {
                    const colorInput = document.createElement('input');
                    colorInput.type = 'color';
                    colorInput.value = '#' + s.color.map(c => c.toString(16).padStart(2,'0')).join('');
                    colorInput.addEventListener('input', (ev) => {
                        const hex = ev.target.value;
                        s.color[0] = parseInt(hex.substr(1,2), 16);
                        s.color[1] = parseInt(hex.substr(3,2), 16);
                        s.color[2] = parseInt(hex.substr(5,2), 16);
                        colorPreview.style.backgroundColor = `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`;
                        updatePreview();
                        this._rebuildGradient();
                    });
                    colorInput.click();
                });

                if (delBtn && this.params.stops.length > 2) {
                    delBtn.onclick = () => {
                        this.params.stops.splice(i, 1);
                        this._rebuildGradient();
                        renderStops();
                    };
                }

                stopList.appendChild(row);
            });
            updatePreview();
        };

        addBtn.onclick = () => {
            const len = this.params.stops.length;
            const mid = (this.params.stops[0].pos + this.params.stops[len-1].pos) / 2;
            this.params.stops.push({ pos: mid, color: [127, 127, 127] });
            this._rebuildGradient();
            renderStops();
        };

        renderStops();
        this.ui.panel.style.display = 'block';
    },

    _rebuildGradient() {
        if (this._gradientTex) this._gradientTex.dispose();
        this._gradientTex = this._createGradientTexture();
        if (this.pass && this.pass.uniforms.gradientTex) {
            this.pass.uniforms.gradientTex.value = this._gradientTex;
        }
    },

    onDeselect() {
        if (this.ui) this.ui.panel.style.display = 'none';
    },

    dispose() {
        if (this.pass) {
            const idx = this.api.composer.passes.indexOf(this.pass);
            if (idx !== -1) this.api.composer.passes.splice(idx, 1);
            const passes = this.api.composer.passes;
            if (passes.length > 0) passes[passes.length - 1].renderToScreen = true;
        }
        if (this._gradientTex) this._gradientTex.dispose();
        this.onDeselect();
    }
};