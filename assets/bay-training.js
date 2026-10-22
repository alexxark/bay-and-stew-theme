(() => {
  const SECTION_SELECTOR = '.js-bay-training-course';
  const MOBILE_BREAKPOINT = 990;
  const MUX_PLAYER_SCRIPT_ID = 'bay-training-mux-player-loader';
  const MUX_PLAYER_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/@mux/mux-player';

  if (window.BayTrainingCourseManager) {
    window.BayTrainingCourseManager.initAll(document);
    return;
  }

  const toBoolean = (value) => String(value) === 'true';

  const isFiniteNumber = (value) => Number.isFinite(value) && !Number.isNaN(value);

  const safeParseJSON = (jsonText, fallbackValue = []) => {
    try {
      const parsed = JSON.parse(jsonText);
      return Array.isArray(parsed) ? parsed : fallbackValue;
    } catch (error) {
      console.warn('[Bay Training] Unable to parse lesson JSON.', error);
      return fallbackValue;
    }
  };

  let muxScriptPromise;

  const ensureMuxPlayerLoaded = () => {
    if (customElements.get('mux-player')) return Promise.resolve();
    if (muxScriptPromise) return muxScriptPromise;

    muxScriptPromise = new Promise((resolve, reject) => {
      const existingScript = document.getElementById(MUX_PLAYER_SCRIPT_ID);
      if (existingScript) {
        existingScript.addEventListener('load', resolve, { once: true });
        existingScript.addEventListener(
          'error',
          () => reject(new Error('Mux Player script failed to load.')),
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.id = MUX_PLAYER_SCRIPT_ID;
      script.type = 'module';
      script.src = MUX_PLAYER_SCRIPT_SRC;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener(
        'error',
        () => reject(new Error('Mux Player script failed to load.')),
        { once: true }
      );
      document.head.appendChild(script);
    }).catch((error) => {
      muxScriptPromise = null;
      throw error;
    });

    return muxScriptPromise;
  };

  class TrainingCourseSection {
    constructor(section) {
      this.section = section;
      this.sectionId = section.dataset.sectionId || section.id || '';
      this.courseKey = section.dataset.courseKey || this.sectionId || 'default-course';
      this.progressEnabled = toBoolean(section.dataset.enableProgress);
      this.lessons = this.parseLessons();
      this.selectedIndex = 0;
      this.completedLessons = new Set();
      this.storageKey = `bs-training-progress::${this.courseKey}`;
      this.storageUnavailable = false;
      this.isDestroyed = false;

      this.sidebarElement = this.section.querySelector('.js-bay-training-sidebar');
      this.playerElement = this.section.querySelector('.js-bay-training-player');
      this.playerStateElement = this.section.querySelector('.js-bay-training-player-state');
      this.lessonTitleElement = this.section.querySelector('.js-bay-training-lesson-title');
      this.lessonDescriptionElement = this.section.querySelector('.js-bay-training-lesson-description');
      this.lessonPositionElement = this.section.querySelector('.js-bay-training-lesson-position');
      this.progressTextElement = this.section.querySelector('.js-bay-training-progress-text');
      this.progressBarElement = this.section.querySelector('.js-bay-training-progress-bar');
      this.completeButtonElement = this.section.querySelector('.js-bay-training-complete-toggle');
      this.storageNoteElement = this.section.querySelector('.js-bay-training-storage-note');
      this.liveRegionElement = this.section.querySelector('.js-bay-training-live-region');
      this.previousButtonElement = this.section.querySelector('.js-bay-training-prev');
      this.nextButtonElement = this.section.querySelector('.js-bay-training-next');
      this.navToggleButtonElement = this.section.querySelector('.js-bay-training-nav-toggle');
      this.lessonListScrollElement = this.section.querySelector('.js-bay-training-lesson-scroll');
      this.lessonButtons = Array.from(this.section.querySelectorAll('[data-lesson-select]'));
      this.lessonItems = Array.from(this.section.querySelectorAll('[data-lesson-item]'));

      if (this.lessons.length === 0) return;

      if (this.progressEnabled) this.loadProgressFromStorage();
      this.bindEvents();

      ensureMuxPlayerLoaded().catch((error) => {
        console.warn('[Bay Training] Mux player script was not loaded.', error);
        this.setPlayerState('Video player failed to load. Please refresh and try again.');
      });

      this.updateSidebarForViewport(true);
      this.renderCurrentLesson({ announce: false, focusLesson: false });
      this.updateProgressUI();
    }

    parseLessons() {
      const lessonDataElement = this.section.querySelector('[data-training-lessons]');
      if (!lessonDataElement) return [];

      const rawLessons = safeParseJSON(lessonDataElement.textContent || '[]', []);

      return rawLessons.map((lesson, index) => {
        const title = typeof lesson.title === 'string' && lesson.title.trim() ? lesson.title.trim() : `Lesson ${index + 1}`;
        const description =
          typeof lesson.description === 'string' ? lesson.description.trim() : '';
        const playbackId =
          typeof lesson.playbackId === 'string' ? lesson.playbackId.trim() : '';
        const durationLabel =
          typeof lesson.durationLabel === 'string' ? lesson.durationLabel.trim() : '';
        const lessonId = lesson.id != null ? String(lesson.id) : `lesson-${index}`;

        return {
          id: lessonId,
          title,
          description,
          playbackId,
          durationLabel,
          durationSeconds: isFiniteNumber(Number(lesson.durationSeconds))
            ? Number(lesson.durationSeconds)
            : null,
        };
      });
    }

    bindEvents() {
      this.boundLessonSelectHandler = (event) => {
        const button = event.target.closest('[data-lesson-select]');
        if (!button || !this.section.contains(button)) return;

        const index = Number(button.dataset.index);
        if (!isFiniteNumber(index)) return;
        this.selectLesson(index, { announce: true, focusLesson: false });
      };

      this.boundPagerHandler = (event) => {
        const button = event.currentTarget;
        if (button.dataset.action === 'prev') {
          this.selectLesson(this.selectedIndex - 1, { announce: true, focusLesson: true });
        }

        if (button.dataset.action === 'next') {
          this.selectLesson(this.selectedIndex + 1, { announce: true, focusLesson: true });
        }
      };

      this.boundCompleteToggleHandler = () => this.toggleCurrentLessonCompletion();
      this.boundNavToggleHandler = () => this.toggleMobileNavigation();
      this.boundResizeHandler = () => this.updateSidebarForViewport(false);
      this.boundPlayerErrorHandler = () =>
        this.setPlayerState('Video playback failed for this lesson. Please verify the Mux playback ID.');
      this.boundPlayerEndedHandler = () => this.handlePlayerEnded();

      this.section.addEventListener('click', this.boundLessonSelectHandler);

      if (this.previousButtonElement) {
        this.previousButtonElement.addEventListener('click', this.boundPagerHandler);
      }

      if (this.nextButtonElement) {
        this.nextButtonElement.addEventListener('click', this.boundPagerHandler);
      }

      if (this.completeButtonElement) {
        this.completeButtonElement.addEventListener('click', this.boundCompleteToggleHandler);
      }

      if (this.navToggleButtonElement) {
        this.navToggleButtonElement.addEventListener('click', this.boundNavToggleHandler);
      }

      if (this.playerElement) {
        this.playerElement.addEventListener('error', this.boundPlayerErrorHandler);
        this.playerElement.addEventListener('ended', this.boundPlayerEndedHandler);
      }

      window.addEventListener('resize', this.boundResizeHandler);
    }

    updateSidebarForViewport(isInitialRender) {
      if (!this.sidebarElement || !this.navToggleButtonElement) return;

      if (window.innerWidth >= MOBILE_BREAKPOINT) {
        this.sidebarElement.classList.remove('is-collapsed');
        this.navToggleButtonElement.setAttribute('aria-expanded', 'true');
        return;
      }

      if (isInitialRender) {
        this.sidebarElement.classList.add('is-collapsed');
        this.navToggleButtonElement.setAttribute('aria-expanded', 'false');
      }
    }

    toggleMobileNavigation() {
      if (!this.sidebarElement || !this.navToggleButtonElement) return;
      const isCollapsed = this.sidebarElement.classList.toggle('is-collapsed');
      this.navToggleButtonElement.setAttribute('aria-expanded', String(!isCollapsed));
    }

    selectLesson(index, options = {}) {
      if (this.lessons.length === 0) return;

      const clampedIndex = Math.min(Math.max(index, 0), this.lessons.length - 1);
      if (clampedIndex === this.selectedIndex && !options.force) return;

      this.stopCurrentPlayback();
      this.selectedIndex = clampedIndex;
      this.renderCurrentLesson({
        announce: options.announce !== false,
        focusLesson: options.focusLesson === true,
      });
      this.updateProgressUI();
    }

    renderCurrentLesson({ announce, focusLesson }) {
      const lesson = this.lessons[this.selectedIndex];
      if (!lesson) return;

      if (this.lessonTitleElement) this.lessonTitleElement.textContent = lesson.title;
      if (this.lessonDescriptionElement) {
        this.lessonDescriptionElement.textContent =
          lesson.description || 'No lesson description has been added yet.';
      }

      if (this.lessonPositionElement) {
        this.lessonPositionElement.textContent = `Lesson ${this.selectedIndex + 1} of ${this.lessons.length}`;
      }

      this.updatePlayerForLesson(lesson);
      this.updateLessonSelectionUI({ focusLesson });
      this.updatePagerButtons();
      this.updateCompleteButtonLabel();

      if (announce) {
        this.announce(`Now viewing ${lesson.title}. Lesson ${this.selectedIndex + 1} of ${this.lessons.length}.`);
      }
    }

    updatePlayerForLesson(lesson) {
      if (!this.playerElement) return;

      const playbackId = lesson.playbackId || '';
      if (!playbackId) {
        this.playerElement.hidden = true;
        this.playerElement.removeAttribute('playback-id');
        this.setPlayerState('This lesson does not yet have a video playback ID.');
        return;
      }

      this.playerElement.hidden = false;
      this.clearPlayerState();

      if (this.playerElement.getAttribute('playback-id') !== playbackId) {
        this.playerElement.setAttribute('playback-id', playbackId);
      }

      this.playerElement.setAttribute('title', lesson.title);
      this.playerElement.setAttribute('metadata-video-title', lesson.title);
    }

    stopCurrentPlayback() {
      if (!this.playerElement || this.playerElement.hidden) return;

      try {
        if (typeof this.playerElement.pause === 'function') {
          this.playerElement.pause();
        }

        if ('currentTime' in this.playerElement) {
          this.playerElement.currentTime = 0;
        }
      } catch (error) {
        console.warn('[Bay Training] Unable to stop previous lesson playback cleanly.', error);
      }
    }

    setPlayerState(message) {
      if (!this.playerStateElement) return;
      this.playerStateElement.textContent = message;
      this.playerStateElement.hidden = false;
    }

    clearPlayerState() {
      if (!this.playerStateElement) return;
      this.playerStateElement.hidden = true;
      this.playerStateElement.textContent = '';
    }

    updateLessonSelectionUI({ focusLesson }) {
      this.lessonButtons.forEach((button, index) => {
        const isCurrent = index === this.selectedIndex;
        button.classList.toggle('is-active', isCurrent);
        if (isCurrent) {
          button.setAttribute('aria-current', 'true');
        } else {
          button.removeAttribute('aria-current');
        }
      });

      this.lessonItems.forEach((item, index) => {
        item.classList.toggle('is-active', index === this.selectedIndex);
      });

      this.ensureActiveLessonVisible();

      if (focusLesson) {
        const activeButton = this.lessonButtons[this.selectedIndex];
        if (activeButton) activeButton.focus();
      }
    }

    ensureActiveLessonVisible() {
      const activeButton = this.lessonButtons[this.selectedIndex];
      const scrollContainer = this.lessonListScrollElement;

      if (!activeButton || !scrollContainer) return;
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + 1) return;

      const activeRect = activeButton.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const inset = 8;
      const elementTop = activeRect.top - containerRect.top + scrollContainer.scrollTop;
      const elementBottom = elementTop + activeRect.height;
      const viewTop = scrollContainer.scrollTop;
      const viewBottom = viewTop + scrollContainer.clientHeight;

      if (elementTop < viewTop + inset) {
        scrollContainer.scrollTop = Math.max(0, elementTop - inset);
      } else if (elementBottom > viewBottom - inset) {
        scrollContainer.scrollTop = Math.max(0, elementBottom - scrollContainer.clientHeight + inset);
      }
    }

    updatePagerButtons() {
      if (this.previousButtonElement) {
        this.previousButtonElement.disabled = this.selectedIndex <= 0;
      }

      if (this.nextButtonElement) {
        this.nextButtonElement.disabled = this.selectedIndex >= this.lessons.length - 1;
      }
    }

    loadProgressFromStorage() {
      try {
        const rawValue = window.localStorage.getItem(this.storageKey);
        if (!rawValue) return;

        const parsedValue = JSON.parse(rawValue);
        if (!Array.isArray(parsedValue)) return;

        const validLessonIds = new Set(this.lessons.map((lesson) => lesson.id));
        parsedValue.forEach((lessonId) => {
          const normalizedId = String(lessonId);
          if (validLessonIds.has(normalizedId)) {
            this.completedLessons.add(normalizedId);
          }
        });
      } catch (error) {
        this.storageUnavailable = true;
        console.warn('[Bay Training] Unable to read course progress from localStorage.', error);
      }
    }

    persistProgressToStorage() {
      if (!this.progressEnabled || this.storageUnavailable) return;

      try {
        window.localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.completedLessons)));
      } catch (error) {
        this.storageUnavailable = true;
        console.warn('[Bay Training] Unable to persist course progress to localStorage.', error);
      }
    }

    toggleCurrentLessonCompletion() {
      if (!this.progressEnabled || this.lessons.length === 0) return;
      const lesson = this.lessons[this.selectedIndex];
      if (!lesson) return;

      if (this.completedLessons.has(lesson.id)) {
        this.completedLessons.delete(lesson.id);
        this.announce(`Marked ${lesson.title} as incomplete.`);
        this.persistProgressToStorage();
        this.updateProgressUI();
        return;
      }

      this.markLessonComplete(lesson, { announce: true });
    }

    markLessonComplete(lesson, options = {}) {
      if (!this.progressEnabled || !lesson) return false;
      if (this.completedLessons.has(lesson.id)) return false;

      this.completedLessons.add(lesson.id);
      this.persistProgressToStorage();
      this.updateProgressUI();

      if (options.announce !== false) {
        this.announce(`Marked ${lesson.title} as complete.`);
      }

      return true;
    }

    handlePlayerEnded() {
      if (!this.progressEnabled || !this.playerElement) return;

      const lesson = this.lessons[this.selectedIndex];
      if (!lesson || !lesson.playbackId) return;

      const activePlaybackId = (this.playerElement.getAttribute('playback-id') || '').trim();
      if (!activePlaybackId || activePlaybackId !== lesson.playbackId) return;

      this.markLessonComplete(lesson, { announce: true });
    }

    updateProgressUI() {
      if (!this.progressEnabled) return;

      const totalLessons = this.lessons.length;
      const completedLessons = this.completedLessons.size;
      const completionPercentage =
        totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

      this.lessonItems.forEach((item) => {
        const lessonId = item.dataset.lessonId || '';
        item.classList.toggle('is-complete', this.completedLessons.has(lessonId));
      });

      if (this.progressTextElement) {
        this.progressTextElement.textContent = `${completionPercentage}% complete (${completedLessons}/${totalLessons})`;
      }

      if (this.progressBarElement) {
        this.progressBarElement.style.width = `${completionPercentage}%`;
      }

      if (this.storageNoteElement) {
        this.storageNoteElement.hidden = !this.storageUnavailable;
      }

      this.updateCompleteButtonLabel();
    }

    updateCompleteButtonLabel() {
      if (!this.completeButtonElement || !this.progressEnabled) return;

      const lesson = this.lessons[this.selectedIndex];
      if (!lesson) return;

      const isCompleted = this.completedLessons.has(lesson.id);
      this.completeButtonElement.textContent = isCompleted ? 'Undo Completion' : 'Mark Complete';
      this.completeButtonElement.setAttribute('aria-pressed', String(isCompleted));
    }

    announce(message) {
      if (!this.liveRegionElement) return;
      this.liveRegionElement.textContent = '';
      window.requestAnimationFrame(() => {
        this.liveRegionElement.textContent = message;
      });
    }

    destroy() {
      if (this.isDestroyed) return;
      this.isDestroyed = true;

      this.section.removeEventListener('click', this.boundLessonSelectHandler);
      window.removeEventListener('resize', this.boundResizeHandler);

      if (this.previousButtonElement) {
        this.previousButtonElement.removeEventListener('click', this.boundPagerHandler);
      }

      if (this.nextButtonElement) {
        this.nextButtonElement.removeEventListener('click', this.boundPagerHandler);
      }

      if (this.completeButtonElement) {
        this.completeButtonElement.removeEventListener('click', this.boundCompleteToggleHandler);
      }

      if (this.navToggleButtonElement) {
        this.navToggleButtonElement.removeEventListener('click', this.boundNavToggleHandler);
      }

      if (this.playerElement) {
        this.playerElement.removeEventListener('error', this.boundPlayerErrorHandler);
        this.playerElement.removeEventListener('ended', this.boundPlayerEndedHandler);
      }
    }
  }

  class BayTrainingCourseManager {
    constructor() {
      this.instances = new Map();

      this.onSectionLoad = this.onSectionLoad.bind(this);
      this.onSectionUnload = this.onSectionUnload.bind(this);
    }

    initAll(root = document) {
      const sections = root.querySelectorAll(SECTION_SELECTOR);
      sections.forEach((section) => this.initSection(section));
    }

    initSection(sectionElement) {
      if (!sectionElement) return;
      const sectionId = sectionElement.dataset.sectionId || sectionElement.id;
      if (!sectionId || this.instances.has(sectionId)) return;

      const instance = new TrainingCourseSection(sectionElement);
      this.instances.set(sectionId, instance);
    }

    destroySection(sectionId, fallbackElement) {
      if (!sectionId && fallbackElement) {
        sectionId = fallbackElement.dataset.sectionId || fallbackElement.id;
      }

      if (!sectionId || !this.instances.has(sectionId)) return;
      const instance = this.instances.get(sectionId);
      instance.destroy();
      this.instances.delete(sectionId);
    }

    onSectionLoad(event) {
      const sectionId = event.detail && event.detail.sectionId;
      if (!sectionId) return;
      const sectionElement = document.getElementById(`shopify-section-${sectionId}`);
      if (!sectionElement) return;
      this.initSection(sectionElement.querySelector(SECTION_SELECTOR));
    }

    onSectionUnload(event) {
      const sectionId = event.detail && event.detail.sectionId;
      const fallbackElement =
        event.target && typeof event.target.closest === 'function'
          ? event.target.closest(SECTION_SELECTOR)
          : null;
      this.destroySection(sectionId, fallbackElement);
    }

    attachListeners() {
      document.addEventListener('shopify:section:load', this.onSectionLoad);
      document.addEventListener('shopify:section:unload', this.onSectionUnload);
    }
  }

  window.BayTrainingCourseManager = new BayTrainingCourseManager();
  window.BayTrainingCourseManager.attachListeners();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.BayTrainingCourseManager.initAll(document), {
      once: true,
    });
  } else {
    window.BayTrainingCourseManager.initAll(document);
  }
})();
