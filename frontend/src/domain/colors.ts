/* Primary and sidebar colours for this browser, chosen in Settings. Like the theme, they are a personal choice:
   kept in localStorage, never sent to the server or written into backups. The stylesheet's tokens are the
   default scheme; any other scheme overrides --accent and --side (and the tokens made from them) inline on <html>. */

type Rgb = [number, number, number];

export interface ColorScheme {
    id: string;
    name: string;
    /** Primary colour in the light theme and in the dark theme. */
    accent: [string, string];
    /** Sidebar background in the light theme and in the dark theme. */
    side: [string, string];
}

/** Hand-picked pairs. Each light primary keeps white button text at 4.5:1 or better, and each sidebar keeps its
    grey group headings at 4.5:1. The first is the stylesheet's own scheme. */
export const SCHEMES: ColorScheme[] = [
    { id: 'teal', name: 'Teal, light sidebar', accent: ['#0e7c6b', '#34b39c'], side: ['#13233a', '#0a1118'] },
    { id: 'ocean', name: 'Ocean blue', accent: ['#1f5fbf', '#5b9cf0'], side: ['#0f1f3d', '#08101f'] },
    { id: 'indigo', name: 'Indigo', accent: ['#4f46e5', '#8b85f5'], side: ['#1c1a46', '#0e0d24'] },
    { id: 'forest', name: 'Forest green', accent: ['#17803f', '#45c27a'], side: ['#0e251b', '#08150f'] },
    { id: 'plum', name: 'Royal purple', accent: ['#7c3aed', '#a98bfa'], side: ['#261543', '#140b24'] },
    { id: 'crimson', name: 'Crimson', accent: ['#b42340', '#ef7088'], side: ['#2a1219', '#16090d'] },
    { id: 'copper', name: 'Copper and charcoal', accent: ['#b45309', '#eea04a'], side: ['#231c17', '#120e0b'] },
    { id: 'midnight', name: 'Sky and midnight', accent: ['#0369a1', '#38b6f0'], side: ['#111827', '#0a0e16'] },
];
export const DEFAULT_SCHEME = SCHEMES[0].id;

export interface ColorChoice { scheme: string; accent?: string; side?: string }

const KEY = 'ifrs16.colors';
const TOKENS = ['--accent', '--accent-h', '--accent-soft', '--side', '--side-2', '--side-text'];
const HEX = /^#[0-9a-f]{6}$/i;
let choice: ColorChoice = { scheme: DEFAULT_SCHEME };

const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = (c: Rgb): string => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
/** a with t of b mixed in. */
const mix = (a: string, b: string, t: number): string => { const x = rgb(a), y = rgb(b); return hex([0, 1, 2].map(i => x[i] + (y[i] - x[i]) * t) as Rgb); };

function luminance(c: string): number {
    const [r, g, b] = rgb(c).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

function toHsl(c: string): Rgb {
    const [r, g, b] = rgb(c).map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
}
function fromHsl([h, s, l]: Rgb): string {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return hex([r, g, b].map(v => (v + m) * 255) as Rgb);
}
const withLightness = (c: string, f: (l: number) => number): string => { const [h, s, l] = toHsl(c); return fromHsl([h, s, Math.min(1, Math.max(0, f(l)))]); };
/** Darker in small steps until text in the given colour on it reaches the ratio. */
function darkenFor(c: string, text: string, ratio: number): string {
    let out = c;
    while (contrast(out, text) < ratio && toHsl(out)[2] > 0.02) out = withLightness(out, l => l - 0.02);
    return out;
}

/** A custom pick made safe to use: white button text at 4.5:1, and the sidebar's grey group headings
    (enhancements.css) at 4.5:1, which keeps its white text well above that. */
export function readable(accent: string, side: string): { accent: string; side: string; changed: boolean } {
    const a = darkenFor(accent.toLowerCase(), '#ffffff', 4.5), s = darkenFor(side.toLowerCase(), '#7b8ca1', 4.5);
    return { accent: a, side: s, changed: a !== accent.toLowerCase() || s !== side.toLowerCase() };
}

/** Both theme variants of a custom pick, made the way the hand-picked schemes relate. */
function customScheme(accent: string, side: string): ColorScheme {
    const r = readable(accent, side);
    const [h, s, l] = toHsl(r.accent);
    return {
        id: 'custom', name: 'Custom',
        accent: [r.accent, fromHsl([h, s * 0.85, Math.min(0.68, Math.max(0.55, l + 0.2))])],
        side: [r.side, withLightness(r.side, x => x * 0.5)],
    };
}

/** The scheme in use, with custom picks expanded. */
export function activeScheme(): ColorScheme {
    if (choice.scheme === 'custom' && choice.accent && choice.side) return customScheme(choice.accent, choice.side);
    return SCHEMES.find(s => s.id === choice.scheme) || SCHEMES[0];
}
export const colorChoice = (): ColorChoice => ({ ...choice });

/** Set the tokens for the theme now in use (call after the theme changes too). */
export function applyColors(): void {
    const root = document.documentElement, style = root.style;
    const scheme = activeScheme();
    // The default scheme's sidebar sits on the page; any other keeps its own colour (minimal.css)
    root.dataset.nav = scheme.id === DEFAULT_SCHEME ? 'page' : 'color';
    if (scheme.id === DEFAULT_SCHEME) { TOKENS.forEach(t => style.removeProperty(t)); return; }
    const dark = root.dataset.theme === 'dark', i = dark ? 1 : 0;
    const accent = scheme.accent[i], side = scheme.side[i];
    const [h, s] = toHsl(side);
    const tokens: Record<string, string> = {
        '--accent': accent,
        '--accent-h': mix(accent, '#000000', dark ? 0.14 : 0.18),
        '--accent-soft': dark ? mix(accent, '#0d141c', 0.78) : mix(accent, '#ffffff', 0.87),
        '--side': side,
        '--side-2': withLightness(side, l => l + (dark ? 0.04 : 0.06)),
        '--side-text': fromHsl([h, Math.min(s, 0.35), dark ? 0.76 : 0.84]),
    };
    Object.entries(tokens).forEach(([k, v]) => style.setProperty(k, v));
}

/** Choose a scheme (or custom colours), keep it in this browser and show it. */
export function setColors(next: ColorChoice): void {
    choice = next.scheme === 'custom' && next.accent && next.side && HEX.test(next.accent) && HEX.test(next.side)
        ? { scheme: 'custom', accent: next.accent.toLowerCase(), side: next.side.toLowerCase() }
        : { scheme: SCHEMES.some(s => s.id === next.scheme) ? next.scheme : DEFAULT_SCHEME };
    try {
        if (choice.scheme === DEFAULT_SCHEME) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(choice));
    } catch { /* storage unavailable */ }
    applyColors();
}

/** The colours saved in this browser, read once at start-up. */
export function loadColors(): void {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as ColorChoice | null;
        if (saved && typeof saved.scheme === 'string') setColors(saved);
    } catch { /* storage unavailable or unreadable: keep the default */ }
}
