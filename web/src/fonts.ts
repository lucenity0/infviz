// Fonts. Text is set in two OFL faces bundled from npm: Geist Mono (numbers, tokens) and
// Inter Tight (everything else). The display face, Brutal Milk, never ships as a font: a
// few fixed titles use vector outlines of it instead (src/outlines.ts).
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource-variable/inter-tight/wght.css';

export const fontsReady: Promise<void> = document.fonts.ready.then(() => undefined);
