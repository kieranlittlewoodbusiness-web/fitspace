// Shared PT theme allowlist. The Worker validates PUT /api/pt/theme against this list.
// Colours are stored in the existing pts.accent, pts.background and pts.foreground columns
// (no migration). primary is part of the preset and is applied on read, not stored.
import { httpError } from './util.mjs';
import { colours } from './validate.mjs';

export const DEFAULT_THEME_ID = 'resilience';

// Same luminance threshold as app/public/app.js, so button text matches what the pages render.
export function accentInk(hex){
  const rgb = String(hex).slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#000000' : '#ffffff';
}

export const THEME_PRESETS = Object.freeze([
  Object.freeze({ id: 'resilience', name: 'Resilience', primary: '#111111', accent: '#ffd43b', background: '#ffffff', text: '#111111' }),
  Object.freeze({ id: 'slate', name: 'Slate', primary: '#0f172a', accent: '#2563eb', background: '#ffffff', text: '#0f172a' }),
  Object.freeze({ id: 'forest', name: 'Forest', primary: '#14532d', accent: '#15803d', background: '#f7faf7', text: '#14532d' }),
  Object.freeze({ id: 'navy', name: 'Navy', primary: '#1e3a5f', accent: '#c9a227', background: '#f4f6f8', text: '#1e3a5f' }),
  Object.freeze({ id: 'charcoal', name: 'Charcoal', primary: '#1a1a1a', accent: '#c2410c', background: '#fffaf8', text: '#1a1a1a' }),
  Object.freeze({ id: 'sand', name: 'Sand', primary: '#3f2a1d', accent: '#92400e', background: '#faf6f0', text: '#3f2a1d' }),
  Object.freeze({ id: 'night', name: 'Night', primary: '#f5f5f5', accent: '#ffd43b', background: '#111111', text: '#f5f5f5' }),
  Object.freeze({ id: 'ocean', name: 'Ocean', primary: '#0c4a6e', accent: '#0e7490', background: '#f0f7fa', text: '#0c4a6e' }),
  Object.freeze({ id: 'plum', name: 'Plum', primary: '#3b0764', accent: '#6b21a8', background: '#faf7fb', text: '#3b0764' }),
  Object.freeze({ id: 'olive', name: 'Olive', primary: '#1c1917', accent: '#3f6212', background: '#f4f3ec', text: '#1c1917' })
]);

const byId = Object.freeze(Object.fromEntries(THEME_PRESETS.map(p => [p.id, p])));

export function presetById(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return byId[key] || null;
}

export function presetColours(preset) {
  return { accent: preset.accent, background: preset.background, foreground: preset.text, primary: preset.primary };
}

function norm(hex) {
  return String(hex ?? '').trim().toLowerCase();
}

/** Map stored pts colours back to a preset id; unknown combinations fall back to resilience. */
export function resolveThemeId(pt) {
  const accent = norm(pt?.accent);
  const background = norm(pt?.background);
  const text = norm(pt?.foreground ?? pt?.text);
  const found = THEME_PRESETS.find(p => norm(p.accent) === accent && norm(p.background) === background && norm(p.text) === text);
  return found?.id || DEFAULT_THEME_ID;
}

export function themeIdFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Choose a theme from the list.');
  const preset = presetById(body.id);
  if (!preset) throw httpError(400, 'Choose a theme from the list.');
  return preset.id;
}

export function contrastRatios(preset) {
  const primaryInk = accentInk(preset.primary);
  const accentInkColour = accentInk(preset.accent);
  // Links use the body text colour (pages use color: inherit), not the accent.
  return {
    id: preset.id,
    textOnBackground: colours(preset.background, preset.text),
    buttonOnPrimary: colours(preset.primary, primaryInk),
    buttonOnAccent: colours(preset.accent, accentInkColour),
    linksOnBackground: colours(preset.background, preset.text),
    primaryInk,
    accentInk: accentInkColour
  };
}

export { colours };
