/**
 * Accessibility Widget — Bay & Stew Theme
 * Self-contained: builds HTML, handles state, TTS, profiles.
 * Based on the reference implementation from footertest.liquid.
 */
(function () {
  'use strict';

  /* ---- Build and inject the dialog HTML ---- */
  function buildDialogHTML() {
    return '<div class="a11y-panel__inner">' +
      /* Header */
      '<div class="a11y-panel__header">' +
        '<h2 id="accessibility-support-title" class="a11y-panel__title">Accessibility Menu</h2>' +
        '<button type="button" class="a11y-panel__close" data-a11y-close aria-label="Close">&times;</button>' +
      '</div>' +

      '<p class="a11y-panel__intro">Adjust motion, readability, and assistance tools. Settings persist on this device.</p>' +

      /* Profiles */
      '<details class="a11y-panel__profiles" open>' +
        '<summary class="a11y-panel__profiles-summary">Profiles</summary>' +
        '<div class="a11y-panel__profiles-list">' +
          profileBtn('motor', 'Motor Impaired') +
          profileBtn('blind', 'Blind') +
          profileBtn('color', 'Color Blind') +
          profileBtn('dyslexia', 'Dyslexia') +
          profileBtn('visual', 'Visually-Impaired') +
          profileBtn('cognitive', 'Cognitive &amp; Learning') +
          profileBtn('seizure', 'Seizure &amp; Epileptic') +
          profileBtn('adhd', 'ADHD') +
        '</div>' +
      '</details>' +

      /* Feature cards */
      '<div class="a11y-panel__grid">' +
        card('reading-mode', 'Reading mode', 'Improve readability and widen text.') +
        card('highlight-focus', 'Highlight focus & links', 'Emphasize keyboard focus and links.') +
        card('contrast', 'Increase contrast', 'Boost overall contrast.') +

        /* TTS card (special) */
        '<div class="a11y-card a11y-card--tts">' +
          '<button type="button" class="a11y-tts-toggle" data-a11y-action="tts" aria-pressed="false">' +
            '<span class="a11y-card__title">Text to speech</span>' +
            '<span class="a11y-card__desc" data-a11y-tts-status>Enable hover to read</span>' +
          '</button>' +
          '<div class="a11y-tts-speeds" role="group" aria-label="Text to speech speed">' +
            '<button type="button" data-a11y-tts-speed="0.8">Slow</button>' +
            '<button type="button" data-a11y-tts-speed="1" aria-pressed="true">Normal</button>' +
            '<button type="button" data-a11y-tts-speed="1.2">Fast</button>' +
          '</div>' +
        '</div>' +

        card('reduce-motion', 'Reduce animations', 'Minimize motion effects.') +
        card('pause-autoplay', 'Pause auto-rotating content', 'Stops slideshows and carousels.') +
        card('text-size', 'Increase text size', 'Scale text slightly larger.') +
        card('letter-spacing', 'Increase letter spacing', 'Add space between letters.') +
        card('line-height', 'Increase line height', 'Add vertical spacing.') +
        card('dyslexia-font', 'Dyslexia-friendly font', 'Apply a clearer text font.') +
        card('invert-colors', 'Invert colors', 'Invert page colors.') +
        card('big-cursor', 'Big cursor', 'Increase cursor size.') +
        card('hide-images', 'Hide images', 'Reduce visual distractions.') +
      '</div>' +

      /* Footer */
      '<div class="a11y-panel__footer">' +
        '<label class="a11y-side-switch">' +
          '<input type="checkbox" data-a11y-side-switch>' +
          '<span>Switch widget to left</span>' +
        '</label>' +
        '<button type="button" class="a11y-panel__reset" data-a11y-reset>Reset</button>' +
      '</div>' +
    '</div>';
  }

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
      '<input type="checkbox" data-a11y-toggle="' + toggle + '">' +
    '</label>';
  }

  /* ---- Inject dialog element ---- */
  var dialog = document.createElement('dialog');
  dialog.id = 'accessibility-support';
  dialog.className = 'a11y-panel';
  dialog.setAttribute('aria-labelledby', 'accessibility-support-title');
  dialog.innerHTML = buildDialogHTML();
  document.body.appendChild(dialog);

  /* ---- References ---- */
  var closeBtn = dialog.querySelector('[data-a11y-close]');
  var supportsDialog = typeof dialog.showModal === 'function';
  var mainEl = document.querySelector('main');
  var focusTrapHandler = null;
  var keydownHandler = null;
  var lastFocusedElement = null;

  var reduceMotionInput = dialog.querySelector('[data-a11y-toggle="reduce-motion"]');
  var pauseAutoplayInput = dialog.querySelector('[data-a11y-toggle="pause-autoplay"]');
  var textSizeInput = dialog.querySelector('[data-a11y-toggle="text-size"]');
  var letterSpacingInput = dialog.querySelector('[data-a11y-toggle="letter-spacing"]');
  var lineHeightInput = dialog.querySelector('[data-a11y-toggle="line-height"]');
  var dyslexiaFontInput = dialog.querySelector('[data-a11y-toggle="dyslexia-font"]');
  var invertColorsInput = dialog.querySelector('[data-a11y-toggle="invert-colors"]');
  var readingModeInput = dialog.querySelector('[data-a11y-toggle="reading-mode"]');
  var highlightFocusInput = dialog.querySelector('[data-a11y-toggle="highlight-focus"]');
  var contrastInput = dialog.querySelector('[data-a11y-toggle="contrast"]');
  var bigCursorInput = dialog.querySelector('[data-a11y-toggle="big-cursor"]');
  var hideImagesInput = dialog.querySelector('[data-a11y-toggle="hide-images"]');
  var ttsButton = dialog.querySelector('[data-a11y-action="tts"]');
  var ttsStatus = dialog.querySelector('[data-a11y-tts-status]');
  var ttsSpeedButtons = Array.from(dialog.querySelectorAll('[data-a11y-tts-speed]'));
  var sideSwitch = dialog.querySelector('[data-a11y-side-switch]');
  var resetButton = dialog.querySelector('[data-a11y-reset]');
  var profileButtons = Array.from(dialog.querySelectorAll('[data-a11y-profile]'));

  var ttsActive = false;
  var ttsRate = 1;
  var hoverTimer = null;
  var lastSpoken = '';
  var lastSpokenTarget = null;

  /* ---- Settings state helpers ---- */
  function getSettingsState() {
    return {
      reduceMotion: !!(reduceMotionInput && reduceMotionInput.checked),
      pauseAutoplay: !!(pauseAutoplayInput && pauseAutoplayInput.checked),
      textSize: !!(textSizeInput && textSizeInput.checked),
      letterSpacing: !!(letterSpacingInput && letterSpacingInput.checked),
      lineHeight: !!(lineHeightInput && lineHeightInput.checked),
      dyslexiaFont: !!(dyslexiaFontInput && dyslexiaFontInput.checked),
      invertColors: !!(invertColorsInput && invertColorsInput.checked),
      readingMode: !!(readingModeInput && readingModeInput.checked),
      highlightFocus: !!(highlightFocusInput && highlightFocusInput.checked),
      contrastBoost: !!(contrastInput && contrastInput.checked),
      bigCursor: !!(bigCursorInput && bigCursorInput.checked),
      hideImages: !!(hideImagesInput && hideImagesInput.checked)
    };
  }

  function applySettingsState(s) {
    if (!s) return;
    if (reduceMotionInput) reduceMotionInput.checked = !!s.reduceMotion;
    if (pauseAutoplayInput) pauseAutoplayInput.checked = !!s.pauseAutoplay;
    if (textSizeInput) textSizeInput.checked = !!s.textSize;
    if (letterSpacingInput) letterSpacingInput.checked = !!s.letterSpacing;
    if (lineHeightInput) lineHeightInput.checked = !!s.lineHeight;
    if (dyslexiaFontInput) dyslexiaFontInput.checked = !!s.dyslexiaFont;
    if (invertColorsInput) invertColorsInput.checked = !!s.invertColors;
    if (readingModeInput) readingModeInput.checked = !!s.readingMode;
    if (highlightFocusInput) highlightFocusInput.checked = !!s.highlightFocus;
    if (contrastInput) contrastInput.checked = !!s.contrastBoost;
    if (bigCursorInput) bigCursorInput.checked = !!s.bigCursor;
    if (hideImagesInput) hideImagesInput.checked = !!s.hideImages;
    applyPreferences();
  }

  /* ---- Sync inputs from localStorage ---- */
  function syncInputsFromStorage() {
    try {
      var panelSide = window.localStorage.getItem('a11y-panel-side') || 'right';
      dialog.classList.toggle('a11y-panel--left', panelSide === 'left');
      if (sideSwitch) sideSwitch.checked = panelSide === 'left';

      var ttsStored = window.localStorage.getItem('a11y-tts-active') === 'true';
      setTtsState(ttsStored);
      if (ttsStored) enableHoverTts();

      if (reduceMotionInput) reduceMotionInput.checked = window.localStorage.getItem('a11y-reduce-motion') === 'true';
      if (pauseAutoplayInput) pauseAutoplayInput.checked = window.localStorage.getItem('a11y-pause-autoplay') === 'true';
      if (textSizeInput) textSizeInput.checked = window.localStorage.getItem('a11y-text-size') === 'true';
      if (letterSpacingInput) letterSpacingInput.checked = window.localStorage.getItem('a11y-letter-spacing') === 'true';
      if (lineHeightInput) lineHeightInput.checked = window.localStorage.getItem('a11y-line-height') === 'true';
      if (dyslexiaFontInput) dyslexiaFontInput.checked = window.localStorage.getItem('a11y-dyslexia-font') === 'true';
      if (invertColorsInput) invertColorsInput.checked = window.localStorage.getItem('a11y-invert-colors') === 'true';
      if (readingModeInput) readingModeInput.checked = window.localStorage.getItem('a11y-reading-mode') === 'true';
      if (highlightFocusInput) highlightFocusInput.checked = window.localStorage.getItem('a11y-highlight-focus') === 'true';
      if (contrastInput) contrastInput.checked = window.localStorage.getItem('a11y-contrast') === 'true';
      if (bigCursorInput) bigCursorInput.checked = window.localStorage.getItem('a11y-big-cursor') === 'true';
      if (hideImagesInput) hideImagesInput.checked = window.localStorage.getItem('a11y-hide-images') === 'true';

      var storedRate = parseFloat(window.localStorage.getItem('a11y-tts-rate') || '1');
      ttsRate = isNaN(storedRate) ? 1 : storedRate;
      ttsSpeedButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(parseFloat(btn.dataset.a11yTtsSpeed) === ttsRate));
      });

      var activeProfile = window.localStorage.getItem('a11y-profile') || '';
      profileButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', btn.dataset.a11yProfile === activeProfile ? 'true' : 'false');
      });
    } catch (e) { /* storage blocked */ }
  }

  /* ---- Apply preferences to <html> classes + save ---- */
  function applyPreferences() {
    try {
      var reduceMotion = !!(reduceMotionInput && reduceMotionInput.checked);
      var pauseAutoplay = !!(pauseAutoplayInput && pauseAutoplayInput.checked) || reduceMotion;
      var textSize = !!(textSizeInput && textSizeInput.checked);
      var letterSpacing = !!(letterSpacingInput && letterSpacingInput.checked);
      var lineHeight = !!(lineHeightInput && lineHeightInput.checked);
      var dyslexiaFont = !!(dyslexiaFontInput && dyslexiaFontInput.checked);
      var invertColors = !!(invertColorsInput && invertColorsInput.checked);
      var readingMode = !!(readingModeInput && readingModeInput.checked);
      var highlightFocus = !!(highlightFocusInput && highlightFocusInput.checked);
      var contrastBoost = !!(contrastInput && contrastInput.checked);
      var bigCursor = !!(bigCursorInput && bigCursorInput.checked);
      var hideImages = !!(hideImagesInput && hideImagesInput.checked);
      if (pauseAutoplayInput) pauseAutoplayInput.checked = pauseAutoplay;

      window.localStorage.setItem('a11y-reduce-motion', String(reduceMotion));
      window.localStorage.setItem('a11y-pause-autoplay', String(pauseAutoplay));
      window.localStorage.setItem('a11y-text-size', String(textSize));
      window.localStorage.setItem('a11y-letter-spacing', String(letterSpacing));
      window.localStorage.setItem('a11y-line-height', String(lineHeight));
      window.localStorage.setItem('a11y-dyslexia-font', String(dyslexiaFont));
      window.localStorage.setItem('a11y-invert-colors', String(invertColors));
      window.localStorage.setItem('a11y-reading-mode', String(readingMode));
      window.localStorage.setItem('a11y-highlight-focus', String(highlightFocus));
      window.localStorage.setItem('a11y-contrast', String(contrastBoost));
      window.localStorage.setItem('a11y-big-cursor', String(bigCursor));
      window.localStorage.setItem('a11y-hide-images', String(hideImages));

      var root = document.documentElement;
      root.classList.toggle('a11y-reduce-motion', reduceMotion);
      root.classList.toggle('a11y-pause-autoplay', pauseAutoplay);
      root.classList.toggle('a11y-text-size', textSize);
      root.classList.toggle('a11y-letter-spacing', letterSpacing);
      root.classList.toggle('a11y-line-height', lineHeight);
      root.classList.toggle('a11y-dyslexia-font', dyslexiaFont);
      root.classList.toggle('a11y-invert-colors', invertColors);
      root.classList.toggle('a11y-reading-mode', readingMode);
      root.classList.toggle('a11y-highlight-focus', highlightFocus);
      root.classList.toggle('a11y-contrast', contrastBoost);
      root.classList.toggle('a11y-big-cursor', bigCursor);
      root.classList.toggle('a11y-hide-images', hideImages);
    } catch (e) { /* ignore */ }
  }

  /* ---- TTS (Text-to-Speech) ---- */
  function setTtsState(active) {
    ttsActive = active;
    if (ttsButton) ttsButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (ttsStatus) ttsStatus.textContent = active ? 'Hover to read' : 'Enable hover to read';
  }

  function stopTts() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    window.localStorage.setItem('a11y-tts-active', 'false');
    setTtsState(false);
  }

  function speak(text, onEnd) {
    if (!('speechSynthesis' in window)) return;
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = ttsRate;
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function getLabelledText(element, attribute) {
    var ids = element.getAttribute && element.getAttribute(attribute);
    if (!ids) return '';
    return ids.split(/\s+/)
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean)
      .map(function (node) { return (node.textContent || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  function getSpeakableText(target) {
    if (!target || target.closest('#accessibility-support')) return '';
    var el = target;
    for (var i = 0; i < 3 && el; i++) {
      var labelledText = getLabelledText(el, 'aria-labelledby');
      if (labelledText) return labelledText;
      var describedText = getLabelledText(el, 'aria-describedby');
      if (describedText) return describedText;
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      var role = el.getAttribute && el.getAttribute('role');
      if ((el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link') && el.textContent) {
        return el.textContent.replace(/\s+/g, ' ').trim();
      }
      var title = el.getAttribute && el.getAttribute('title');
      if (title) return title;
      if (el.tagName === 'IMG' && el.alt) return el.alt;
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder) return el.placeholder;
      var nestedImg = el.querySelector && el.querySelector('img[alt]');
      if (nestedImg && nestedImg.alt) return nestedImg.alt;
      el = el.parentElement;
    }
    var text = target.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function handleHover(event) {
    if (!ttsActive) return;
    var text = getSpeakableText(event.target);
    if (!text) return;
    if (text === lastSpoken && event.target === lastSpokenTarget) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      lastSpoken = text;
      lastSpokenTarget = event.target;
      speak(text);
    }, 250);
  }

  function enableHoverTts() {
    document.addEventListener('mouseover', handleHover, true);
    document.addEventListener('focusin', handleHover, true);
  }

  function disableHoverTts() {
    document.removeEventListener('mouseover', handleHover, true);
    document.removeEventListener('focusin', handleHover, true);
  }

  function startTts() {
    if (!('speechSynthesis' in window)) return;
    setTtsState(true);
    enableHoverTts();
    window.localStorage.setItem('a11y-tts-active', 'true');
    speak('Text to speech enabled');
  }

  /* ---- Profiles ---- */
  function applyProfile(profileKey) {
    var presets = {
      motor: { highlightFocus: true, textSize: true, lineHeight: true },
      blind: { readingMode: true, highlightFocus: true, textSize: true, lineHeight: true, contrastBoost: true, reduceMotion: true, pauseAutoplay: true },
      color: { contrastBoost: true },
      dyslexia: { dyslexiaFont: true, letterSpacing: true, lineHeight: true, readingMode: true },
      visual: { textSize: true, contrastBoost: true, highlightFocus: true, lineHeight: true },
      cognitive: { readingMode: true, reduceMotion: true, pauseAutoplay: true, highlightFocus: true },
      seizure: { reduceMotion: true, pauseAutoplay: true },
      adhd: { reduceMotion: true, pauseAutoplay: true, highlightFocus: true }
    };

    var preset = presets[profileKey];
    if (!preset) return;

    var existingBackup = window.localStorage.getItem('a11y-profile-backup');
    if (!existingBackup) {
      window.localStorage.setItem('a11y-profile-backup', JSON.stringify(getSettingsState()));
    }

    if (readingModeInput) readingModeInput.checked = !!preset.readingMode;
    if (highlightFocusInput) highlightFocusInput.checked = !!preset.highlightFocus;
    if (contrastInput) contrastInput.checked = !!preset.contrastBoost;
    if (reduceMotionInput) reduceMotionInput.checked = !!preset.reduceMotion;
    if (pauseAutoplayInput) pauseAutoplayInput.checked = !!preset.pauseAutoplay;
    if (textSizeInput) textSizeInput.checked = !!preset.textSize;
    if (letterSpacingInput) letterSpacingInput.checked = !!preset.letterSpacing;
    if (lineHeightInput) lineHeightInput.checked = !!preset.lineHeight;
    if (dyslexiaFontInput) dyslexiaFontInput.checked = !!preset.dyslexiaFont;
    if (invertColorsInput) invertColorsInput.checked = !!preset.invertColors;
    if (bigCursorInput) bigCursorInput.checked = !!preset.bigCursor;
    if (hideImagesInput) hideImagesInput.checked = !!preset.hideImages;

    window.localStorage.setItem('a11y-profile', profileKey);
    profileButtons.forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.a11yProfile === profileKey ? 'true' : 'false');
    });
    applyPreferences();
  }

  /* ---- Open / Close (non-modal: background stays scrollable) ---- */
  function closeDialog() {
    if (supportsDialog) {
      try { dialog.close(); } catch (e) {}
    }
    dialog.classList.remove('is-open');
    dialog.removeAttribute('aria-modal');
    if (focusTrapHandler) dialog.removeEventListener('keydown', focusTrapHandler);
    if (keydownHandler) dialog.removeEventListener('keydown', keydownHandler);
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
  }

  function openDialog() {
    syncInputsFromStorage();
    lastFocusedElement = document.activeElement;

    if (supportsDialog) {
      /* Use show() (non-modal) so background remains scrollable */
      dialog.show();
    } else {
      dialog.classList.add('is-open');
      dialog.setAttribute('open', '');
    }

    /* Focus trap for keyboard accessibility */
    if (!focusTrapHandler) {
      focusTrapHandler = function (e) {
        if (e.key !== 'Tab') return;
        var focusable = dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      };
    }
    if (!keydownHandler) {
      keydownHandler = function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeDialog();
        }
      };
    }
    dialog.addEventListener('keydown', focusTrapHandler);
    dialog.addEventListener('keydown', keydownHandler);

    var firstInput = dialog.querySelector('input, button');
    if (firstInput) firstInput.focus();
  }

  /* ---- Public API ---- */
  window.A11yWidget = { open: openDialog, close: closeDialog };
  window.EverlyA11y = window.EverlyA11y || {};
  window.EverlyA11y.open = openDialog;

  /* ---- Intercept footer link clicks ---- */
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a');
    if (link) {
      var text = (link.textContent || '').trim().toLowerCase();
      if (
        text === 'accessibility support' ||
        text === 'accessibility statement' ||
        text === 'accessibility'
      ) {
        e.preventDefault();
        openDialog();
        return;
      }
    }
    /* Also support data-a11y-open attribute */
    var trigger = e.target.closest('[data-a11y-open]');
    if (trigger) {
      e.preventDefault();
      openDialog();
    }
  });

  /* ---- Close button ---- */
  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      closeDialog();
    });
  }

  /* ---- Click outside to close (non-modal fallback) ---- */
  document.addEventListener('click', function (e) {
    if (!dialog.hasAttribute('open')) return;
    if (dialog.contains(e.target)) return;
    /* Don't close if clicking the trigger link */
    var link = e.target.closest('a');
    if (link) {
      var text = (link.textContent || '').trim().toLowerCase();
      if (text.indexOf('accessibility') !== -1) return;
    }
    var trigger = e.target.closest('[data-a11y-open]');
    if (trigger) return;
    closeDialog();
  });

  /* ---- Wire up all toggle inputs ---- */
  var allToggles = [
    reduceMotionInput, pauseAutoplayInput, textSizeInput, letterSpacingInput,
    lineHeightInput, dyslexiaFontInput, invertColorsInput, readingModeInput,
    highlightFocusInput, contrastInput, bigCursorInput, hideImagesInput
  ];
  allToggles.forEach(function (input) {
    if (input) input.addEventListener('change', applyPreferences);
  });

  /* ---- TTS button ---- */
  if (ttsButton) {
    ttsButton.addEventListener('click', function () {
      if (ttsActive) {
        stopTts();
        disableHoverTts();
      } else {
        startTts();
      }
    });
  }

  /* ---- TTS speed buttons ---- */
  ttsSpeedButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      ttsRate = parseFloat(btn.dataset.a11yTtsSpeed) || 1;
      window.localStorage.setItem('a11y-tts-rate', String(ttsRate));
      ttsSpeedButtons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
      if (ttsActive) speak('Speech rate updated');
    });
  });

  /* ---- Side switch ---- */
  if (sideSwitch) {
    sideSwitch.addEventListener('change', function () {
      var isLeft = sideSwitch.checked;
      dialog.classList.toggle('a11y-panel--left', isLeft);
      window.localStorage.setItem('a11y-panel-side', isLeft ? 'left' : 'right');
    });
  }

  /* ---- Reset button ---- */
  if (resetButton) {
    resetButton.addEventListener('click', function () {
      var keys = [
        'a11y-reduce-motion', 'a11y-pause-autoplay', 'a11y-text-size', 'a11y-letter-spacing',
        'a11y-line-height', 'a11y-dyslexia-font', 'a11y-invert-colors', 'a11y-reading-mode',
        'a11y-highlight-focus', 'a11y-contrast', 'a11y-big-cursor', 'a11y-hide-images',
        'a11y-tts-rate', 'a11y-tts-active', 'a11y-profile', 'a11y-profile-backup', 'a11y-panel-side'
      ];
      keys.forEach(function (key) { window.localStorage.removeItem(key); });

      if (sideSwitch) sideSwitch.checked = false;
      dialog.classList.remove('a11y-panel--left');

      profileButtons.forEach(function (btn) { btn.setAttribute('aria-pressed', 'false'); });

      allToggles.forEach(function (input) {
        if (input) input.checked = false;
      });

      ttsSpeedButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.a11yTtsSpeed === '1'));
      });
      ttsRate = 1;

      if (ttsActive) {
        stopTts();
        disableHoverTts();
      }

      applyPreferences();
    });
  }

  /* ---- Profile buttons ---- */
  profileButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.dataset.a11yProfile;
      var activeProfile = window.localStorage.getItem('a11y-profile') || '';

      if (activeProfile === key) {
        /* Deactivate profile — restore backup */
        var backupRaw = window.localStorage.getItem('a11y-profile-backup');
        window.localStorage.removeItem('a11y-profile');
        window.localStorage.removeItem('a11y-profile-backup');
        profileButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });

        if (backupRaw) {
          try { applySettingsState(JSON.parse(backupRaw)); } catch (e) { applyPreferences(); }
        } else {
          applySettingsState({
            reduceMotion: false, pauseAutoplay: false, textSize: false, letterSpacing: false,
            lineHeight: false, dyslexiaFont: false, invertColors: false, readingMode: false,
            highlightFocus: false, contrastBoost: false, bigCursor: false, hideImages: false
          });
        }
        return;
      }

      applyProfile(key);
    });
  });

  /* ---- Initialize: apply saved settings immediately ---- */
  syncInputsFromStorage();
  applyPreferences();
})();
