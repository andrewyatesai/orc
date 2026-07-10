/**
 * Parser-free PHOSPHOR overlay for an external browser terminal.
 *
 * The host writes `rows*cols*4` `u32` words at [`Self::staging_ptr`] in
 * row-major `scalar,fg,bg,flags` order, then calls [`Self::sync_snapshot`].
 * The core copies/scans only when `revision` or a sampling gate changes.
 */
export class AtermRainOverlay {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AtermRainOverlayFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_atermrainoverlay_free(ptr, 0);
    }
    /**
     * Advance the injected animation clock from a requestAnimationFrame delta.
     * Fractional milliseconds accumulate; non-finite/non-positive input is ignored.
     * @param {number} dt_ms
     */
    advance_effects(dt_ms) {
        wasm.atermrainoverlay_advance_effects(this.__wbg_ptr, dt_ms);
    }
    /**
     * Atlas height in texels.
     * @returns {number}
     */
    atlas_height() {
        const ret = wasm.atermrainoverlay_atlas_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Straight-alpha atlas byte length.
     * @returns {number}
     */
    atlas_len() {
        const ret = wasm.atermrainoverlay_atlas_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Straight-alpha RGBA8 atlas pointer, or zero with no visible frame.
     * @returns {number}
     */
    atlas_ptr() {
        const ret = wasm.atermrainoverlay_atlas_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Monotonic atlas generation; cache WebGL uploads against this value.
     * @returns {bigint}
     */
    atlas_version() {
        const ret = wasm.atermrainoverlay_atlas_version(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Atlas width in texels.
     * @returns {number}
     */
    atlas_width() {
        const ret = wasm.atermrainoverlay_atlas_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Semantic default-background cell flag.
     * @returns {number}
     */
    cell_flag_default_background() {
        const ret = wasm.atermrainoverlay_cell_flag_default_background(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Inline-image/host-visual cell flag.
     * @returns {number}
     */
    cell_flag_inline_image() {
        const ret = wasm.atermrainoverlay_cell_flag_inline_image(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Overline cell flag.
     * @returns {number}
     */
    cell_flag_overline() {
        const ret = wasm.atermrainoverlay_cell_flag_overline(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Current host selection cell flag.
     * @returns {number}
     */
    cell_flag_selected() {
        const ret = wasm.atermrainoverlay_cell_flag_selected(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Strikethrough cell flag.
     * @returns {number}
     */
    cell_flag_strikethrough() {
        const ret = wasm.atermrainoverlay_cell_flag_strikethrough(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Any-underline cell flag.
     * @returns {number}
     */
    cell_flag_underline() {
        const ret = wasm.atermrainoverlay_cell_flag_underline(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Wide-glyph continuation cell flag.
     * @returns {number}
     */
    cell_flag_wide_continuation() {
        const ret = wasm.atermrainoverlay_cell_flag_wide_continuation(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Four u32 lanes per staging cell: `scalar,fg,bg,flags`.
     * @returns {number}
     */
    cell_words() {
        const ret = wasm.atermrainoverlay_cell_flag_underline(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Visible staging columns.
     * @returns {number}
     */
    get cols() {
        const ret = wasm.atermrainoverlay_cols(this.__wbg_ptr);
        return ret;
    }
    /**
     * Emit one effects-only frame and repack resident typed-array output.
     * @param {number} cell_w
     * @param {number} cell_h
     * @returns {bigint}
     */
    emit(cell_w, cell_h) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_emit(retptr, this.__wbg_ptr, cell_w, cell_h);
            var r0 = getDataViewMemory0().getBigInt64(retptr + 8 * 0, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            return BigInt.asUintN(64, r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Ten u32 lanes per emitted halo.
     * @returns {number}
     */
    halo_words() {
        const ret = wasm.atermrainoverlay_halo_words(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packed halo length in u32 words.
     * @returns {number}
     */
    halos_len_words() {
        const ret = wasm.atermrainoverlay_halos_len_words(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packed halo word pointer. Read exactly [`Self::halos_len_words`].
     * @returns {number}
     */
    halos_ptr() {
        const ret = wasm.atermrainoverlay_halos_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Whether a shared host ticker should remain armed.
     * @returns {boolean}
     */
    is_active() {
        const ret = wasm.atermrainoverlay_is_active(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Construct an enabled overlay with MatrixRain defaults.
     *
     * `seed_hi:seed_lo` forms the deterministic 64-bit replay seed. The
     * constructor allocates all bounded output storage up front; only staging
     * geometry and atlas generations may grow wasm memory later.
     * @param {number} rows
     * @param {number} cols
     * @param {number} default_bg
     * @param {number} theme_fg
     * @param {number} seed_lo
     * @param {number} seed_hi
     */
    constructor(rows, cols, default_bg, theme_fg, seed_lo, seed_hi) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_new(retptr, rows, cols, default_bg, theme_fg, seed_lo, seed_hi);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0 >>> 0;
            AtermRainOverlayFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Note wheel/PgUp input in an alternate-screen TUI.
     */
    note_alt_scroll() {
        wasm.atermrainoverlay_note_alt_scroll(this.__wbg_ptr);
    }
    /**
     * Note a visual bell.
     */
    note_bell() {
        wasm.atermrainoverlay_note_bell(this.__wbg_ptr);
    }
    /**
     * Note command completion; `failed` selects the bounded ember tint.
     * @param {boolean} failed
     */
    note_exit_status(failed) {
        wasm.atermrainoverlay_note_exit_status(this.__wbg_ptr, failed);
    }
    /**
     * Note one user keystroke.
     */
    note_keystroke() {
        wasm.atermrainoverlay_note_keystroke(this.__wbg_ptr);
    }
    /**
     * Occupied but non-single-scalar staging value.
     * @returns {number}
     */
    opaque_scalar() {
        const ret = wasm.atermrainoverlay_opaque_scalar(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Twelve u32 lanes per emitted glyph quad.
     * @returns {number}
     */
    quad_words() {
        const ret = wasm.atermrainoverlay_quad_words(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packed glyph-quad length in u32 words.
     * @returns {number}
     */
    quads_len_words() {
        const ret = wasm.atermrainoverlay_quads_len_words(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Packed glyph-quad word pointer. Read exactly [`Self::quads_len_words`].
     * @returns {number}
     */
    quads_ptr() {
        const ret = wasm.atermrainoverlay_quads_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Resize and clear the persistent cell staging buffer.
     *
     * Existing capacity is reused; shrinking never shrinks allocation. The
     * host must reacquire the typed-array view and fill all lanes before sync.
     * @param {number} rows
     * @param {number} cols
     */
    resize_staging(rows, cols) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_resize_staging(retptr, this.__wbg_ptr, rows, cols);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Number of u32 row flags.
     * @returns {number}
     */
    row_flags_len() {
        const ret = wasm.atermrainoverlay_row_flags_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Byte offset of one u32 row flag per visible row.
     *
     * Zero means ordinary single-width geometry; any nonzero value protects
     * the entire DEC double-width/double-height row from fixed-cell rain.
     * @returns {number}
     */
    row_flags_ptr() {
        const ret = wasm.atermrainoverlay_row_flags_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Visible staging rows.
     * @returns {number}
     */
    get rows() {
        const ret = wasm.atermrainoverlay_rows(this.__wbg_ptr);
        return ret;
    }
    /**
     * Configure body/head alpha. Negative values select theme-derived alpha.
     * @param {number} alpha
     * @param {number} head_alpha
     */
    set_alpha(alpha, head_alpha) {
        wasm.atermrainoverlay_set_alpha(this.__wbg_ptr, alpha, head_alpha);
    }
    /**
     * Configure reading/turn/bell/literal-material behaviors.
     * @param {boolean} suppress_in_alt_screen
     * @param {boolean} turn_wave
     * @param {boolean} bell_alert
     * @param {boolean} output_material
     */
    set_behavior(suppress_in_alt_screen, turn_wave, bell_alert, output_material) {
        wasm.atermrainoverlay_set_behavior(this.__wbg_ptr, suppress_in_alt_screen, turn_wave, bell_alert, output_material);
    }
    /**
     * Enable/disable the engine. Enabling requires a fresh sync before emit.
     * @param {boolean} enabled
     */
    set_enabled(enabled) {
        wasm.atermrainoverlay_set_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Copy at most five recently damaged composer rows for a hidden cursor.
     * This is an event-time tiny typed-array copy, not a per-frame object list.
     * @param {Uint16Array} rows
     */
    set_hidden_cursor_rows(rows) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray16ToWasm0(rows, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.atermrainoverlay_set_hidden_cursor_rows(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Set hue: 0 matrix, 1 theme foreground, 2 custom `0x00RRGGBB`.
     * @param {number} mode
     * @param {number} custom
     */
    set_hue(mode, custom) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_set_hue(retptr, this.__wbg_ptr, mode, custom);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Set live cursor/scroll/alternate-screen state.
     *
     * Negative cursor coordinates mean DECTCEM-hidden/unknown cursor. A cursor
     * row or reading-mode change unpublishes the old frame and requires
     * `sync_snapshot` (the revision may stay unchanged); the core then updates
     * sampling/gates without rebuilding occupancy.
     * @param {number} cursor_row
     * @param {number} cursor_col
     * @param {number} display_offset
     * @param {boolean} is_alt_screen
     */
    set_live_state(cursor_row, cursor_col, display_offset, is_alt_screen) {
        wasm.atermrainoverlay_set_live_state(this.__wbg_ptr, cursor_row, cursor_col, display_offset, is_alt_screen);
    }
    /**
     * Configure tick/density/speed/trail/material mutation and idle sleep.
     * @param {number} fps
     * @param {number} density
     * @param {number} speed
     * @param {number} trail
     * @param {number} mutation_ms
     * @param {number} idle_secs
     */
    set_rate(fps, density, speed, trail, mutation_ms, idle_secs) {
        wasm.atermrainoverlay_set_rate(this.__wbg_ptr, fps, density, speed, trail, mutation_ms, idle_secs);
    }
    /**
     * Accessibility motion gate. Either transition requires a fresh sync.
     * @param {boolean} reduced
     */
    set_reduced_motion(reduced) {
        wasm.atermrainoverlay_set_reduced_motion(this.__wbg_ptr, reduced);
    }
    /**
     * Replace the deterministic replay seed.
     * @param {number} seed_lo
     * @param {number} seed_hi
     */
    set_seed(seed_lo, seed_hi) {
        wasm.atermrainoverlay_set_seed(this.__wbg_ptr, seed_lo, seed_hi);
    }
    /**
     * Change theme colors (`0x00RRGGBB`). A fresh cell fill/sync is required.
     * @param {number} default_bg
     * @param {number} theme_fg
     */
    set_theme(default_bg, theme_fg) {
        wasm.atermrainoverlay_set_theme(this.__wbg_ptr, default_bg, theme_fg);
    }
    /**
     * Set visibility: 0 focused, 1 visible-unfocused, 2 hidden.
     * @param {number} state
     */
    set_visibility(state) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_set_visibility(retptr, this.__wbg_ptr, state);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Active staging length in u32 words.
     * @returns {number}
     */
    staging_len_words() {
        const ret = wasm.atermrainoverlay_staging_len_words(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Byte offset of the writable staging buffer in wasm linear memory.
     *
     * Build `new Uint32Array(wasm.memory.buffer, ptr, staging_len_words())`.
     * Never retain the view across a mutable wasm call.
     * @returns {number}
     */
    staging_ptr() {
        const ret = wasm.atermrainoverlay_staging_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Synchronize the authoritative cells currently in staging.
     *
     * Return codes: 0 unchanged, 1 literal material resampled, 2 occupancy
     * rescanned, 3 deferred by disabled/reduced/visibility drain. `revision`
     * must change for cell, selection, or row-attribute changes. Both clocks
     * are u32 and may wrap; a wrap safely rebases the weather sequence.
     * @param {number} revision
     * @param {number} content_seq
     * @returns {number}
     */
    sync_snapshot(revision, content_seq) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.atermrainoverlay_sync_snapshot(retptr, this.__wbg_ptr, revision, content_seq);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) AtermRainOverlay.prototype[Symbol.dispose] = AtermRainOverlay.prototype.free;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_7534b8e9a36f1ab4: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_export(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_8a6f238a6ece86ea: function() {
            const ret = new Error();
            return addHeapObject(ret);
        },
        __wbg_stack_0ed75d68575b0f3c: function(arg0, arg1) {
            const ret = getObject(arg1).stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./aterm_effects_web_bg.js": import0,
    };
}

const AtermRainOverlayFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_atermrainoverlay_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(128).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('aterm_effects_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
