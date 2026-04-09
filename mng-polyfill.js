/**
 * mng-polyfill.js — Browser polyfill for animated MNG (Multiple-image Network Graphics) files.
 * 
 * https://github.com/Mad182/mng-polyfill
 *
 * Implements MNG-LC (Low Complexity) parsing and playback:
 *   - Parses MNG chunk structure (MHDR, MEND, FRAM, DEFI, TERM, LOOP, ENDL, BACK)
 *   - Extracts embedded PNG images (IHDR..IEND) with global ancillary chunk injection
 *   - Handles animation timing via FRAM interframe delays and MHDR ticks_per_second
 *   - Supports TERM-based looping (iteration count)
 *   - Renders frames to a <canvas> element with proper compositing (framing modes 1–4)
 *   - Automatically replaces <img> tags with .mng src attributes
 *
 * Usage:
 *   <script src="mng-polyfill.js"></script>
 *   <img src="animation.mng" alt="Animated MNG">
 *
 * Or programmatically:
 *   const player = new MNGPlayer(canvasElement);
 *   player.load('animation.mng').then(() => player.play());
 *
 * License: MIT
 */

(function (global) {
    'use strict';

    // ========================================================================
    // CRC-32 (for generating valid PNG chunk CRCs)
    // ========================================================================

    const crcTable = new Uint32Array(256);
    (function buildCrcTable() {
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c;
        }
    })();

    function computeCrc(buf, offset, length) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < length; i++) {
            c = crcTable[(c ^ buf[offset + i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // ========================================================================
    // Binary read/write helpers (big-endian, as per PNG/MNG spec)
    // ========================================================================

    function readU32(data, offset) {
        return ((data[offset] << 24) | (data[offset + 1] << 16) |
                (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
    }

    function readI32(data, offset) {
        return (data[offset] << 24) | (data[offset + 1] << 16) |
               (data[offset + 2] << 8) | data[offset + 3];
    }

    function readU16(data, offset) {
        return (data[offset] << 8) | data[offset + 1];
    }

    function writeU32(buf, offset, value) {
        buf[offset]     = (value >>> 24) & 0xFF;
        buf[offset + 1] = (value >>> 16) & 0xFF;
        buf[offset + 2] = (value >>> 8) & 0xFF;
        buf[offset + 3] = value & 0xFF;
    }

    function chunkTypeStr(data, offset) {
        return String.fromCharCode(data[offset], data[offset + 1],
                                   data[offset + 2], data[offset + 3]);
    }

    // ========================================================================
    // PNG signature and chunk writer
    // ========================================================================

    const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const MNG_SIGNATURE = new Uint8Array([0x8A, 0x4D, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    /** Build a single PNG chunk as Uint8Array: [length(4) + type(4) + data + crc(4)] */
    function buildPngChunk(type, data) {
        const typeBytes = new Uint8Array(4);
        for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);

        const dataLen = data ? data.length : 0;
        const chunk = new Uint8Array(12 + dataLen);

        // Length
        writeU32(chunk, 0, dataLen);

        // Type
        chunk.set(typeBytes, 4);

        // Data
        if (dataLen > 0) chunk.set(data, 8);

        // CRC over type + data
        const crcBuf = new Uint8Array(4 + dataLen);
        crcBuf.set(typeBytes, 0);
        if (dataLen > 0) crcBuf.set(data, 4);
        const crc = computeCrc(crcBuf, 0, crcBuf.length);
        writeU32(chunk, 8 + dataLen, crc);

        return chunk;
    }

    // ========================================================================
    // PNG ancillary chunk ordering (for injection of global chunks)
    // ========================================================================

    const GLOBAL_CHUNK_TYPES = new Set(['PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP']);

    function chunkOrderPriority(type) {
        switch (type) {
            case 'cHRM': return 0;
            case 'gAMA': return 1;
            case 'iCCP': return 2;
            case 'sRGB': return 3;
            case 'PLTE': return 4;
            case 'bKGD': return 5;
            case 'tRNS': return 6;
            default:     return 99;
        }
    }

    // ========================================================================
    // MNG Parser — extracts frames, delays, and animation metadata
    // ========================================================================

    /**
     * @typedef {Object} MNGFrame
     * @property {Blob} pngBlob       - Standalone PNG as a Blob
     * @property {number} delayMs     - Interframe delay in milliseconds
     * @property {number} x           - X offset from DEFI
     * @property {number} y           - Y offset from DEFI
     * @property {number} framingMode - Active framing mode (1–4)
     */

    /**
     * @typedef {Object} MNGParseResult
     * @property {number} width            - Frame width from MHDR
     * @property {number} height           - Frame height from MHDR
     * @property {number} ticksPerSecond   - Ticks per second from MHDR
     * @property {number} loopCount        - Number of iterations (0 = infinite)
     * @property {MNGFrame[]} frames       - Array of parsed frames
     * @property {number[]} bgColor        - Background color [r, g, b] (0–255), or null
     * @property {boolean} bgMandatory     - Whether background color is mandatory (from BACK chunk)
     */

    function parseMNG(data) {
        if (!(data instanceof Uint8Array)) {
            data = new Uint8Array(data);
        }

        const filesize = data.length;

        // Verify MNG signature
        if (filesize < 8) throw new Error('File too small to be MNG');
        for (let i = 0; i < 8; i++) {
            if (data[i] !== MNG_SIGNATURE[i]) {
                throw new Error('Not a valid MNG file (bad signature)');
            }
        }

        // Result
        const result = {
            width: 0,
            height: 0,
            ticksPerSecond: 0,
            loopCount: 0,      // 0 = infinite
            frames: [],
            bgColor: null,
            bgMandatory: false  // BACK mandatory_background flag
        };

        // Global state
        const globalChunks = new Map();  // type -> {type, data}
        let ticksPerSecond = 0;

        // FRAM state (defaults per spec Section 4.3.2)
        let framingMode = 1;
        let currentDelay = 1;          // in ticks
        let defaultDelay = 1;          // the "reset default" delay

        // DEFI state
        let defiX = 0;
        let defiY = 0;

        // TERM state
        let termIterationCount = 0;    // 0 = loop forever

        // LOOP/ENDL state
        const loopStack = [];          // [{nestLevel, iterCount, startPos}]

        // Image collection state
        let inImage = false;
        const imageChunks = [];        // {type: string, data: Uint8Array}[]

        // Delay assigned to each pending image
        let pendingDelay = currentDelay;
        let pendingFramingMode = framingMode;

        let pos = 8; // skip MNG signature

        while (pos + 12 <= filesize) {
            const chunkLen = readU32(data, pos);
            const type = chunkTypeStr(data, pos + 4);
            const chunkDataOffset = pos + 8;

            // Bounds check
            if (pos + 12 + chunkLen > filesize) {
                console.warn('MNG: truncated chunk "' + type + '" at offset ' + pos);
                break;
            }

            if (type === 'MHDR') {
                // MHDR: 28 bytes
                if (chunkLen >= 28) {
                    result.width = readU32(data, chunkDataOffset);
                    result.height = readU32(data, chunkDataOffset + 4);
                    ticksPerSecond = readU32(data, chunkDataOffset + 8);
                    result.ticksPerSecond = ticksPerSecond;
                }

            } else if (type === 'TERM') {
                // TERM chunk: termination action + conditions
                // Byte 0: termination_action (3 = repeat)
                // If 10 bytes: action(1) + after_action(1) + delay(4) + iteration_count(4)
                if (chunkLen >= 10) {
                    const action = data[chunkDataOffset];
                    termIterationCount = readU32(data, chunkDataOffset + 6);
                    result.loopCount = termIterationCount;
                    // action=3 means repeat (loop), action=0 means show last frame
                } else if (chunkLen >= 1) {
                    // Simple TERM with just action byte
                    const action = data[chunkDataOffset];
                    if (action === 0) {
                        result.loopCount = 1; // play once
                    }
                }

            } else if (type === 'BACK') {
                // BACK: 6+ bytes - background color
                // Bytes 0-1: Red (16-bit), 2-3: Green (16-bit), 4-5: Blue (16-bit)
                // Byte 6 (optional): mandatory_background (0=advisory, 1=mandatory)
                if (chunkLen >= 6) {
                    const r = readU16(data, chunkDataOffset) >>> 8;     // 16-bit to 8-bit
                    const g = readU16(data, chunkDataOffset + 2) >>> 8;
                    const b = readU16(data, chunkDataOffset + 4) >>> 8;
                    result.bgColor = [r, g, b];
                    if (chunkLen >= 7) {
                        result.bgMandatory = (data[chunkDataOffset + 6] === 1);
                    }
                }

            } else if (type === 'FRAM') {
                // FRAM chunk
                if (chunkLen === 0) {
                    // Empty FRAM — just a subframe delimiter
                    // The current delay stays as is
                } else {
                    const newFramingMode = data[chunkDataOffset];
                    if (newFramingMode !== 0) {
                        framingMode = newFramingMode;
                    }

                    if (chunkLen > 1) {
                        // Find null separator after optional name
                        let sepPos = 1;
                        while (sepPos < chunkLen && data[chunkDataOffset + sepPos] !== 0) {
                            sepPos++;
                        }

                        if (sepPos < chunkLen) {
                            // Skip null separator
                            const fieldPos = sepPos + 1;

                            if (fieldPos < chunkLen) {
                                const changeDelay = data[chunkDataOffset + fieldPos];
                                // fieldPos+1: change_timeout_and_termination
                                // fieldPos+2: change_layer_clipping_boundaries
                                // fieldPos+3: change_sync_id_list

                                const delayFieldPos = fieldPos + 4;

                                if (changeDelay !== 0 && delayFieldPos + 4 <= chunkLen) {
                                    const newDelay = readU32(data, chunkDataOffset + delayFieldPos);
                                    currentDelay = newDelay;

                                    if (changeDelay === 2) {
                                        // Also reset default
                                        defaultDelay = newDelay;
                                    }
                                }
                            }
                        }
                    }
                }

                pendingDelay = currentDelay;
                pendingFramingMode = framingMode;

            } else if (type === 'DEFI') {
                // DEFI: object definition with position
                if (chunkLen >= 12) {
                    // Bytes 0-1: object_id (must be 0 in MNG-LC)
                    // Byte 2: do_not_show
                    // Byte 3: concrete_flag
                    // Bytes 4-7: X_location (signed)
                    // Bytes 8-11: Y_location (signed)
                    defiX = readI32(data, chunkDataOffset + 4);
                    defiY = readI32(data, chunkDataOffset + 8);
                } else if (chunkLen >= 4) {
                    // No position specified, just object_id + flags
                    defiX = 0;
                    defiY = 0;
                } else {
                    defiX = 0;
                    defiY = 0;
                }

            } else if (type === 'LOOP') {
                // LOOP: nest_level(1) + iteration_count(4) + optional termination
                if (chunkLen >= 5) {
                    const nestLevel = data[chunkDataOffset];
                    const iterCount = readU32(data, chunkDataOffset + 1);
                    loopStack.push({
                        nestLevel: nestLevel,
                        iterCount: iterCount,
                        remaining: iterCount,
                        startPos: pos + 12 + chunkLen  // position after this LOOP chunk
                    });
                } else if (chunkLen >= 1) {
                    const nestLevel = data[chunkDataOffset];
                    loopStack.push({
                        nestLevel: nestLevel,
                        iterCount: 0, // infinite
                        remaining: 0,
                        startPos: pos + 12 + chunkLen
                    });
                }

            } else if (type === 'ENDL') {
                // ENDL: nest_level(1)
                // For polyfill simplicity, we don't actually jump back in the byte
                // stream. Instead, LOOP/ENDL are handled via TERM-based iteration.
                // MNG-LC decoders can ignore LOOP/ENDL per the spec.
                if (loopStack.length > 0) {
                    loopStack.pop();
                }

            } else if (type === 'IHDR' || type === 'JHDR') {
                // Start of an embedded PNG (or JNG) image
                inImage = true;
                imageChunks.length = 0;

                imageChunks.push({
                    type: type,
                    data: new Uint8Array(data.buffer, data.byteOffset + chunkDataOffset, chunkLen)
                });

            } else if (type === 'IEND') {
                if (inImage) {
                    // End of embedded image
                    imageChunks.push({ type: 'IEND', data: new Uint8Array(0) });

                    // Build a standalone PNG blob from collected chunks
                    const pngBlob = buildPngFromChunks(imageChunks, globalChunks);

                    // Calculate delay in milliseconds
                    let delayMs;
                    if (ticksPerSecond === 0) {
                        delayMs = 100; // default 100ms when tps is undefined
                    } else {
                        delayMs = (pendingDelay / ticksPerSecond) * 1000;
                    }

                    result.frames.push({
                        pngBlob: pngBlob,
                        delayMs: delayMs,
                        x: defiX,
                        y: defiY,
                        framingMode: pendingFramingMode
                    });

                    inImage = false;
                    imageChunks.length = 0;

                }

            } else if (inImage) {
                // Collecting chunks within the embedded PNG
                imageChunks.push({
                    type: type,
                    data: new Uint8Array(data.buffer, data.byteOffset + chunkDataOffset, chunkLen)
                });

            } else if (type === 'MEND') {
                // End of MNG datastream
                break;

            } else if (GLOBAL_CHUNK_TYPES.has(type)) {
                // MNG-level global ancillary chunk
                globalChunks.set(type, {
                    type: type,
                    data: new Uint8Array(data.buffer, data.byteOffset + chunkDataOffset, chunkLen)
                });
            }
            // Skip all other MNG-level chunks (SAVE, SEEK, MAGN, eXPI, pHYg, etc.)

            // Advance to next chunk
            pos += 12 + chunkLen;
        }

        return result;
    }

    /**
     * Build a standalone PNG file (as Blob) from collected image chunks,
     * injecting any missing global ancillary chunks.
     */
    function buildPngFromChunks(imageChunks, globalChunks) {
        const ihdr = imageChunks[0];
        const iend = imageChunks[imageChunks.length - 1];

        // Separate pre-IDAT ancillary and IDAT chunks
        const preIdatChunks = [];
        const idatChunks = [];
        const imageHas = new Set();
        imageHas.add(ihdr.type);

        for (let i = 1; i < imageChunks.length - 1; i++) {
            const chunk = imageChunks[i];
            imageHas.add(chunk.type);
            if (chunk.type === 'IDAT') {
                idatChunks.push(chunk);
            } else {
                preIdatChunks.push(chunk);
            }
        }

        // Inject missing global chunks
        for (const [type, chunk] of globalChunks) {
            if (!imageHas.has(type)) {
                preIdatChunks.push(chunk);
            }
        }

        // Sort pre-IDAT chunks by PNG spec ordering
        preIdatChunks.sort((a, b) => chunkOrderPriority(a.type) - chunkOrderPriority(b.type));

        // Calculate total size
        let totalSize = 8; // PNG signature
        const allChunks = [ihdr, ...preIdatChunks, ...idatChunks, iend];

        for (const chunk of allChunks) {
            totalSize += 12 + (chunk.data ? chunk.data.length : 0);
        }

        // Build the PNG buffer
        const png = new Uint8Array(totalSize);
        let writePos = 0;

        // PNG signature
        png.set(PNG_SIGNATURE, 0);
        writePos = 8;

        // Write each chunk
        for (const chunk of allChunks) {
            const built = buildPngChunk(chunk.type, chunk.data);
            png.set(built, writePos);
            writePos += built.length;
        }

        return new Blob([png], { type: 'image/png' });
    }

    // ========================================================================
    // MNGPlayer — Canvas-based animation renderer
    // ========================================================================

    class MNGPlayer {
        /**
         * @param {HTMLCanvasElement} canvas - The canvas element to render into
         * @param {Object} [options]
         * @param {boolean} [options.autoplay=true]    - Start playing automatically after load
         * @param {boolean} [options.loop]             - Override TERM loop count (true=infinite)
         * @param {string}  [options.background]       - CSS background color for transparent areas
         */
        constructor(canvas, options) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.options = options || {};

            /** @type {MNGParseResult|null} */
            this.data = null;

            /** @type {HTMLImageElement[]} decoded frame images */
            this._images = [];

            /** @type {string[]} blob URLs for cleanup */
            this._blobUrls = [];

            /** Animation state */
            this._playing = false;
            this._frameIndex = 0;
            this._iterationsLeft = 0;
            this._timerId = null;
            this._startTime = 0;
            this._disposed = false;
        }

        /**
         * Load and parse an MNG file from a URL or ArrayBuffer.
         * @param {string|ArrayBuffer|Uint8Array} source
         * @returns {Promise<void>}
         */
        async load(source) {
            this.stop();
            this._cleanup();

            let arrayBuffer;
            if (typeof source === 'string') {
                const response = await fetch(source);
                if (!response.ok) throw new Error('Failed to fetch MNG: ' + response.status);
                arrayBuffer = await response.arrayBuffer();
            } else if (source instanceof ArrayBuffer) {
                arrayBuffer = source;
            } else if (source instanceof Uint8Array) {
                arrayBuffer = source.buffer.slice(
                    source.byteOffset, source.byteOffset + source.byteLength
                );
            } else {
                throw new Error('Unsupported source type');
            }

            // Parse the MNG structure
            this.data = parseMNG(new Uint8Array(arrayBuffer));

            // Set canvas dimensions
            this.canvas.width = this.data.width;
            this.canvas.height = this.data.height;

            // Decode all frames as Image elements (parallel)
            this._images = [];
            this._blobUrls = [];

            const decodePromises = this.data.frames.map((frame, index) => {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(frame.pngBlob);
                    this._blobUrls.push(url);

                    const img = new Image();
                    img.onload = () => {
                        this._images[index] = img;
                        resolve();
                    };
                    img.onerror = () => {
                        // Create a fallback blank image on decode error
                        console.warn('MNG: failed to decode frame ' + index);
                        this._images[index] = null;
                        resolve();
                    };
                    img.src = url;
                });
            });

            await Promise.all(decodePromises);

            // Determine loop count
            if (this.options.loop === true) {
                this._iterationsLeft = -1; // infinite
            } else if (this.options.loop === false) {
                this._iterationsLeft = 1;
            } else if (typeof this.options.loop === 'number') {
                this._iterationsLeft = this.options.loop;
            } else {
                // Use TERM iteration count
                // TERM iteration_count: 0x7FFFFFFF = infinite, otherwise use as-is
                const tc = this.data.loopCount;
                if (tc === 0 || tc >= 0x7FFFFFFF) {
                    this._iterationsLeft = -1; // infinite
                } else {
                    this._iterationsLeft = tc;
                }
            }

            // Draw first frame
            this._frameIndex = 0;
            this._renderFrame(0);

            // Autoplay
            if (this.options.autoplay !== false && this.data.frames.length > 1) {
                this.play();
            }
        }

        /** Start or resume animation playback */
        play() {
            if (this._playing || !this.data || this.data.frames.length <= 1) return;
            this._playing = true;
            this._scheduleNextFrame();
        }

        /** Pause animation */
        pause() {
            this._playing = false;
            if (this._timerId !== null) {
                clearTimeout(this._timerId);
                this._timerId = null;
            }
        }

        /** Stop and reset to first frame */
        stop() {
            this.pause();
            this._frameIndex = 0;
            if (this.data) {
                const tc = this.data.loopCount;
                if (this.options.loop === true) {
                    this._iterationsLeft = -1;
                } else if (tc === 0 || tc >= 0x7FFFFFFF) {
                    this._iterationsLeft = -1;
                } else {
                    this._iterationsLeft = tc;
                }
                this._renderFrame(0);
            }
        }

        /** @returns {boolean} */
        get playing() {
            return this._playing;
        }

        /** @returns {number} Current frame index */
        get currentFrame() {
            return this._frameIndex;
        }

        /** @returns {number} Total number of frames */
        get frameCount() {
            return this.data ? this.data.frames.length : 0;
        }

        /** Clean up blob URLs and resources */
        dispose() {
            this.stop();
            this._cleanup();
            this._disposed = true;
        }

        // -- Private methods --

        _cleanup() {
            for (const url of this._blobUrls) {
                URL.revokeObjectURL(url);
            }
            this._blobUrls = [];
            this._images = [];
            this.data = null;
        }

        _scheduleNextFrame() {
            if (!this._playing || !this.data) return;

            const frame = this.data.frames[this._frameIndex];
            const delay = Math.max(frame.delayMs, 1); // Minimum 1ms

            this._timerId = setTimeout(() => {
                this._timerId = null;
                if (!this._playing) return;

                let nextFrame = this._frameIndex + 1;

                if (nextFrame >= this.data.frames.length) {
                    // End of sequence — check loop
                    if (this._iterationsLeft === -1) {
                        // Infinite loop
                        nextFrame = 0;
                    } else if (this._iterationsLeft > 1) {
                        this._iterationsLeft--;
                        nextFrame = 0;
                    } else {
                        // Done
                        this._playing = false;
                        return;
                    }
                }

                this._frameIndex = nextFrame;
                this._renderFrame(nextFrame);
                this._scheduleNextFrame();
            }, delay);
        }

        _renderFrame(index) {
            if (!this.data || this._disposed) return;

            const ctx = this.ctx;
            const frame = this.data.frames[index];
            const img = this._images[index];

            // Handle framing modes:
            // Mode 1: No background restore (except first frame)
            // Mode 2: No background restore, delay only on last layer
            // Mode 3: Clear to background before each layer
            // Mode 4: Clear to background before first layer of subframe
            const shouldClearBackground =
                index === 0 ||          // Always clear for first frame
                frame.framingMode === 3 ||
                frame.framingMode === 4;

            if (shouldClearBackground) {
                // Clear to transparent
                ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

                // Only fill with BACK color if mandatory (mandatory_background=1).
                // Advisory backgrounds are ignored to preserve canvas transparency,
                // which is what web users expect (page background shows through).
                if (this.options.background) {
                    // Explicit background from options always takes priority
                    ctx.fillStyle = this.options.background;
                    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                } else if (this.data.bgColor && this.data.bgMandatory) {
                    const [r, g, b] = this.data.bgColor;
                    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
                    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                }
            }

            // Draw the frame image
            if (img) {
                ctx.drawImage(img, frame.x, frame.y);
            }
        }
    }

    // ========================================================================
    // Polyfill: Auto-detect and replace <img> tags with .mng sources
    // ========================================================================

    function isMngUrl(url) {
        if (!url) return false;
        // Strip query/hash and check extension
        const path = url.split('?')[0].split('#')[0];
        return path.toLowerCase().endsWith('.mng');
    }

    function polyfillImg(img) {
        if (img._mngPolyfilled) return;
        img._mngPolyfilled = true;

        const src = img.src || img.getAttribute('data-mng-src');
        if (!src) return;

        // Create a canvas replacement
        const canvas = document.createElement('canvas');

        // Copy relevant attributes
        canvas.className = img.className;
        canvas.id = img.id;
        canvas.title = img.title || img.alt || '';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', img.alt || 'Animated MNG image');

        // Copy inline styles
        if (img.style.cssText) {
            canvas.style.cssText = img.style.cssText;
        }

        // Copy data attributes
        for (const attr of img.attributes) {
            if (attr.name.startsWith('data-') && attr.name !== 'data-mng-src') {
                canvas.setAttribute(attr.name, attr.value);
            }
        }

        // Transfer width/height if set as attributes
        if (img.hasAttribute('width')) {
            canvas.style.width = img.getAttribute('width') + 'px';
        }
        if (img.hasAttribute('height')) {
            canvas.style.height = img.getAttribute('height') + 'px';
        }

        const player = new MNGPlayer(canvas, {
            autoplay: true,
            background: img.getAttribute('data-mng-bg') || null
        });

        // Replace the img with canvas
        if (img.parentNode) {
            img.parentNode.replaceChild(canvas, img);
        }

        // Store player reference so it can be accessed later
        canvas._mngPlayer = player;

        // Load the MNG file
        player.load(src).catch(function (err) {
            console.warn('MNG polyfill: failed to load ' + src, err);
            // Restore original img on failure, but keep _mngPolyfilled = true
            // so the MutationObserver won't re-trigger an infinite retry loop
            if (canvas.parentNode) {
                img._mngFailed = true;
                canvas.parentNode.replaceChild(img, canvas);
            }
        });
    }

    function scanForMngImages() {
        // Scan for <img> tags with .mng src
        const images = document.querySelectorAll('img[src$=".mng"], img[src$=".MNG"], img[data-mng-src]');
        for (const img of images) {
            if (isMngUrl(img.src) || img.hasAttribute('data-mng-src')) {
                polyfillImg(img);
            }
        }
    }

    /**
     * Watch for dynamically added MNG images.
     */
    function observeNewImages() {
        if (typeof MutationObserver === 'undefined') return;

        const observer = new MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'IMG' && (isMngUrl(node.src) || node.hasAttribute('data-mng-src'))) {
                        polyfillImg(node);
                    }
                    // Also check children
                    if (node.querySelectorAll) {
                        const imgs = node.querySelectorAll('img[src$=".mng"], img[src$=".MNG"], img[data-mng-src]');
                        for (const img of imgs) {
                            polyfillImg(img);
                        }
                    }
                }
            }
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    function init() {
        scanForMngImages();
        observeNewImages();
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOM already ready — run on next tick to allow script to complete
        setTimeout(init, 0);
    }

    // ========================================================================
    // Public API
    // ========================================================================

    global.MNGPlayer = MNGPlayer;
    global.MNGPolyfill = {
        parseMNG: parseMNG,
        scan: scanForMngImages,
        Player: MNGPlayer
    };

})(typeof window !== 'undefined' ? window : this);
