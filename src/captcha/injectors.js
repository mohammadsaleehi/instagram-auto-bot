import { CaptchaInjectError } from './errors.js';

/**
 * Inject a solved captcha token into the page.
 *
 * Critical rules:
 * - Do NOT click the checkbox / widget when injecting a token.
 * - Fill response fields AND fire callbacks when present.
 * - For reCAPTCHA v3, many sites ignore the textarea and only accept
 *   a token returned through grecaptcha.execute — we still populate
 *   fields and invoke known callbacks / ___grecaptcha_cfg clients.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   type: string,
 *   token: string,
 *   sitekey?: string | null,
 * }} options
 * @returns {Promise<{ injected: boolean, callbacksFired: number, fieldsWritten: string[] }>}
 */
export async function injectCaptchaToken(page, options) {
  if (!options.token) {
    throw new CaptchaInjectError('Cannot inject an empty captcha token');
  }

  const result = await page.evaluate(
    ({ type, token, sitekey }) => {
      const fieldsWritten = [];
      let callbacksFired = 0;

      /**
       * @param {string} name
       * @param {string} value
       */
      function ensureField(name, value) {
        /** @type {HTMLTextAreaElement | HTMLInputElement | null} */
        let el = document.querySelector(`[name="${name}"]`);
        if (!el) {
          el = document.createElement('textarea');
          el.name = name;
          el.style.display = 'none';
          document.body.appendChild(el);
        }
        el.value = value;
        el.innerHTML = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        fieldsWritten.push(name);
      }

      if (type === 'hcaptcha') {
        ensureField('h-captcha-response', token);
        ensureField('g-recaptcha-response', token);
      } else if (type === 'turnstile') {
        ensureField('cf-turnstile-response', token);
        ensureField('g-recaptcha-response', token);
      } else {
        // reCAPTCHA v2 / v3
        ensureField('g-recaptcha-response', token);
      }

      // Fire data-callback attributes on widgets.
      const nodes = Array.from(
        document.querySelectorAll('[data-callback], .g-recaptcha, .h-captcha, .cf-turnstile'),
      );
      for (const node of nodes) {
        const callbackName = node.getAttribute('data-callback');
        if (callbackName && typeof window[callbackName] === 'function') {
          try {
            window[callbackName](token);
            callbacksFired += 1;
          } catch {
            // Ignore site callback errors; token is still injected.
          }
        }
      }

      // Attempt grecaptcha callback clients (v2 / enterprise).
      try {
        const cfg = window.___grecaptcha_cfg;
        const clients = cfg?.clients || {};
        for (const client of Object.values(clients)) {
          walkAndInvoke(client, token, (count) => {
            callbacksFired += count;
          });
        }
      } catch {
        // ignore
      }

      // Turnstile callback hook if present on render params.
      try {
        if (typeof window.turnstile?.getResponse === 'function') {
          // No official setter; field injection is the portable path.
        }
      } catch {
        // ignore
      }

      /**
       * Recursively find callback-like functions in grecaptcha client objects.
       * @param {unknown} node
       * @param {string} value
       * @param {(n: number) => void} onFire
       * @param {number} [depth]
       * @param {WeakSet<object>} [seen]
       */
      function walkAndInvoke(node, value, onFire, depth = 0, seen = new WeakSet()) {
        if (!node || depth > 6) return;
        if (typeof node === 'function') {
          try {
            // Heuristic: callback functions often accept the token string.
            if (node.length <= 2) {
              node(value);
              onFire(1);
            }
          } catch {
            // ignore
          }
          return;
        }
        if (typeof node !== 'object') return;
        if (seen.has(node)) return;
        seen.add(node);

        for (const [key, child] of Object.entries(node)) {
          if (/callback/i.test(key) && typeof child === 'function') {
            try {
              child(value);
              onFire(1);
            } catch {
              // ignore
            }
          } else if (child && typeof child === 'object') {
            walkAndInvoke(child, value, onFire, depth + 1, seen);
          }
        }
      }

      // Expose token for sites that poll a custom global.
      window.__captchaBypassToken = token;
      if (sitekey) {
        window.__captchaBypassSitekey = sitekey;
      }

      return {
        injected: fieldsWritten.length > 0,
        callbacksFired,
        fieldsWritten,
      };
    },
    {
      type: options.type,
      token: options.token,
      sitekey: options.sitekey ?? null,
    },
  );

  if (!result.injected) {
    throw new CaptchaInjectError('Token injection failed: no response fields were written');
  }

  return result;
}
