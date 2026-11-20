import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A self-contained local Instagram Story fixture for real-Playwright
 * integration tests. It mirrors the verified live DOM shape:
 *
 *   header Create (+) immediately left of Notifications
 *   -> role=dialog with Post + Story role=button rows
 *   -> native filechooser
 *   -> /create/story/ editor with a 1170×2532 canvas
 *   -> bottom-bar button "Add to your story".
 *
 * It intentionally contains no Instagram code or network calls.
 */

export const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nO3NQQEAAATAQATRP5QwSvC7BdjldMdn9XoHAAAAAAAAAAAAhy3SgAFYpLG4gwAAAABJRU5ErkJggg==';

/**
 * @param {string} filePath
 * @returns {Promise<string>} filePath
 */
export async function writeRedPng(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(RED_PNG_BASE64, 'base64'));
  return filePath;
}

export function storyFixtureHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instagram Story Fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #000; color: #fff; font-family: sans-serif; }
    #header { position: fixed; top: 0; left: 0; right: 0; height: 52px; display: flex; align-items: center; justify-content: flex-end; gap: 14px; padding: 0 10px; z-index: 20; background: #000; }
    #plus { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; color: #fff; }
    #notifications { width: 24px; height: 24px; }
    #feed { padding-top: 70px; }
    #menu { display: none; position: fixed; top: 48px; right: 10px; width: 150px; background: #1c1c1c; border: 1px solid #333; z-index: 30; }
    #menu [role="button"] { padding: 12px; }
    #editor { display: none; position: fixed; inset: 0; background: #000; z-index: 40; }
    #preview { position: absolute; inset: 0; width: 100%; height: 100%; }
    #close { position: absolute; top: 8px; left: 8px; width: 44px; height: 44px; z-index: 50; }
    #ai { position: absolute; top: 8px; right: 8px; width: 44px; height: 44px; z-index: 50; }
    #share { position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%); height: 44px; min-width: 160px; z-index: 50; }
    #rotate, #shareTextOnly { display: none; position: absolute; top: 40%; left: 0; right: 0; text-align: center; z-index: 60; }
    #file { display: none; }
  </style>
</head>
<body>
  <header id="header">
    <a id="plus" href="#" aria-label="Home">
      <svg aria-label="Home" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 11h-8V3h-2v8H3v2h8v8h2v-8h8z"></path>
      </svg>
    </a>
    <svg id="notifications" aria-label="Notifications" width="24" height="24" viewBox="0 0 24 24">
      <path d="M12 2a7 7 0 0 0-7 7v3l-2 3v1h18v-1l-2-3V9a7 7 0 0 0-7-7z"></path>
    </svg>
  </header>
  <main id="feed">Feed</main>
  <div id="menu" role="dialog" aria-modal="true">
    <div id="postOption" role="button" tabindex="0">Post</div>
    <div id="storyOption" role="button" tabindex="0">Story</div>
  </div>
  <input id="file" type="file" accept="image/*">
  <div id="editor">
    <canvas id="preview" width="1170" height="2532"></canvas>
    <button id="close">Close</button>
    <button id="ai">Add AI label</button>
    <button id="share">Add to your story</button>
    <p id="rotate">Rotate your device to add to your story.</p>
    <p id="shareTextOnly">Add to your story</p>
  </div>
  <script>
    (function () {
      const $ = (id) => document.getElementById(id);
      let suppressChooser = false;
      const fixture = {
        hidePlus() { $('plus').style.display = 'none'; },
        removeStoryOption() { $('storyOption').remove(); },
        suppressChooser() { suppressChooser = true; },
        showRotate() { $('rotate').style.display = 'block'; },
        showTextOnly() { $('shareTextOnly').style.display = 'block'; $('share').style.display = 'none'; },
        hideShare() { $('share').style.display = 'none'; },
        paintBlue() {
          const canvas = $('preview');
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#2060ff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        },
        hideCanvas() { $('preview').style.display = 'none'; },
        showOnboardingModals() {
          const makeOverlay = (label, onClick) => {
            const overlay = document.createElement('div');
            overlay.className = 'fixture-onboarding';
            overlay.style.cssText =
              'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';
            const dialog = document.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.style.cssText =
              'background:#fff;color:#000;padding:24px;border-radius:12px;min-width:240px;text-align:center;';
            const title = document.createElement('p');
            title.textContent =
              label === 'OK'
                ? 'The messaging tab has a new look'
                : 'Save your login info?';
            const button = document.createElement('button');
            button.textContent = label;
            button.style.cssText = 'margin-top:16px;padding:10px 20px;';
            button.addEventListener('click', onClick);
            dialog.appendChild(title);
            dialog.appendChild(button);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            return overlay;
          };
          const first = makeOverlay('OK', () => {
            first.remove();
            setTimeout(() => {
              makeOverlay('Not now', (event) => {
                event.currentTarget.closest('.fixture-onboarding')?.remove();
              });
            }, 150);
          });
        },
        reset() {
          $('plus').style.display = '';
          $('menu').style.display = 'none';
          $('editor').style.display = 'none';
          $('rotate').style.display = 'none';
          $('shareTextOnly').style.display = 'none';
          $('share').style.display = '';
          $('preview').style.display = '';
          const canvas = $('preview');
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
      };
      window.__fixture = fixture;
      window.__fixtureShareClicks = 0;
      $('share').addEventListener('click', () => {
        window.__fixtureShareClicks += 1;
      });
      // Persistent test flags survive adapter navigation/reload.
      if (window.__storyFixtureHidePlus) fixture.hidePlus();
      if (window.__storyFixtureRemoveStoryOption) fixture.removeStoryOption();
      if (window.__storyFixtureSuppressChooser) fixture.suppressChooser();

      $('plus').addEventListener('click', (event) => {
        event.preventDefault();
        $('menu').style.display = 'block';
      });

      $('storyOption') && $('storyOption').addEventListener('click', () => {
        if (suppressChooser) {
          $('menu').style.display = 'none';
          history.pushState({}, '', '/create/story/');
          return;
        }
        $('file').click();
      });

      $('file').addEventListener('change', () => {
        const file = $('file').files && $('file').files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const canvas = $('preview');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            $('menu').style.display = 'none';
            $('editor').style.display = 'block';
            history.pushState({}, '', '/create/story/');
          };
          img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * @param {import('playwright').Page} page
 */
export async function installStoryFixture(page) {
  await page.route('http://story.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: storyFixtureHtml(),
    });
  });
}
