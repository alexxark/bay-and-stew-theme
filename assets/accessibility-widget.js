/**
 * Accessibility Widget — Bay & Stew Theme
 * Self-contained: builds HTML, handles state, TTS, profiles.
 * WCAG 2.1 AA compliant · Keyboard shortcut: Alt + A
 */
(function () {
  'use strict';

  /* ================================================================
     Feature registry — single source of truth for all toggles
     ================================================================ */
  var features = [
    { key: 'reading-mode',    title: 'Reading mode',            desc: 'Improve readability and widen text.' },
    { key: 'highlight-focus', title: 'Highlight focus & links',  desc: 'Emphasize keyboard focus and links.' },
    { key: 'contrast',        title: 'Increase contrast',        desc: 'Boost overall contrast.' },
    { key: '_tts' },
    { key: 'reduce-motion',   title: 'Reduce animations',        desc: 'Minimize motion effects.' },
    { key: 'pause-autoplay',  title: 'Pause auto-rotating',      desc: 'Stops slideshows and carousels.' },
    { key: 'text-size',       title: 'Increase text size',        desc: 'Scale text slightly larger.' },
    { key: 'letter-spacing',  title: 'Increase letter spacing',   desc: 'Add space between letters.' },
    { key: 'line-height',     title: 'Increase line height',      desc: 'Add vertical spacing.' },
    { key: 'dyslexia-font',   title: 'Dyslexia-friendly font',    desc: 'Apply a clearer text font.' },
    { key: 'underline-links', title: 'Underline links',           desc: 'Make all links visibly underlined.' },
    { key: 'monochrome',      title: 'Monochrome',                desc: 'Remove colors (grayscale mode).' },
    { key: 'invert-colors',   title: 'Invert colors',             desc: 'Invert page colors.' },
    { key: 'big-cursor',      title: 'Big cursor',                desc: 'Increase cursor size.' },
    { key: 'hide-images',     title: 'Hide images',               desc: 'Reduce visual distractions.' }
  ];

  var toggleKeys = features
    .filter(function (f) { return f.key !== '_tts'; })
    .map(function (f) { return f.key; });

  /* ================================================================
     Build the dialog HTML string
     ================================================================ */
  function buildDialogHTML() {
    var h = '';

    /* --- Non-scrolling header --- */
    h += '<div class="a11y-panel__header-wrap">';
    h += '  <div class="a11y-panel__header">';
    h += '    <h2 id="a11y-title" class="a11y-panel__title">Accessibility</h2>';
    h += '    <button type="button" class="a11y-panel__close" data-a11y-close aria-label="Close accessibility menu">';
    h += '      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    h += '    </button>';
    h += '  </div>';
    h += '</div>';

    /* --- Scrollable body --- */
    h += '<div class="a11y-panel__body" tabindex="-1">';

    h += '<p class="a11y-panel__intro">Adjust motion, readability, and assistance tools. Settings persist on this device.</p>';
    h += '<p class="a11y-panel__hint">Keyboard shortcut: <kbd>Alt</kbd> + <kbd>A</kbd></p>';

    /* Profiles */
    h += '<details class="a11y-panel__profiles">';
    h += '  <summary class="a11y-panel__profiles-summary">Profiles</summary>';
    h += '  <div class="a11y-panel__profiles-list">';
    h += profileBtn('motor',     'Motor Impaired');
    h += profileBtn('blind',     'Blind');
    h += profileBtn('color',     'Color Blind');
    h += profileBtn('dyslexia',  'Dyslexia');
    h += profileBtn('visual',    'Visually Impaired');
    h += profileBtn('cognitive',  'Cognitive &amp; Learning');
    h += profileBtn('seizure',   'Seizure &amp; Epileptic');
    h += profileBtn('adhd',      'ADHD');
    h += '  </div>';
    h += '</details>';

    /* Feature cards */
    h += '<div class="a11y-panel__grid">';
    features.forEach(function (f) {
      if (f.key === '_tts') { h += ttsCard(); }
      else { h += card(f.key, f.title, f.desc); }
    });
    h += '</div>';

    h += '</div>'; /* end body */

    /* --- Non-scrolling footer --- */
    h += '<div class="a11y-panel__footer">';
    h += '  <label class="a11y-side-switch">';
    h += '    <input type="checkbox" data-a11y-side-switch aria-label="Switch widget to left side">';
    h += '    <span>Switch to left</span>';
    h += '  </label>';
    h += '  <button type="button" class="a11y-panel__reset" data-a11y-reset>Reset</button>';
    h += '</div>';

    /* Screen-reader live region */
    h += '<div class="a11y-sr-only" aria-live="polite" aria-atomic="true" data-a11y-announce></div>';

    return h;
  }

  /* --- Helpers for building HTML fragments --- */
  function profileBtn(key, label) {
    return '<button type="button" class="a11y-profile" data-a11y-profile="' + key + '" aria-pressed="false">' +
      '<span>' + label + '</span>' +
      '<span class="a11y-switch" aria-hidden="true"></span>' +
    '</button>';
  }

  function card(toggle, title, desc) {
    return '<label class="a11y-card">' +
      '<span class="a11y-card__content">' +
        '<span class="a11y-card__title">' + title + '</span>' +
        '<span class="a11y-card__desc">' + desc + '</span>' +
      '</span>' +
      '<input type="checkbox" data-a11y-toggle="' + toggle + '" aria-label="' + title + '">' +
    '</label>';
  }

  function ttsCard() {
    return '<div class="a11y-card a11y-card--tts">' +
      '<button type="button" class="a11y-tts-toggle" data-a11y-action="tts" aria-pressed="false">' +
        '<span class="a11y-card__title">Text to speech</span>' +
        '<span class="a11y-card__desc" data-a11y-tts-status>Enable hover to read</span>' +
      '</button>' +
      '<div class="a11y-tts-speeds" role="group" aria-label="Text-to-speech speed">' +
        '<button type="button" data-a11y-tts-speed="0.75" aria-pressed="false">Slow</button>' +
        '<button type="button" data-a11y-tts-speed="1" aria-pressed="true">Normal</button>' +
        '<button type="button" data-a11y-tts-speed="1.25" aria-pressed="false">Fast</button>' +
      '</div>' +
    '</div>';
  }

  /* ================================================================
     Create & inject the <dialog> element
     ================================================================ */
  var dialog = document.createElement('dialog');
  dialog.id = 'accessibility-support';
  dialog.className = 'a11y-panel';
  dialog.setAttribute('aria-labelledby', 'a11y-title');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = buildDialogHTML();
  document.body.appendChild(dialog);

  /* ================================================================
     Cached references
     ================================================================ */
  var closeBtn       = dialog.querySelector('[data-a11y-close]');
  var announceEl     = dialog.querySelector('[data-a11y-announce]');
  var sideSwitch     = dialog.querySelector('[data-a11y-side-switch]');
  var resetButton    = dialog.querySelector('[data-a11y-reset]');
  var ttsButton      = dialog.querySelector('[data-a11y-action="tts"]');
  var ttsStatusEl    = dialog.querySelector('[data-a11y-tts-status]');
  var ttsSpeedBtns   = Array.from(dialog.querySelectorAll('[data-a11y-tts-speed]'));
  var profileBtns    = Array.from(dialog.querySelectorAll('[data-a11y-profile]'));
  var supportsDialog = typeof dialog.show === 'function';

  /* Build a map of toggle key → input element */
  var inputMap = {};
  toggleKeys.forEach(function (key) {
    inputMap[key] = dialog.querySelector('[data-a11y-toggle="' + key + '"]');
  });

  var lastFocusedEl      = null;
  var focusTrapHandler   = null;
  var escapeHandler      = null;

  /* TTS state */
  var ttsActive       = false;
  var ttsRate         = 1;
  var hoverTimer      = null;
  var lastSpoken      = '';
  var lastSpokenTarget = null;

  /* ================================================================
     Utility: announce to screen readers
     ================================================================ */
  function announce(msg) {
    if (!announceEl) return;
    announceEl.textContent = '';
    requestAnimationFrame(function () { announceEl.textContent = msg; });
  }

  /* ================================================================
     Key helper: kebab-key → camelKey
     ================================================================ */
  function camel(key) {
    return key.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  /* ================================================================
     Settings state snapshot / restore
     ================================================================ */
  function getSnapshot() {
    var s = {};
    toggleKeys.forEach(function (k) { s[camel(k)] = !!(inputMap[k] && inputMap[k].checked); });
    return s;
  }

  function restoreSnapshot(s) {
    if (!s) return;
    toggleKeys.forEach(function (k) {
      if (inputMap[k]) inputMap[k].checked = !!s[camel(k)];
    });
    applyPreferences();
  }

  /* ================================================================
     Sync all inputs from localStorage on load / open
     ================================================================ */
  function syncFromStorage() {
    try {
      /* Panel side */
      var side = localStorage.getItem('a11y-panel-side') || 'right';
      dialog.classList.toggle('a11y-panel--left', side === 'left');
      if (sideSwitch) sideSwitch.checked = side === 'left';

      /* TTS */
      var ttsStored = localStorage.getItem('a11y-tts-active') === 'true';
      setTtsUI(ttsStored);
      if (ttsStored) enableHoverTts();

      /* Stored rate */
      var rate = parseFloat(localStorage.getItem('a11y-tts-rate') || '1');
      ttsRate = isNaN(rate) ? 1 : rate;
      ttsSpeedBtns.forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(parseFloat(btn.dataset.a11yTtsSpeed) === ttsRate));
      });

      /* Toggle inputs */
      toggleKeys.forEach(function (k) {
        if (inputMap[k]) inputMap[k].checked = localStorage.getItem('a11y-' + k) === 'true';
      });

      /* Active profile */
      var prof = localStorage.getItem('a11y-profile') || '';
      profileBtns.forEach(function (btn) {
        btn.setAttribute('aria-pressed', btn.dataset.a11yProfile === prof ? 'true' : 'false');
      });
    } catch (e) { /* storage blocked */ }
  }

  /* ================================================================
     Apply preferences: toggle classes on <html>, persist to storage
     ================================================================ */
  function applyPreferences() {
    try {
      var root = document.documentElement;
      var motionOff = !!(inputMap['reduce-motion'] && inputMap['reduce-motion'].checked);

      toggleKeys.forEach(function (k) {
        var on = !!(inputMap[k] && inputMap[k].checked);
        /* Reduce-motion also forces pause-autoplay */
        if (k === 'pause-autoplay' && motionOff) {
          on = true;
          if (inputMap[k]) inputMap[k].checked = true;
        }
        localStorage.setItem('a11y-' + k, String(on));
        root.classList.toggle('a11y-' + k, on);
      });
    } catch (e) { /* ignore */ }
  }

  /* ================================================================
     TTS — Text-to-Speech
     ================================================================ */
  function setTtsUI(active) {
    ttsActive = active;
    if (ttsButton) ttsButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (ttsStatusEl) ttsStatusEl.textContent = active ? 'Hover over text to hear it' : 'Enable hover to read';
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.rate = ttsRate;
    window.speechSynthesis.speak(u);
  }

  function stopTts() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    localStorage.setItem('a11y-tts-active', 'false');
    setTtsUI(false);
    announce('Text to speech disabled');
  }

  function startTts() {
    if (!('speechSynthesis' in window)) {
      announce('Text to speech is not supported in this browser');
      return;
    }
    setTtsUI(true);
    enableHoverTts();
    localStorage.setItem('a11y-tts-active', 'true');
    speak('Text to speech enabled');
    announce('Text to speech enabled');
  }

  /* --- Speakable text extraction --- */
  function labelledText(el, attr) {
    var ids = el.getAttribute && el.getAttribute(attr);
    if (!ids) return '';
    return ids.split(/\s+/)
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean)
      .map(function (n) { return (n.textContent || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  function getSpeakable(target) {
    if (!target || target.closest('#accessibility-support')) return '';
    var el = target;
    for (var i = 0; i < 4 && el; i++) {
      var t;
      t = labelledText(el, 'aria-labelledby'); if (t) return t;
      t = labelledText(el, 'aria-describedby'); if (t) return t;
      t = el.getAttribute && el.getAttribute('aria-label'); if (t) return t;
      var role = el.getAttribute && el.getAttribute('role');
      if ((el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link') && el.textContent) {
        return el.textContent.replace(/\s+/g, ' ').trim();
      }
      t = el.getAttribute && el.getAttribute('title'); if (t) return t;
      if (el.tagName === 'IMG' && el.alt) return 'Image: ' + el.alt;
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder) return el.placeholder;
      /* Check for an associated <label> */
      if (el.id) {
        var lbl = document.querySelector('label[for="' + el.id + '"]');
        if (lbl) return lbl.textContent.replace(/\s+/g, ' ').trim();
      }
      var img = el.querySelector && el.querySelector('img[alt]');
      if (img && img.alt) return 'Image: ' + img.alt;
      el = el.parentElement;
    }
    return (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function onHover(e) {
    if (!ttsActive) return;
    var txt = getSpeakable(e.target);
    if (!txt || (txt === lastSpoken && e.target === lastSpokenTarget)) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      lastSpoken = txt;
      lastSpokenTarget = e.target;
      speak(txt);
    }, 220);
  }

  function enableHoverTts() {
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('focusin', onHover, true);
  }

  function disableHoverTts() {
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('focusin', onHover, true);
    lastSpoken = '';
    lastSpokenTarget = null;
  }

  /* ================================================================
     Profiles
     ================================================================ */
  var profilePresets = {
    motor:     { highlightFocus: true, textSize: true, lineHeight: true, bigCursor: true },
    blind:     { readingMode: true, highlightFocus: true, textSize: true, lineHeight: true, contrast: true, reduceMotion: true, pauseAutoplay: true, underlineLinks: true },
    color:     { contrast: true, monochrome: true, underlineLinks: true },
    dyslexia:  { dyslexiaFont: true, letterSpacing: true, lineHeight: true, readingMode: true, underlineLinks: true },
    visual:    { textSize: true, contrast: true, highlightFocus: true, lineHeight: true, bigCursor: true, underlineLinks: true },
    cognitive: { readingMode: true, reduceMotion: true, pauseAutoplay: true, highlightFocus: true, textSize: true },
    seizure:   { reduceMotion: true, pauseAutoplay: true, hideImages: true },
    adhd:      { reduceMotion: true, pauseAutoplay: true, highlightFocus: true, readingMode: true }
  };

  function applyProfile(key) {
    var preset = profilePresets[key];
    if (!preset) return;

    /* Back up current state before applying profile */
    if (!localStorage.getItem('a11y-profile-backup')) {
      localStorage.setItem('a11y-profile-backup', JSON.stringify(getSnapshot()));
    }

    toggleKeys.forEach(function (k) {
      if (inputMap[k]) inputMap[k].checked = !!preset[camel(k)];
    });

    localStorage.setItem('a11y-profile', key);
    profileBtns.forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.a11yProfile === key ? 'true' : 'false');
    });
    applyPreferences();

    var label = key.charAt(0).toUpperCase() + key.slice(1);
    announce(label + ' profile applied');
  }

  /* ================================================================
     Open / Close (non-modal so background stays scrollable)
     ================================================================ */
  function openDialog() {
    syncFromStorage();
    lastFocusedEl = document.activeElement;

    if (supportsDialog) {
      dialog.show(); /* non-modal: page behind stays interactive */
    } else {
      dialog.classList.add('is-open');
      dialog.setAttribute('open', '');
    }

    /* Focus trap */
    if (!focusTrapHandler) {
      focusTrapHandler = function (e) {
        if (e.key !== 'Tab') return;
        var els = dialog.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),details>summary'
        );
        if (!els.length) return;
        var first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
    }
    if (!escapeHandler) {
      escapeHandler = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      };
    }
    dialog.addEventListener('keydown', focusTrapHandler);
    dialog.addEventListener('keydown', escapeHandler);

    /* Focus the close button so screen readers announce the dialog */
    if (closeBtn) closeBtn.focus();
    announce('Accessibility menu opened');
  }

  function closeDialog() {
    if (supportsDialog) { try { dialog.close(); } catch (e) {} }
    dialog.classList.remove('is-open');
    if (focusTrapHandler) dialog.removeEventListener('keydown', focusTrapHandler);
    if (escapeHandler)    dialog.removeEventListener('keydown', escapeHandler);
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') lastFocusedEl.focus();
  }

  /* ================================================================
     Public API
     ================================================================ */
  window.A11yWidget = { open: openDialog, close: closeDialog };
  window.EverlyA11y = window.EverlyA11y || {};
  window.EverlyA11y.open = openDialog;

  /* ================================================================
     Event listeners
     ================================================================ */

  /* --- Keyboard shortcut: Alt + A --- */
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      if (dialog.hasAttribute('open') || dialog.classList.contains('is-open')) closeDialog();
      else openDialog();
    }
  });

  /* --- Intercept footer "Accessibility" links --- */
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a');
    if (link) {
      var text = (link.textContent || '').trim().toLowerCase();
      if (text === 'accessibility support' || text === 'accessibility statement' || text === 'accessibility') {
        e.preventDefault();
        openDialog();
        return;
      }
    }
    var trigger = e.target.closest('[data-a11y-open]');
    if (trigger) { e.preventDefault(); openDialog(); }
  });

  /* --- Close button --- */
  if (closeBtn) closeBtn.addEventListener('click', closeDialog);

  /* --- Click outside to close --- */
  document.addEventListener('mousedown', function (e) {
    if (!dialog.hasAttribute('open') && !dialog.classList.contains('is-open')) return;
    if (dialog.contains(e.target)) return;
    var link = e.target.closest('a');
    if (link && (link.textContent || '').trim().toLowerCase().indexOf('accessibility') !== -1) return;
    if (e.target.closest('[data-a11y-open]')) return;
    closeDialog();
  });

  /* --- Wire up all toggle checkboxes --- */
  toggleKeys.forEach(function (k) {
    var inp = inputMap[k];
    if (!inp) return;
    inp.addEventListener('change', function () {
      applyPreferences();
      var lbl = inp.closest('.a11y-card');
      var t = lbl ? lbl.querySelector('.a11y-card__title') : null;
      announce((t ? t.textContent : k) + (inp.checked ? ' enabled' : ' disabled'));
    });
  });

  /* --- TTS button --- */
  if (ttsButton) {
    ttsButton.addEventListener('click', function () {
      if (ttsActive) { stopTts(); disableHoverTts(); }
      else { startTts(); }
    });
  }

  /* --- TTS speed buttons --- */
  ttsSpeedBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      ttsRate = parseFloat(btn.dataset.a11yTtsSpeed) || 1;
      localStorage.setItem('a11y-tts-rate', String(ttsRate));
      ttsSpeedBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      if (ttsActive) speak('Speed updated');
      announce('Speech rate: ' + btn.textContent);
    });
  });

  /* --- Side switch --- */
  if (sideSwitch) {
    sideSwitch.addEventListener('change', function () {
      var isLeft = sideSwitch.checked;
      dialog.classList.toggle('a11y-panel--left', isLeft);
      localStorage.setItem('a11y-panel-side', isLeft ? 'left' : 'right');
      announce('Widget moved to ' + (isLeft ? 'left' : 'right') + ' side');
    });
  }

  /* --- Reset button --- */
  if (resetButton) {
    resetButton.addEventListener('click', function () {
      /* Clear all storage keys */
      var keys = toggleKeys.map(function (k) { return 'a11y-' + k; });
      keys.push('a11y-tts-rate', 'a11y-tts-active', 'a11y-profile', 'a11y-profile-backup', 'a11y-panel-side');
      keys.forEach(function (k) { localStorage.removeItem(k); });

      /* Reset UI */
      if (sideSwitch) sideSwitch.checked = false;
      dialog.classList.remove('a11y-panel--left');
      profileBtns.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      toggleKeys.forEach(function (k) { if (inputMap[k]) inputMap[k].checked = false; });
      ttsSpeedBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.a11yTtsSpeed === '1'));
      });
      ttsRate = 1;
      if (ttsActive) { stopTts(); disableHoverTts(); }

      applyPreferences();
      announce('All accessibility settings have been reset');
    });
  }

  /* --- Profile buttons --- */
  profileBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.dataset.a11yProfile;
      var active = localStorage.getItem('a11y-profile') || '';

      if (active === key) {
        /* Deactivate — restore backed-up state */
        var raw = localStorage.getItem('a11y-profile-backup');
        localStorage.removeItem('a11y-profile');
        localStorage.removeItem('a11y-profile-backup');
        profileBtns.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });

        if (raw) {
          try { restoreSnapshot(JSON.parse(raw)); } catch (e) { applyPreferences(); }
        } else {
          var blank = {};
          toggleKeys.forEach(function (k) { blank[camel(k)] = false; });
          restoreSnapshot(blank);
        }
        announce(key + ' profile removed');
        return;
      }

      applyProfile(key);
    });
  });

  /* ================================================================
     Initialise: apply saved settings on first load
     ================================================================ */
  syncFromStorage();
  applyPreferences();
})();
