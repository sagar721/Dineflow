#!/usr/bin/env node
// Contrast check for the design tokens (WCAG 2.1 AA).
//
// The design system claims specific ratios; this reads the real token values out of
// tokens.css and computes them, so the claim is checked rather than asserted. It
// covers both the admin (light) palette and the kitchen (dark) palette.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');

/** Reads `--color-x: #hex` pairs from a block of CSS. */
function tokensIn(block) {
  return Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

// Search for the dark block *after* @theme: the custom-variant declaration near the
// top of the file mentions the same selector and would otherwise cut the slice short.
const themeStart = css.indexOf('@theme');
const darkStart = css.indexOf("[data-theme='dark'] {", themeStart);
const themeBlock = css.slice(themeStart, darkStart);
const darkBlock = css.slice(darkStart, css.indexOf('@layer base'));
const light = tokensIn(themeBlock);
const dark = { ...light, ...tokensIn(darkBlock) };

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// [foreground, background, minimum, what it is]
// 4.5 = body text, 3.0 = large text, icons, focus rings and UI boundaries.
const PAIRS = [
  ['text', 'bg', 4.5, 'body text on the page background'],
  ['text', 'surface', 4.5, 'body text on cards'],
  ['text', 'surface-2', 4.5, 'body text on secondary surfaces'],
  ['muted', 'surface', 4.5, 'secondary text on cards'],
  ['muted', 'bg', 4.5, 'secondary text on the page background'],
  ['brand', 'surface', 4.5, 'brand text and links on cards'],
  ['brand', 'brand-subtle', 4.5, 'active sidebar item'],
  ['inverse', 'brand', 4.5, 'primary button label'],
  ['inverse', 'danger', 4.5, 'danger button label'],
  ['success', 'success-bg', 4.5, 'success message'],
  ['warning', 'warning-bg', 4.5, 'warning message'],
  ['danger', 'danger-bg', 4.5, 'error message'],
  ['info', 'info-bg', 4.5, 'info message'],
  ['status-pending', 'status-pending-bg', 4.5, 'pending chip'],
  ['status-accepted', 'status-accepted-bg', 4.5, 'accepted chip'],
  ['status-preparing', 'status-preparing-bg', 4.5, 'preparing chip'],
  ['status-ready', 'status-ready-bg', 4.5, 'ready chip'],
  ['status-served', 'status-served-bg', 4.5, 'served chip'],
  ['status-cancelled', 'status-cancelled-bg', 4.5, 'cancelled chip'],
  ['focus', 'bg', 3, 'focus ring on the page background'],
  ['focus', 'surface', 3, 'focus ring on cards'],
  ['border-strong', 'surface', 3, 'input borders'],
];

let failures = 0;
for (const [themeName, tokens] of [['light (admin)', light], ['dark (kitchen)', dark]]) {
  process.stdout.write(`\n\x1b[1m${themeName}\x1b[0m\n`);
  for (const [fg, bg, min, what] of PAIRS) {
    const a = tokens[fg];
    const b = tokens[bg];
    if (!a || !b) {
      failures += 1;
      process.stdout.write(`  \x1b[31mFAIL\x1b[0m missing token: ${!a ? fg : bg}\n`);
      continue;
    }
    const value = ratio(a, b);
    const ok = value >= min;
    if (!ok) failures += 1;
    process.stdout.write(
      `  ${ok ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${value.toFixed(2)}:1 (min ${min}) — ${what}\n`,
    );
  }
}

process.stdout.write(
  failures === 0
    ? '\n\x1b[32mAll token pairs meet their contrast minimum\x1b[0m\n'
    : `\n\x1b[31m${failures} pair(s) below the minimum\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
