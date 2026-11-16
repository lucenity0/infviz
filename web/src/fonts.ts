// Fonts. Geist Mono and Inter Tight are OFL and bundled from npm. Brutal Milk is an
// Envato-licensed face kept out of git (public/fonts/licensed/): load it if present,
// otherwise the CSS stack falls back to Inter Tight silently.
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource-variable/inter-tight/wght.css';

export const fontsReady: Promise<void> = (async () => {
  try {
    const url = new URL('fonts/licensed/brutal-milk-var.woff2', document.baseURI).href;
    const face = new FontFace('Brutal Milk', `url(${url}) format('woff2')`, { weight: '100 900' });
    document.fonts.add(await face.load());
  } catch {
    /* fallback stack */
  }
  await document.fonts.ready;
})();
