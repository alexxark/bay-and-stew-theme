const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const bayTrainingScript = fs.readFileSync(
  path.join(__dirname, '../assets/bay-training.js'),
  'utf8'
);

function createCourseHarness() {
  const thumbnailOne = 'https://cdn.shopify.com/s/files/1/0000/0001/files/module-1.jpg?v=1';
  const thumbnailTwo = 'https://cdn.shopify.com/s/files/1/0000/0001/files/module-2.jpg?v=1';

  const dom = new JSDOM(
    `
      <div id="shopify-section-test-course">
        <section
          class="bay-training-course js-bay-training-course bay-training-course--progress-enabled"
          data-section-id="test-course"
          data-course-key="test-course"
          data-enable-progress="true"
        >
          <mux-player class="js-bay-training-player" playback-id="playback-1"></mux-player>
          <div class="js-bay-training-player-state" hidden></div>
          <p class="js-bay-training-lesson-position"></p>
          <h3 class="js-bay-training-lesson-title"></h3>
          <p class="js-bay-training-lesson-description"></p>
          <p class="js-bay-training-progress-text"></p>
          <span class="js-bay-training-progress-bar"></span>
          <button type="button" class="js-bay-training-complete-toggle"></button>
          <p class="js-bay-training-storage-note" hidden></p>
          <p class="js-bay-training-live-region"></p>
          <button type="button" class="js-bay-training-prev" data-action="prev"></button>
          <button type="button" class="js-bay-training-next" data-action="next"></button>
          <button type="button" class="js-bay-training-nav-toggle" aria-expanded="false"></button>
          <aside class="js-bay-training-sidebar is-collapsed"></aside>
          <div class="js-bay-training-lesson-scroll">
            <ul>
              <li data-lesson-item data-lesson-id="lesson-1">
                <button type="button" data-lesson-select data-index="0" data-lesson-id="lesson-1"></button>
              </li>
              <li data-lesson-item data-lesson-id="lesson-2">
                <button type="button" data-lesson-select data-index="1" data-lesson-id="lesson-2"></button>
              </li>
              <li data-lesson-item data-lesson-id="lesson-3">
                <button type="button" data-lesson-select data-index="2" data-lesson-id="lesson-3"></button>
              </li>
            </ul>
          </div>
          <script type="application/json" data-training-lessons>
            [
              {"id":"lesson-1","title":"Lesson 1","description":"One","playbackId":"playback-1","thumbnailUrl":"${thumbnailOne}","durationLabel":"1:00","durationSeconds":60,"order":1},
              {"id":"lesson-2","title":"Lesson 2","description":"Two","playbackId":"playback-2","thumbnailUrl":"${thumbnailTwo}","durationLabel":"2:00","durationSeconds":120,"order":2},
              {"id":"lesson-3","title":"Lesson 3","description":"Three","playbackId":"playback-3","thumbnailUrl":"","durationLabel":"3:00","durationSeconds":180,"order":3}
            ]
          </script>
        </section>
      </div>
    `,
    {
      url: 'https://example.test',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    }
  );

  const { window } = dom;

  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  window.cancelAnimationFrame = () => {};

  class MockMuxPlayer extends window.HTMLElement {
    constructor() {
      super();
      this.currentTime = 0;
      this.duration = 300;
      this.ended = false;
    }

    pause() {}
  }

  window.customElements.define('mux-player', MockMuxPlayer);
  window.eval(bayTrainingScript);
  window.BayTrainingCourseManager.initAll(window.document);

  const instance = window.BayTrainingCourseManager.instances.get('test-course');
  const player = window.document.querySelector('.js-bay-training-player');

  return {
    dom,
    window,
    instance,
    player,
    thumbnailOne,
    thumbnailTwo,
  };
}

test('training course keeps distinct posters per lesson and clears when missing', () => {
  const harness = createCourseHarness();
  const { instance, player, thumbnailOne, thumbnailTwo } = harness;

  assert.ok(instance, 'training section instance should initialize');
  const thumbnailUrls = Array.from(instance.lessons, (lesson) => lesson.thumbnailUrl);
  assert.deepEqual(thumbnailUrls, [thumbnailOne, thumbnailTwo, '']);

  assert.equal(player.getAttribute('playback-id'), 'playback-1');
  assert.equal(player.getAttribute('poster'), thumbnailOne);

  instance.selectLesson(1, { announce: false, focusLesson: false });
  assert.equal(player.getAttribute('playback-id'), 'playback-2');
  assert.equal(player.getAttribute('poster'), thumbnailTwo);

  instance.selectLesson(2, { announce: false, focusLesson: false });
  assert.equal(player.getAttribute('playback-id'), 'playback-3');
  assert.equal(player.hasAttribute('poster'), false);

  instance.selectLesson(0, { announce: false, focusLesson: false });
  assert.equal(player.getAttribute('playback-id'), 'playback-1');
  assert.equal(player.getAttribute('poster'), thumbnailOne);

  instance.destroy();
  harness.dom.window.close();
});
