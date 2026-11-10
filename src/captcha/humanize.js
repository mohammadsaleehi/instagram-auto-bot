/**
 * Lightweight humanization helpers.
 * These reduce robotic timing patterns. They do not produce captcha tokens
 * and must not be treated as a captcha bypass by themselves.
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} [minMs=120]
 * @param {number} [maxMs=420]
 * @returns {Promise<void>}
 */
export async function humanPause(minMs = 120, maxMs = 420) {
  await sleep(randomBetween(minMs, maxMs));
}

/**
 * Move the mouse in a short, imperfect path toward a locator.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 * @returns {Promise<void>}
 */
export async function humanMoveTo(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return;
  }

  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
  const steps = randomBetween(8, 18);

  await page.mouse.move(targetX, targetY, { steps });
  await humanPause(40, 160);
}
