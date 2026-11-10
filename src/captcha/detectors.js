import { CaptchaDetectError } from './errors.js';

/**
 * @typedef {'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'unknown'} CaptchaType
 */

/**
 * @typedef {{
 *   type: CaptchaType,
 *   sitekey: string | null,
 *   invisible: boolean,
 *   enterprise: boolean,
 *   action: string | null,
 *   apiDomain: string | null,
 *   evidence: string[],
 * }} CaptchaDetection
 */

/**
 * Extract a sitekey from common page sources in priority order.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ sitekey: string | null, evidence: string[] }>}
 */
export async function extractSitekey(page) {
  const evidence = [];

  const fromDom = await page.evaluate(() => {
    const selectors = [
      '[data-sitekey]',
      '.g-recaptcha[data-sitekey]',
      '.h-captcha[data-sitekey]',
      '.cf-turnstile[data-sitekey]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="turnstile"]',
      'iframe[src*="challenges.cloudflare.com"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const direct = el.getAttribute('data-sitekey');
      if (direct) {
        return { sitekey: direct, evidence: `dom:${selector}` };
      }
      const src = el.getAttribute('src') || '';
      const match = src.match(/[?&]k=([^&]+)/);
      if (match?.[1]) {
        return { sitekey: decodeURIComponent(match[1]), evidence: `iframe-src:${selector}` };
      }
    }

    const html = document.documentElement.innerHTML;
    const patterns = [
      /data-sitekey=["']([^"']+)["']/i,
      /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i,
      /grecaptcha\.execute\(\s*["']([^"']+)["']/i,
      /turnstile\.render\([^)]*sitekey["']?\s*:\s*["']([^"']+)["']/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return { sitekey: match[1], evidence: `html:${pattern}` };
      }
    }

    return { sitekey: null, evidence: null };
  });

  if (fromDom.sitekey) {
    evidence.push(fromDom.evidence || 'dom');
    return { sitekey: fromDom.sitekey, evidence };
  }

  return { sitekey: null, evidence };
}

/**
 * Detect captcha type and metadata from the current page.
 *
 * @param {import('playwright').Page} page
 * @param {{ type?: string, action?: string | null, enterprise?: boolean }} [hints]
 * @returns {Promise<CaptchaDetection>}
 */
export async function detectCaptcha(page, hints = {}) {
  const evidence = [];
  const hintedType = normalizeType(hints.type);

  const probe = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hasRecaptchaApi = Boolean(
      document.querySelector('script[src*="recaptcha"]') ||
        html.includes('grecaptcha') ||
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('.g-recaptcha'),
    );
    const hasHcaptcha = Boolean(
      document.querySelector('.h-captcha, iframe[src*="hcaptcha"], script[src*="hcaptcha"]') ||
        html.includes('hcaptcha'),
    );
    const hasTurnstile = Boolean(
      document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], script[src*="turnstile"]') ||
        html.includes('turnstile'),
    );
    const hasV3Signals = Boolean(
      html.includes('grecaptcha.execute') ||
        html.includes('grecaptcha.enterprise.execute') ||
        document.querySelector('script[src*="recaptcha"][src*="render="]') ||
        /grecaptcha\.enterprise/.test(html),
    );
    const invisible = Boolean(
      document.querySelector('.g-recaptcha[data-size="invisible"]') ||
        /data-size=["']invisible["']/.test(html) ||
        /size=invisible/.test(html),
    );
    const enterprise = Boolean(
      document.querySelector('script[src*="enterprise.js"]') ||
        html.includes('grecaptcha.enterprise'),
    );
    const actionMatch =
      html.match(/data-action=["']([^"']+)["']/) ||
      html.match(/action\s*:\s*["']([^"']+)["']/);
    const apiDomain = /recaptcha\.net/.test(html)
      ? 'www.recaptcha.net'
      : /google\.com\/recaptcha/.test(html)
        ? 'www.google.com'
        : null;

    return {
      hasRecaptchaApi,
      hasHcaptcha,
      hasTurnstile,
      hasV3Signals,
      invisible,
      enterprise,
      action: actionMatch?.[1] ?? null,
      apiDomain,
    };
  });

  const { sitekey, evidence: sitekeyEvidence } = await extractSitekey(page);
  evidence.push(...sitekeyEvidence);

  /** @type {CaptchaType} */
  let type = 'unknown';

  if (hintedType && hintedType !== 'auto' && hintedType !== 'unknown') {
    type = /** @type {CaptchaType} */ (hintedType);
    evidence.push(`hint:${hintedType}`);
  } else if (probe.hasTurnstile) {
    type = 'turnstile';
    evidence.push('probe:turnstile');
  } else if (probe.hasHcaptcha) {
    type = 'hcaptcha';
    evidence.push('probe:hcaptcha');
  } else if (probe.hasRecaptchaApi && probe.hasV3Signals && !probe.invisible) {
    // v3 trap: many sites only call grecaptcha.execute and ignore textarea alone.
    type = 'recaptcha_v3';
    evidence.push('probe:recaptcha_v3');
  } else if (probe.hasRecaptchaApi) {
    type = 'recaptcha_v2';
    evidence.push(probe.invisible ? 'probe:recaptcha_v2_invisible' : 'probe:recaptcha_v2');
  }

  if (type === 'unknown' && !sitekey) {
    throw new CaptchaDetectError(
      'No captcha widget/sitekey detected on the page. Pass type/sitekey explicitly if the challenge is known.',
    );
  }

  return {
    type,
    sitekey,
    invisible: Boolean(probe.invisible),
    enterprise: Boolean(hints.enterprise ?? probe.enterprise),
    action: hints.action ?? probe.action,
    apiDomain: probe.apiDomain,
    evidence,
  };
}

/**
 * @param {string | undefined} type
 * @returns {string}
 */
export function normalizeType(type) {
  if (!type) {
    return 'auto';
  }
  return String(type).trim().toLowerCase();
}

/**
 * Whether a visible challenge widget is present (checkbox / turnstile / hcaptcha box).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function hasVisibleChallenge(page) {
  const selectors = [
    'iframe[src*="recaptcha"]',
    'iframe[title*="reCAPTCHA"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
  ];

  for (const selector of selectors) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      return true;
    }
  }

  return false;
}
