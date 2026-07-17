export default {
    id: 'world-light',
    name: 'World Light',
    type: 'light',
    params: {
        intensity: 2.0,
        color: '#ffffff',
        enabled: true
    },

    init(api) {
        this.api = api;

        // ---- Create the directional light ----
        this.light = new api.THREE.DirectionalLight(this.params.color, this.params.intensity);
        this.light.position.set(3, 5, 2);
        this.light.castShadow = true;
        this.light.visible = this.params.enabled;
        this.light.userData.isMovable = true;   // ← allows cel shader to find it

        this.light.target.position.set(0, 0.8, 0);
        api.scene.add(this.light);
        api.scene.add(this.light.target);

        // ---- Helper orb ----
        const geo = new api.THREE.SphereGeometry(0.2, 16, 16);
        const mat = new api.THREE.MeshBasicMaterial({ color: 0xffaa00 });
        this.helper = new api.THREE.Mesh(geo, mat);
        this.helper.position.copy(this.light.position);
        this.helper.userData.isLightHelper = true;
        api.scene.add(this.helper);

        // Sync helper → light
        this._gizmoUpdate = () => {
            this.light.position.copy(this.helper.position);
        };

        // Click to select
        this._clickHandler = (e) => {
            if (e.target.closest('#gear-menu') ||
                e.target.closest('#param-panel') ||
                e.target.closest('#mode-buttons') ||
                e.target.closest('#timeline-bar') ||
                e.target.closest('#gallery-modal') ||
                e.target.closest('#panels-menu')) return;

            const rect = api.renderer.domElement.getBoundingClientRect();
            const mouse = new api.THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1
            );
            const raycaster = new api.THREE.Raycaster();
            raycaster.setFromCamera(mouse, api.camera);
            const hits = raycaster.intersectObject(this.helper);
            if (hits.length > 0) {
                e.stopPropagation();
                e.stopImmediatePropagation();
                api.gizmo.detach();
                api.gizmo.attach(this.helper);
                api.gizmo.removeEventListener('objectChange', this._gizmoUpdate);
                api.gizmo.addEventListener('objectChange', this._gizmoUpdate);
                document.getElementById('status').innerHTML = '💡 World Light selected';
            }
        };
        window.addEventListener('click', this._clickHandler, true);

        this._buildUI();
    },

    getState() {
        return {
            lightPos: [this.light.position.x, this.light.position.y, this.light.position.z],
            helperPos: [this.helper.position.x, this.helper.position.y, this.helper.position.z],
            intensity: this.params.intensity,
            color: this.params.color,
            enabled: this.params.enabled
        };
    },

    restoreState(state) {
        if (state.lightPos) {
            this.light.position.set(state.lightPos[0], state.lightPos[1], state.lightPos[2]);
            this.helper.position.set(state.helperPos[0], state.helperPos[1], state.helperPos[2]);
        }
        this.params.intensity = state.intensity ?? this.params.intensity;
        this.params.color = state.color ?? this.params.color;
        this.params.enabled = state.enabled ?? this.params.enabled;
        this.light.intensity = this.params.intensity;
        this.light.color.set(this.params.color);
        this.light.visible = this.params.enabled;
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

        // Toggle
        const toggleRow = document.createElement('div');
        toggleRow.className = 'param-row';
        toggleRow.innerHTML = `<label>Enabled</label><input type="checkbox" ${this.params.enabled ? 'checked' : ''}>`;
        toggleRow.querySelector('input').addEventListener('change', (e) => {
            this.params.enabled = e.target.checked;
            this.light.visible = this.params.enabled;
        });
        content.appendChild(toggleRow);

        // Intensity
        const intRow = document.createElement('div');
        intRow.className = 'param-row';
        intRow.innerHTML = `<label>Intensity</label><input type="range" min="0" max="10" step="0.1" value="${this.params.intensity}"><span>${this.params.intensity}</span>`;
        const intInput = intRow.querySelector('input');
        const intSpan = intRow.querySelector('span');
        intInput.addEventListener('input', (e) => {
            this.params.intensity = parseFloat(e.target.value);
            intSpan.textContent = this.params.intensity;
            this.light.intensity = this.params.intensity;
        });
        content.appendChild(intRow);

        // Color
        const colorRow = document.createElement('div');
        colorRow.className = 'param-row';
        colorRow.innerHTML = `<label>Color</label><input type="color" value="${this.params.color}">`;
        colorRow.querySelector('input').addEventListener('input', (e) => {
            this.params.color = e.target.value;
            this.light.color.set(this.params.color);
        });
        content.appendChild(colorRow);

        this.ui.panel.style.display = 'block';
    },

    onDeselect() {
        if (this.ui) this.ui.panel.style.display = 'none';
    },

    dispose() {
        this.api.scene.remove(this.light);
        this.api.scene.remove(this.light.target);
        this.api.scene.remove(this.helper);
        window.removeEventListener('click', this._clickHandler, true);
        if (this.api.gizmo.object === this.helper) {
            this.api.gizmo.detach();
        }
        this.api.gizmo.removeEventListener('objectChange', this._gizmoUpdate);
        this.onDeselect();
    }
};