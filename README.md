# mng-polyfill

A lightweight JavaScript polyfill that brings animated **MNG** (Multiple-image Network Graphics) support to modern browsers.

Made for [ezgif.com](https://ezgif.com).

## What is MNG?

MNG is an animation format based on PNG, designed as the animated counterpart to PNG, much like GIF but with full-color, alpha transparency, and lossless compression. The format didn't gain widespread adoption and browser support was dropped years ago, for general purpose animated PNG files, APNG is a better choice. However, MNG is still used for some specific purposes and ezgif allows converting or editing MNG files, so I wanted them to be displayed properly on the website. This polyfill parses MNG files in JavaScript and rendering them to `<canvas>`.

## Features

- **Drop-in polyfill**: automatically detects `<img>` tags with `.mng` sources and replaces them with animated `<canvas>` elements.
- **Accurate animation timing**: respects `FRAM` inter-frame delays and `MHDR` ticks-per-second for precise playback speed.
- **Looping control**: honors `TERM`-based iteration counts. Supports infinite looping and finite play counts.
- **Frame compositing**: implements framing modes 1–4 with proper background clearing and compositing.
- **Background color**: supports the `BACK` chunk with mandatory/advisory background distinction. Transparent by default for seamless web integration.
- **Frame positioning**: handles `DEFI` chunk X/Y offsets for sprite-sheet-style animations.
- **MutationObserver**: watches for dynamically added `.mng` images (e.g., lazy-loaded or SPA content) and polyfills them automatically.
- **Programmatic API**: `MNGPlayer` class for full playback control (play, pause, stop, dispose).
- **Zero dependencies**: single self-contained file, no build step required.
- **Graceful fallback**: if an MNG file fails to load, the original `<img>` tag is restored.

## Usage

### Drop-in

Include the script on your page. Any `<img>` with an `.mng` source will be automatically replaced with an animated canvas:

```html
<script src="mng-polyfill.js"></script>
<img src="animation.mng" alt="Animated MNG">
```

Including the script is all you need to get MNG files working.

### Data attribute

Use `data-mng-src` if you prefer to keep a fallback `src`:

```html
<script src="mng-polyfill.js"></script>
<img src="fallback.png" data-mng-src="animation.mng" alt="Animated MNG">
```

### Explicit background color

Set a background color for transparent areas using `data-mng-bg`:

```html
<img src="animation.mng" data-mng-bg="#ffffff" alt="Animated MNG">
```

### Programmatic API

```js
const canvas = document.getElementById('my-canvas');
const player = new MNGPlayer(canvas, {
    autoplay: true,        // start playing when loaded (default: true)
    loop: true,            // override TERM loop count (true = infinite)
    background: '#000000'  // CSS background color for transparent areas
});

player.load('animation.mng').then(() => {
    console.log('Frames:', player.frameCount);
    console.log('Playing:', player.playing);
});

// Playback controls
player.pause();
player.play();
player.stop();     // stop and reset to first frame

// Clean up when done
player.dispose();
```

### Global API

```js
// Re-scan the DOM for new .mng images
MNGPolyfill.scan();

// Parse raw MNG data
const result = MNGPolyfill.parseMNG(uint8Array);
console.log(result.width, result.height, result.frames.length);

// Player class reference
const player = new MNGPolyfill.Player(canvas);
```

## CDN / Installation

Copy `mng-polyfill.js` into your project and include it with a `<script>` tag. No package manager or build step needed.

```html
<script src="mng-polyfill.js"></script>
```

## CORS

The polyfill uses `fetch()` to download `.mng` files. If the MNG file is served from a different domain than the page, the server must include the appropriate CORS header:

```
Access-Control-Allow-Origin: *
```

## License

[MIT](LICENSE)
