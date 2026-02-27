/**
 * Accessibility Widget — Bay & Stew Theme
 * Full-featured accessibility overlay with profiles, feature toggles,
 * slider controls, and color adjusters.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'a11y_widget_settings';

  /* ---- State ---- */
  let state = loadState();

  function defaultState() {
    return {
      position: 'right',
      profiles: {},
      features: {},
      sliders: {
        zoom: 0,
        brightness: 0,
        fontSizing: 0,
        letterSpacing: 0,
        saturation: 0,
        alignText: 0
      },
      colors: {
        text: null,
        title: null,
        bg: null
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign(defaultState(), parsed);
      }
    } catch (e) { /* ignore */ }
    return defaultState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore */ }
  }

  /* ---- Profile definitions ---- */
  const PROFILES = [
    { id: 'motor', label: 'Motor Impaired', icon: 'accessibility' },
    { id: 'blind', label: 'Blind', icon: 'blind' },
    { id: 'colorblind', label: 'Color Blind', icon: 'colorblind' },
    { id: 'dyslexia', label: 'Dyslexia', icon: 'dyslexia' },
    { id: 'visual', label: 'Visually-Impaired', icon: 'visual' },
    { id: 'cognitive', label: 'Cognitive & Learning', icon: 'cognitive' },
    { id: 'seizure', label: 'Seizure & Epileptic', icon: 'seizure' },
    { id: 'adhd', label: 'ADHD', icon: 'adhd' }
  ];

  /* ---- Feature definitions ---- */
  const FEATURES_ROW1 = [
    { id: 'keyboardNav', label: 'Keyboard Navigation', icon: 'keyboard' },
    { id: 'bigCursor', label: 'Big Cursor', icon: 'cursor' }
  ];
  const FEATURES_ROW2 = [
    { id: 'highlightFocus', label: 'Highlight Focus', icon: 'focus' },
    { id: 'highlightHover', label: 'Highlight Hover', icon: 'hover' },
    { id: 'pauseAnimations', label: 'Pause Animations', icon: 'pause' },
    { id: 'hideImages', label: 'Hide Images', icon: 'hideimg' },
    { id: 'readingMode', label: 'Reading Mode', icon: 'reading' },
    { id: 'dyslexicFont', label: 'Dyslexic Font', icon: 'dyslexia' },
    { id: 'invertColors', label: 'Invert Colors', icon: 'invert' }
  ];

  /* ---- Slider features ---- */
  const SLIDERS = [
    { id: 'zoom', label: 'Zoom Screen', icon: 'zoom', max: 3 },
    { id: 'brightness', label: 'Brightness', icon: 'brightness', max: 3 },
    { id: 'fontSizing', label: 'Font Sizing', icon: 'fontsize', max: 3 },
    { id: 'letterSpacing', label: 'Letter Spacing', icon: 'spacing', max: 3 },
    { id: 'saturation', label: 'Saturation', icon: 'saturation', max: 3 },
    { id: 'alignText', label: 'Align Text', icon: 'align', max: 3 }
  ];

  /* ---- Color swatches ---- */
  const COLOR_SWATCHES = [
    '#1a1a2e', '#e63946', '#e76f51', '#f4a261',
    '#2a9d8f', '#457b9d', '#7209b7'
  ];
  const BG_SWATCHES = [
    '#ffffff', '#ffc8dd', '#ffcdb2', '#fce4a8',
    '#d8f3dc', '#bde0fe', '#e2cfea'
  ];

  /* ---- SVG Icons ---- */
  const ICONS = {
    accessibility: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2"/><path d="M19 13v-2c-1.54.02-3.09-.75-4.07-1.83l-1.29-1.43c-.17-.19-.38-.34-.61-.45-.01 0-.01-.01-.02-.01H13c-.35-.2-.75-.3-1.19-.26C10.76 7.11 10 8.04 10 9.09V15c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.45c1.29 1.07 3.25 1.94 5 1.95zm-6.17 5c-.41 1.16-1.52 2-2.83 2-1.66 0-3-1.34-3-3 0-1.31.84-2.41 2-2.83V12.1c-2.28.46-4 2.48-4 4.9 0 2.76 2.24 5 5 5 2.42 0 4.44-1.72 4.9-4h-2.07z"/></svg>',
    blind: '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c.8 2.1 2.1 3.9 3.8 5.2l1.4-1.4C4.7 14.6 3.7 13.4 3 12c1.7-3.4 5.2-5.5 9-5.5.8 0 1.6.1 2.3.3l1.6-1.6C14.7 4.7 13.4 4.5 12 4.5zM12 7c-.4 0-.7 0-1.1.1l6 6c.1-.4.1-.7.1-1.1 0-2.8-2.2-5-5-5zm-9.4 12.1l1.4 1.4 3.1-3.1c1.5.7 3.2 1.1 4.9 1.1 5 0 9.3-3.1 11-7.5-.8-2.1-2.2-3.9-3.8-5.2l3.3-3.3-1.4-1.4-15.5 15zm7.4-3.5l2.1-2.1c-.1.6-.5 1.2-1 1.6s-1.1.5-1.1.5z"/></svg>',
    colorblind: '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z"/><circle cx="12" cy="12" r="5"/></svg>',
    dyslexia: '<svg viewBox="0 0 24 24"><text x="4" y="18" font-size="16" font-weight="bold" font-family="serif">Df</text></svg>',
    visual: '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>',
    cognitive: '<svg viewBox="0 0 24 24"><path d="M19.8 10.7L4.2 5l-.7 1.9L17.6 12H5v2h12.6L3.5 19.1l.7 1.9 15.6-5.7c.8-.3 1.2-1.1.9-1.9l-.1-.3c-.1-.2-.2-.3-.3-.5V12c.1-.2.2-.3.3-.5l.1-.3c.3-.7-.1-1.5-.9-1.8z"/></svg>',
    seizure: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/><path d="M13 7h-2v5.41l3.29 3.29 1.41-1.41L13 11.59z"/></svg>',
    adhd: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/></svg>',
    keyboard: '<svg viewBox="0 0 24 24"><path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>',
    cursor: '<svg viewBox="0 0 24 24"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5V2z"/></svg>',
    zoom: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3c1-1.1 1.6-2.6 1.6-4.2C16 5.9 13.1 3 9.5 3S3 5.9 3 9.5 5.9 16 9.5 16c1.6 0 3.1-.6 4.2-1.6l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0C7 14 5 12 5 9.5S7 5 9.5 5 14 7 14 9.5 12 14 9.5 14z"/><path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/></svg>',
    brightness: '<svg viewBox="0 0 24 24"><path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg>',
    fontsize: '<svg viewBox="0 0 24 24"><path d="M9 4v3h5v12h3V7h5V4H9zm-6 8h3v7h3v-7h3V9H3v3z"/></svg>',
    spacing: '<svg viewBox="0 0 24 24"><text x="2" y="17" font-size="13" font-weight="bold" font-family="sans-serif">AV</text></svg>',
    focus: '<svg viewBox="0 0 24 24"><path d="M5 15H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4z"/><rect x="7" y="7" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    hover: '<svg viewBox="0 0 24 24"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.2 1-3.2-7.4L7 18.5V2z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="3,2"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
    hideimg: '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>',
    reading: '<svg viewBox="0 0 24 24"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/></svg>',
    invert: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18V4c4.41 0 8 3.59 8 8s-3.59 8-8 8z"/></svg>',
    saturation: '<svg viewBox="0 0 24 24"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/><path d="M12 4v16c4.41 0 8-3.59 8-8s-3.59-8-8-8z" opacity="0.5"/></svg>',
    align: '<svg viewBox="0 0 24 24"><path d="M3 21h18v-2H3v2zm0-4h18v-2H3v2zm0-4h18v-2H3v2zm0-4h18V7H3v2zm0-6v2h18V3H3z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
    reset: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M17 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z"/></svg>',
    profile: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>'
  };

  function icon(name) {
    return ICONS[name] || '';
  }

  /* ---- Build DOM ---- */
  function buildWidget() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'a11y-widget-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.addEventListener('click', closeWidget);
    document.body.appendChild(overlay);

    // Panel
    const panel = document.createElement('div');
    panel.className = 'a11y-widget' + (state.position === 'left' ? ' a11y-widget--left' : '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Accessibility Menu');
    panel.setAttribute('aria-modal', 'true');
    panel.id = 'a11y-widget-panel';

    panel.innerHTML = buildHeader() + '<div class="a11y-widget__body">' +
      buildProfiles() +
      '<div class="a11y-widget__section-title">Navigation & Cursor</div>' +
      buildFeatureGrid([...FEATURES_ROW1]) +
      '<div class="a11y-widget__section-title">Screen & Text Adjustments</div>' +
      buildSliderGrid(SLIDERS.slice(0, 2)) +
      buildSliderGrid(SLIDERS.slice(2, 4)) +
      buildSliderGrid(SLIDERS.slice(4, 6)) +
      '<div class="a11y-widget__section-title">Visual Aids</div>' +
      buildFeatureGrid(FEATURES_ROW2.slice(0, 3)) +
      buildFeatureGrid(FEATURES_ROW2.slice(3, 6)) +
      buildFeatureGrid(FEATURES_ROW2.slice(6, 9)) +
      '<div class="a11y-widget__section-title">Color Adjustments</div>' +
      buildColorSection('text', 'Adjust Text Colors', '#457b9d', COLOR_SWATCHES) +
      buildColorSection('title', 'Adjust Title Colors', '#7209b7', COLOR_SWATCHES) +
      buildColorSection('bg', 'Adjust Background Colors', '#2a9d8f', BG_SWATCHES) +
      '</div>' + buildFooter();

    document.body.appendChild(panel);
    bindEvents(panel, overlay);

    // Apply saved state on load
    applyAllState();
  }

  function buildHeader() {
    return `<div class="a11y-widget__header">
      <span class="a11y-widget__header-title">Accessibility Menu</span>
      <div class="a11y-widget__header-actions">
        <button class="a11y-widget__header-btn" data-action="move" aria-label="Move widget position">${icon('move')}</button>
        <button class="a11y-widget__header-btn" data-action="reset-all" aria-label="Reset all settings">${icon('reset')}</button>
        <button class="a11y-widget__header-btn" data-action="close" aria-label="Close accessibility menu">${icon('close')}</button>
      </div>
    </div>`;
  }

  function buildProfiles() {
    let items = '';
    for (const p of PROFILES) {
      const active = state.profiles[p.id] ? 'true' : 'false';
      items += `<div class="a11y-widget__profile-item">
        <span><span class="a11y-widget__profile-icon">${icon(p.icon)}</span>${p.label}</span>
        <button class="a11y-widget__profile-toggle" role="switch" aria-checked="${active}" aria-label="Toggle ${p.label} profile" data-profile="${p.id}"></button>
      </div>`;
    }
    return `<div class="a11y-widget__profiles">
      <button class="a11y-widget__profiles-header" aria-expanded="false" aria-controls="a11y-profiles-list">
        <span style="display:flex;align-items:center;"><span class="a11y-widget__profiles-icon">${icon('profile')}</span>Profiles</span>
        ${icon('chevron')}
      </button>
      <div class="a11y-widget__profiles-list" id="a11y-profiles-list">${items}</div>
    </div>`;
  }

  function buildFeatureGrid(features) {
    let html = '<div class="a11y-widget__grid">';
    for (const f of features) {
      const active = state.features[f.id] ? 'true' : 'false';
      html += `<button class="a11y-widget__feature" role="switch" aria-pressed="${active}" data-feature="${f.id}" aria-label="${f.label}">
        <span class="a11y-widget__feature-icon">${icon(f.icon)}</span>
        <span class="a11y-widget__feature-label">${f.label}</span>
      </button>`;
    }
    html += '</div>';
    return html;
  }

  function buildSliderGrid(sliders) {
    let html = '<div class="a11y-widget__grid">';
    for (const s of sliders) {
      const level = state.sliders[s.id] || 0;
      const active = level > 0 ? 'true' : 'false';
      let dots = '<div class="a11y-widget__slider-row">';
      for (let i = 1; i <= s.max; i++) {
        dots += `<span class="a11y-widget__slider-dot${i <= level ? ' active' : ''}"></span>`;
      }
      dots += '</div>';
      html += `<button class="a11y-widget__feature" role="slider" aria-pressed="${active}" aria-valuenow="${level}" aria-valuemin="0" aria-valuemax="${s.max}" data-slider="${s.id}" data-max="${s.max}" aria-label="${s.label}, level ${level} of ${s.max}">
        <span class="a11y-widget__feature-icon">${icon(s.icon)}</span>
        <span class="a11y-widget__feature-label">${s.label}</span>
        ${dots}
      </button>`;
    }
    html += '</div>';
    return html;
  }

  function buildColorSection(type, title, dotColor, swatches) {
    const current = state.colors[type];
    let options = '';
    for (const c of swatches) {
      const pressed = current === c ? 'true' : 'false';
      options += `<button class="a11y-widget__color-swatch" style="background:${c};" aria-pressed="${pressed}" aria-label="Set ${type} color to ${c}" data-color-type="${type}" data-color="${c}"></button>`;
    }
    return `<div class="a11y-widget__color-section">
      <button class="a11y-widget__color-header" aria-expanded="false" aria-controls="a11y-color-${type}">
        <span class="a11y-widget__color-header-left"><span class="a11y-widget__color-dot" style="background:${dotColor};"></span>${title}</span>
        ${icon('chevron')}
      </button>
      <div class="a11y-widget__color-options" id="a11y-color-${type}">${options}</div>
    </div>`;
  }

  function buildFooter() {
    const label = state.position === 'right' ? 'Switch widget to left' : 'Switch widget to right';
    return `<div class="a11y-widget__footer">
      <button class="a11y-widget__position-toggle" data-action="toggle-position">
        <span class="a11y-widget__position-x">&times;</span>
        <span>${label}</span>
      </button>
      <div class="a11y-widget__footer-actions">
        <button class="a11y-widget__save-btn" data-action="save">${icon('save')} Save</button>
        <button class="a11y-widget__reset-btn" data-action="reset">${icon('reset')} Reset</button>
      </div>
    </div>`;
  }

  /* ---- Event binding ---- */
  function bindEvents(panel, overlay) {
    // Header buttons
    panel.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const action = btn.dataset.action;
        if (action === 'close') closeWidget();
        if (action === 'reset-all' || action === 'reset') resetAll(panel);
        if (action === 'save') { saveState(); closeWidget(); }
        if (action === 'toggle-position' || action === 'move') togglePosition(panel);
        return;
      }

      // Profiles accordion
      const profHeader = e.target.closest('.a11y-widget__profiles-header');
      if (profHeader) {
        const list = panel.querySelector('.a11y-widget__profiles-list');
        const open = profHeader.getAttribute('aria-expanded') === 'true';
        profHeader.setAttribute('aria-expanded', open ? 'false' : 'true');
        list.classList.toggle('is-open', !open);
        return;
      }

      // Profile toggles
      const profToggle = e.target.closest('.a11y-widget__profile-toggle');
      if (profToggle) {
        const id = profToggle.dataset.profile;
        const active = profToggle.getAttribute('aria-checked') === 'true';
        profToggle.setAttribute('aria-checked', active ? 'false' : 'true');
        state.profiles[id] = !active;
        applyProfile(id, !active);
        saveState();
        return;
      }

      // Feature toggles
      const feat = e.target.closest('.a11y-widget__feature[data-feature]');
      if (feat) {
        const id = feat.dataset.feature;
        const active = feat.getAttribute('aria-pressed') === 'true';
        feat.setAttribute('aria-pressed', active ? 'false' : 'true');
        state.features[id] = !active;
        applyFeature(id, !active);
        saveState();
        return;
      }

      // Slider controls
      const slider = e.target.closest('.a11y-widget__feature[data-slider]');
      if (slider) {
        const id = slider.dataset.slider;
        const max = parseInt(slider.dataset.max);
        let level = (state.sliders[id] || 0) + 1;
        if (level > max) level = 0;
        state.sliders[id] = level;
        slider.setAttribute('aria-valuenow', level);
        slider.setAttribute('aria-pressed', level > 0 ? 'true' : 'false');
        slider.setAttribute('aria-label', slider.querySelector('.a11y-widget__feature-label').textContent + ', level ' + level + ' of ' + max);
        // Update dots
        const dots = slider.querySelectorAll('.a11y-widget__slider-dot');
        dots.forEach(function (d, i) {
          d.classList.toggle('active', i < level);
        });
        applySlider(id, level);
        saveState();
        return;
      }

      // Color accordion
      const colorHeader = e.target.closest('.a11y-widget__color-header');
      if (colorHeader) {
        const opts = colorHeader.nextElementSibling;
        const open = colorHeader.getAttribute('aria-expanded') === 'true';
        colorHeader.setAttribute('aria-expanded', open ? 'false' : 'true');
        opts.classList.toggle('is-open', !open);
        return;
      }

      // Color swatches
      const swatch = e.target.closest('.a11y-widget__color-swatch');
      if (swatch) {
        const type = swatch.dataset.colorType;
        const color = swatch.dataset.color;
        const wasActive = swatch.getAttribute('aria-pressed') === 'true';

        // Deselect siblings
        swatch.parentElement.querySelectorAll('.a11y-widget__color-swatch').forEach(function (s) {
          s.setAttribute('aria-pressed', 'false');
        });

        if (wasActive) {
          state.colors[type] = null;
          applyColor(type, null);
        } else {
          swatch.setAttribute('aria-pressed', 'true');
          state.colors[type] = color;
          applyColor(type, color);
        }
        saveState();
      }
    });

    // Trap focus in dialog
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeWidget();
        return;
      }
      if (e.key === 'Tab') {
        trapFocus(e, panel);
      }
    });
  }

  /* ---- Apply state functions ---- */
  function applyAllState() {
    // Features
    Object.keys(state.features).forEach(function (id) {
      if (state.features[id]) applyFeature(id, true);
    });
    // Sliders
    Object.keys(state.sliders).forEach(function (id) {
      if (state.sliders[id] > 0) applySlider(id, state.sliders[id]);
    });
    // Colors
    Object.keys(state.colors).forEach(function (type) {
      if (state.colors[type]) applyColor(type, state.colors[type]);
    });
    // Profiles
    Object.keys(state.profiles).forEach(function (id) {
      if (state.profiles[id]) applyProfile(id, true);
    });
  }

  const featureClassMap = {
    bigCursor: 'a11y-big-cursor',
    highlightFocus: 'a11y-highlight-focus',
    highlightHover: 'a11y-highlight-hover',
    hideImages: 'a11y-hide-images',
    pauseAnimations: 'a11y-pause-animations',
    dyslexicFont: 'a11y-dyslexic-font',
    readingMode: 'a11y-reading-mode',
    invertColors: 'a11y-invert-colors',
    keyboardNav: 'a11y-keyboard-nav'
  };

  function applyFeature(id, active) {
    const cls = featureClassMap[id];
    if (cls) {
      document.documentElement.classList.toggle(cls, active);
    }
  }

  function applySlider(id, level) {
    const root = document.documentElement;
    // Remove previous levels
    for (let i = 0; i <= 3; i++) {
      let cls;
      if (id === 'zoom') cls = 'a11y-zoom-' + i;
      else if (id === 'brightness') cls = 'a11y-bright-' + i;
      else if (id === 'fontSizing') cls = 'a11y-font-' + i;
      else if (id === 'letterSpacing') cls = 'a11y-spacing-' + i;
      else if (id === 'saturation') cls = 'a11y-sat-' + i;
      else if (id === 'alignText') cls = 'a11y-align-' + i;
      if (cls) root.classList.remove(cls);
    }
    if (level > 0) {
      let cls;
      if (id === 'zoom') cls = 'a11y-zoom-' + level;
      else if (id === 'brightness') cls = 'a11y-bright-' + level;
      else if (id === 'fontSizing') cls = 'a11y-font-' + level;
      else if (id === 'letterSpacing') cls = 'a11y-spacing-' + level;
      else if (id === 'saturation') cls = 'a11y-sat-' + level;
      else if (id === 'alignText') cls = 'a11y-align-' + level;
      if (cls) root.classList.add(cls);
    }
  }

  function applyColor(type, color) {
    const root = document.documentElement;
    if (type === 'text') {
      if (color) {
        root.style.setProperty('--a11y-text-color', color);
        root.setAttribute('data-a11y-text-color', '');
      } else {
        root.style.removeProperty('--a11y-text-color');
        root.removeAttribute('data-a11y-text-color');
      }
    } else if (type === 'title') {
      if (color) {
        root.style.setProperty('--a11y-title-color', color);
        root.setAttribute('data-a11y-title-color', '');
      } else {
        root.style.removeProperty('--a11y-title-color');
        root.removeAttribute('data-a11y-title-color');
      }
    } else if (type === 'bg') {
      if (color) {
        root.style.setProperty('--a11y-bg-color', color);
        root.setAttribute('data-a11y-bg-color', '');
      } else {
        root.style.removeProperty('--a11y-bg-color');
        root.removeAttribute('data-a11y-bg-color');
      }
    }
  }

  function applyProfile(id, active) {
    // Profiles apply groups of features
    const profileFeatures = {
      motor: ['keyboardNav', 'highlightFocus'],
      blind: ['keyboardNav'],
      colorblind: ['invertColors'],
      dyslexia: ['dyslexicFont'],
      visual: ['bigCursor', 'highlightFocus'],
      cognitive: ['highlightFocus', 'readingMode'],
      seizure: ['pauseAnimations'],
      adhd: ['pauseAnimations', 'highlightFocus', 'readingMode']
    };
    const profileSliders = {
      visual: { fontSizing: 2 },
      blind: { fontSizing: 3 },
      dyslexia: { letterSpacing: 2 },
      adhd: {}
    };

    const feats = profileFeatures[id] || [];
    const sliders = profileSliders[id] || {};

    if (active) {
      feats.forEach(function (fid) {
        state.features[fid] = true;
        applyFeature(fid, true);
        updateFeatureUI(fid, true);
      });
      Object.keys(sliders).forEach(function (sid) {
        state.sliders[sid] = sliders[sid];
        applySlider(sid, sliders[sid]);
        updateSliderUI(sid, sliders[sid]);
      });
    }
    // We don't auto-remove on deactivate to avoid conflicts
  }

  function updateFeatureUI(id, active) {
    const btn = document.querySelector('.a11y-widget__feature[data-feature="' + id + '"]');
    if (btn) btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function updateSliderUI(id, level) {
    const btn = document.querySelector('.a11y-widget__feature[data-slider="' + id + '"]');
    if (btn) {
      btn.setAttribute('aria-valuenow', level);
      btn.setAttribute('aria-pressed', level > 0 ? 'true' : 'false');
      const dots = btn.querySelectorAll('.a11y-widget__slider-dot');
      dots.forEach(function (d, i) {
        d.classList.toggle('active', i < level);
      });
    }
  }

  /* ---- Reset ---- */
  function resetAll(panel) {
    // Remove all classes
    Object.values(featureClassMap).forEach(function (cls) {
      document.documentElement.classList.remove(cls);
    });
    for (let i = 0; i <= 3; i++) {
      ['zoom', 'bright', 'font', 'spacing', 'sat', 'align'].forEach(function (prefix) {
        document.documentElement.classList.remove('a11y-' + prefix + '-' + i);
      });
    }
    applyColor('text', null);
    applyColor('title', null);
    applyColor('bg', null);

    state = defaultState();
    saveState();

    // Re-render body
    const body = panel.querySelector('.a11y-widget__body');
    body.innerHTML =
      buildProfiles() +
      '<div class="a11y-widget__section-title">Navigation & Cursor</div>' +
      buildFeatureGrid([...FEATURES_ROW1]) +
      '<div class="a11y-widget__section-title">Screen & Text Adjustments</div>' +
      buildSliderGrid(SLIDERS.slice(0, 2)) +
      buildSliderGrid(SLIDERS.slice(2, 4)) +
      buildSliderGrid(SLIDERS.slice(4, 6)) +
      '<div class="a11y-widget__section-title">Visual Aids</div>' +
      buildFeatureGrid(FEATURES_ROW2.slice(0, 3)) +
      buildFeatureGrid(FEATURES_ROW2.slice(3, 6)) +
      buildFeatureGrid(FEATURES_ROW2.slice(6, 9)) +
      '<div class="a11y-widget__section-title">Color Adjustments</div>' +
      buildColorSection('text', 'Adjust Text Colors', '#457b9d', COLOR_SWATCHES) +
      buildColorSection('title', 'Adjust Title Colors', '#7209b7', COLOR_SWATCHES) +
      buildColorSection('bg', 'Adjust Background Colors', '#2a9d8f', BG_SWATCHES);

    // Update footer label
    const posBtn = panel.querySelector('.a11y-widget__position-toggle span:last-child');
    if (posBtn) posBtn.textContent = 'Switch widget to left';
  }

  /* ---- Position toggle ---- */
  function togglePosition(panel) {
    const isLeft = panel.classList.contains('a11y-widget--left');
    panel.classList.toggle('a11y-widget--left', !isLeft);
    state.position = isLeft ? 'right' : 'left';
    const posBtn = panel.querySelector('.a11y-widget__position-toggle span:last-child');
    if (posBtn) posBtn.textContent = isLeft ? 'Switch widget to left' : 'Switch widget to right';
    saveState();
  }

  /* ---- Open / Close ---- */
  function openWidget() {
    const panel = document.getElementById('a11y-widget-panel');
    const overlay = document.querySelector('.a11y-widget-overlay');
    if (!panel) return;

    panel.classList.add('is-open');
    // Force reflow then animate
    requestAnimationFrame(function () {
      overlay.classList.add('is-visible');
    });
    document.body.style.overflow = 'hidden';

    // Focus first interactive element
    const first = panel.querySelector('.a11y-widget__header-btn');
    if (first) first.focus();

    // Store trigger for returning focus
    panel._trigger = document.activeElement;
  }

  function closeWidget() {
    const panel = document.getElementById('a11y-widget-panel');
    const overlay = document.querySelector('.a11y-widget-overlay');
    if (!panel) return;

    panel.classList.remove('is-open');
    overlay.classList.remove('is-visible');
    document.body.style.overflow = '';

    // Return focus to trigger
    if (panel._trigger && panel._trigger.focus) {
      panel._trigger.focus();
    }
  }

  /* ---- Focus trap ---- */
  function trapFocus(e, container) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---- Intercept footer link ---- */
  function interceptFooterLink() {
    document.addEventListener('click', function (e) {
      const link = e.target.closest('a');
      if (!link) return;

      const text = (link.textContent || '').trim().toLowerCase();
      if (
        text === 'accessibility support' ||
        text === 'accessibility statement' ||
        text === 'accessibility'
      ) {
        e.preventDefault();
        openWidget();
      }
    });
  }

  /* ---- Init ---- */
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        buildWidget();
        interceptFooterLink();
      });
    } else {
      buildWidget();
      interceptFooterLink();
    }
  }

  // Expose for programmatic access
  window.A11yWidget = {
    open: openWidget,
    close: closeWidget
  };

  init();
})();
