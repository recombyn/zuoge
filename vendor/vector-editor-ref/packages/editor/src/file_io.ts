/**
 * File I/O for native (protobuf) and .svg formats.
 * Uses the File System Access API for native save/open dialogs, with a
 * blob-download / <input type=file> fallback for browsers that lack it
 * (Firefox, Safari).
 *
 * This module is intentionally stateless: file handles and document identity
 * live on the Document / DocumentManager, not here. Callers pass the handle to
 * reuse (or null to force a picker) and receive back the handle that was
 * actually used so they can persist it.
 */
import type { Engine } from '../engine/pkg/engine';
import {
    type LoadResult,
    loadErrorMessage,
    parseLoadResult,
    repairNoticeMessage,
    reportLoadFailure,
    reportRepairs,
} from './load_status';

/** Outcome of a save. `handle` is null when the download fallback was used. */
export interface SaveResult {
    handle: FileSystemFileHandle | null;
}

/** Outcome of an open. `handle` is null when the <input> fallback was used. */
export interface OpenResult {
    handle: FileSystemFileHandle | null;
    name: string;
}

/**
 * Version of the editor written into every saved document, so a bug report can
 * say which build produced the file. Replaced at build time.
 */
export const APP_VERSION: string = (import.meta as any).env?.VITE_APP_VERSION ?? 'dev';

/** RFC-4122 v4 id, via crypto when available. */
function newUuid(): string {
    const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // Fallback for older Safari: still random, just assembled by hand.
    const bytes = new Uint8Array(16);
    if (c?.getRandomValues) c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Give the document a stable uuid and creation time if it doesn't have them,
 * and stamp the modification time and app version.
 *
 * The uuid is assigned once and preserved forever after — cloud sync uses it to
 * tell "the same document, edited twice" from "two documents", which filenames
 * cannot do.
 */
export function stampDocumentIdentity(engine: Engine, suggestedName?: string): void {
    const now = Date.now();
    const existingUuid = engine.get_document_uuid();
    const created = engine.get_document_created_at();
    const title =
        engine.get_document_title() || (suggestedName ? stripNativeExt(suggestedName) : '');
    engine.set_document_meta(
        existingUuid || newUuid(),
        created > 0 ? created : now,
        now,
        APP_VERSION,
        title,
    );
}

function stripNativeExt(name: string): string {
    return name.replace(/\.rcbvec$/i, '');
}

/**
 * Embed the font faces the document's text actually uses.
 *
 * Without this a native document is not self-contained: faces are fetched from a
 * CDN at render time, so the same document lays out differently offline, or
 * after the CDN reissues a family with different metrics. Only the
 * family/weight/italic combinations in use are embedded, and faces for text
 * that has since been deleted are pruned, so the file doesn't accumulate
 * megabytes of unused typefaces.
 *
 * Failures are non-fatal: a document that can't embed its fonts is still worth
 * saving, it just falls back to the CDN on open as before.
 */
export async function embedRequiredFonts(engine: Engine): Promise<void> {
    let required: Array<{ family: string; weight: number; italic: boolean }>;
    try {
        required = JSON.parse(engine.get_required_fonts_json());
    } catch {
        return;
    }
    if (!required.length) {
        engine.prune_unused_fonts();
        return;
    }

    const { getFaceBytes } = await import('./fonts');
    for (const face of required) {
        try {
            const bytes = await getFaceBytes(face.family, face.weight, face.italic);
            if (bytes) {
                engine.embed_font(
                    face.family,
                    face.weight,
                    face.italic,
                    new Uint8Array(bytes),
                    `fontsource:${face.family}`,
                );
            }
        } catch (e) {
            console.warn(`[file_io] could not embed "${face.family}":`, e);
        }
    }
    engine.prune_unused_fonts();
}

/**
 * Register any faces embedded in the freshly-loaded document.
 *
 * Called after every successful load, before the first paint, so text draws in
 * the face its author used rather than briefly flashing a CDN fallback.
 */
export async function adoptEmbeddedFonts(engine: Engine): Promise<number> {
    const count = engine.embedded_font_count();
    if (count === 0) return 0;

    // Bytes come across raw, one face at a time — the same way images do. The
    // earlier shape handed back every face base64-encoded inside a single JSON
    // blob, which for a typical 100-300 KB face meant building a string a third
    // larger than the payload in wasm, copying it out, parsing it, and decoding
    // it back to the bytes the engine already had.
    const faces = [];
    for (let i = 0; i < count; i++) {
        const bytes = engine.embedded_font_bytes(i);
        if (!bytes.length) continue;
        faces.push({
            family: engine.embedded_font_family(i),
            weight: engine.embedded_font_weight(i),
            italic: engine.embedded_font_italic(i),
            // `bytes` is a fresh copy owned by JS, so the buffer is safe to keep.
            bytes: bytes.buffer as ArrayBuffer,
        });
    }
    if (!faces.length) return 0;

    const { registerEmbeddedFaces } = await import('./fonts');
    return registerEmbeddedFaces(faces);
}

/** No repairs — the shape `LoadResult.repairs` expects for a clean load. */
const EMPTY_REPAIRS = {
    duplicate_ids: 0,
    dangling_roots: 0,
    dangling_children: 0,
    cycles_broken: 0,
    reparented: 0,
    orphans_rehomed: 0,
    missing_images: 0,
    coords_clamped: 0,
} as const;

/** True when the native File System Access API is available. */
export function hasFileSystemAccess(): boolean {
    return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}

/**
 * A native (protobuf) document. `.svg` is not native: it imports and
 * must be re-saved via Save As.
 */
export function isNativeDoc(name: string): boolean {
    return /\.rcbvec$/i.test(name);
}

export class FileIO {
    /**
     * Save the current scene to `handle` if given (save-in-place); otherwise
     * show a Save As dialog. Returns the handle used, or `null` on user-abort
     * so the caller can leave dirty state untouched.
     */
    static async saveNative(
        engine: Engine,
        handle: FileSystemFileHandle | null,
        suggestedName = 'untitled.rcbvec',
    ): Promise<SaveResult | null> {
        const bytes = await FileIO.prepareBytes(engine, suggestedName);

        if (handle) {
            await FileIO.writeToHandle(handle, bytes);
            return { handle };
        }
        return FileIO.saveNativeAs(engine, suggestedName);
    }

    /**
     * Serialize the document for writing to disk: stamp its identity, embed the
     * fonts its text needs, then encode.
     *
     * Kept separate from `serialize_proto` because those two steps are *save*
     * concerns, not serialization concerns — the engine must not invent a
     * timestamp or reach for the network during the byte-exact snapshot that
     * every undo step takes.
     */
    static async prepareBytes(engine: Engine, suggestedName?: string): Promise<Uint8Array> {
        stampDocumentIdentity(engine, suggestedName);
        await embedRequiredFonts(engine);
        return new Uint8Array(engine.serialize_proto());
    }

    /**
     * Save As — always shows the picker (or downloads on fallback).
     * Returns null on user-abort.
     */
    static async saveNativeAs(
        engine: Engine,
        suggestedName = 'untitled.rcbvec',
    ): Promise<SaveResult | null> {
        const bytes = await FileIO.prepareBytes(engine, suggestedName);

        if ('showSaveFilePicker' in window) {
            try {
                const handle = await (window as any).showSaveFilePicker({
                    suggestedName,
                    types: [
                        {
                            description: 'Document',
                            accept: { 'application/octet-stream': ['.rcbvec'] },
                        },
                    ],
                });
                await FileIO.writeToHandle(handle, bytes);
                return { handle };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
                // Fall through to download fallback
            }
        }

        FileIO.downloadBlob(new Uint8Array(bytes), suggestedName, 'application/octet-stream');
        return { handle: null };
    }

    /**
     * Show an open dialog for native / .svg. Loads the picked file into `engine`
     * and returns its handle + name, or null on abort / load failure.
     */
    static async openFile(
        engine: Engine,
        fallbackParser?: (svgText: string) => void,
    ): Promise<OpenResult | null> {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [
                        {
                            description: 'Document or SVG files',
                            accept: {
                                'application/octet-stream': ['.rcbvec'],
                                'image/svg+xml': ['.svg'],
                            },
                        },
                    ],
                    multiple: false,
                });

                const file = await handle.getFile();
                const loaded = await FileIO.loadFile(engine, file, fallbackParser);
                if (!loaded) return null;
                // Only native documents get a reusable save-in-place handle; an
                // imported .svg should save to a new native doc via Save As.
                const isNative = isNativeDoc(file.name);
                return { handle: isNative ? handle : null, name: file.name };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
            }
        }

        return FileIO.openViaInput(engine, fallbackParser);
    }

    /**
     * Show an open dialog and return the picked file + handle WITHOUT loading
     * it. Lets the caller create/activate the target document first, so an SVG
     * import (which parses into the active engine) lands in the new tab.
     */
    static async pickFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
        if ('showOpenFilePicker' in window) {
            try {
                const [handle] = await (window as any).showOpenFilePicker({
                    types: [
                        {
                            description: 'Document or SVG files',
                            accept: {
                                'application/octet-stream': ['.rcbvec'],
                                'image/svg+xml': ['.svg'],
                            },
                        },
                    ],
                    multiple: false,
                });
                const file = await handle.getFile();
                return { file, handle };
            } catch (e: unknown) {
                if (e instanceof DOMException && e.name === 'AbortError') return null;
            }
        }

        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.rcbvec,.svg';
            input.onchange = () => {
                const file = input.files?.[0];
                resolve(file ? { file, handle: null } : null);
            };
            input.click();
        });
    }

    /**
     * Load a document into `engine`, reporting the outcome to the user.
     *
     * Returns false on failure — and, critically, the engine's scene is
     * untouched in that case, so the caller can leave the current document
     * exactly as it was.
     */
    static async loadFile(
        engine: Engine,
        file: File,
        fallbackParser?: (svgText: string) => void,
    ): Promise<boolean> {
        const result = await FileIO.loadFileDetailed(engine, file, fallbackParser);
        return result.ok;
    }

    /**
     * As `loadFile`, but returns *why* it failed rather than just whether it
     * did. Also surfaces the message to the user: a file that refuses to open
     * because it is newer than this build is the one case where saying nothing
     * would be actively misleading.
     */
    static async loadFileDetailed(
        engine: Engine,
        file: File,
        fallbackParser?: (svgText: string) => void,
    ): Promise<LoadResult> {
        const result = await FileIO.loadFileQuiet(engine, file, fallbackParser);
        FileIO.announce(result, file.name);
        return result;
    }

    /** Load without notifying the user — for callers that render their own UI. */
    static async loadFileQuiet(
        engine: Engine,
        file: File,
        fallbackParser?: (svgText: string) => void,
    ): Promise<LoadResult> {
        let result: LoadResult;
        if (isNativeDoc(file.name)) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            result = parseLoadResult(engine.load_document(bytes));
        } else {
            // SVG: check for embedded protobuf payload
            const text = await file.text();
            result = FileIO.loadSVGTextDetailed(engine, text, fallbackParser);
        }
        if (result.ok) await adoptEmbeddedFonts(engine);
        return result;
    }

    /** Show the user the outcome of a load, when there is something to say. */
    static announce(result: LoadResult, fileName?: string): void {
        if (!result.ok) {
            reportLoadFailure(loadErrorMessage(result, fileName));
        } else if (result.repaired) {
            reportRepairs(repairNoticeMessage(result, fileName));
        }
    }

    /**
     * Parse SVG text and load it. Checks for an embedded native:data payload first.
     * If no payload is found and a fallback parser callback is provided, it is called with the raw SVG text.
     */
    static loadSVGText(
        engine: Engine,
        text: string,
        fallbackParser?: (svgText: string) => void,
    ): boolean {
        return FileIO.loadSVGTextDetailed(engine, text, fallbackParser).ok;
    }

    static loadSVGTextDetailed(
        engine: Engine,
        text: string,
        fallbackParser?: (svgText: string) => void,
    ): LoadResult {
        // Check for an embedded protobuf payload.
        const match = text.match(/<rcbvec:data[^>]*>([\s\S]*?)<\/rcbvec:data>/);
        if (match) {
            const result = parseLoadResult(engine.load_document_base64(match[1].trim()));
            // A payload that is merely *newer* than this build must not fall
            // through to the plain-SVG parser: the SVG is a lossy rendering of
            // the same document, so importing it would look like success while
            // quietly discarding everything the payload carried.
            if (result.ok || result.error === 'too_new' || result.error === 'container_too_new') {
                return result;
            }
            console.warn('[file_io] embedded native payload unreadable:', result.detail);
        }

        // Fallback to standard SVG parsing via UI parser
        if (fallbackParser) {
            fallbackParser(text);
            return { ok: true, repaired: false, summary: '', repairs: EMPTY_REPAIRS };
        }

        console.warn(
            'No native:data payload found in SVG. Standard SVG import not yet implemented.',
        );
        return {
            ok: false,
            error: 'unparseable',
            detail: 'no native payload and no SVG parser available',
            requiredVersion: 0,
            supportedVersion: 0,
        };
    }

    /**
     * Export SVG with embedded protobuf payload.
     * Takes the SVG string from the existing export and injects the payload.
     */
    static embedPayloadInSVG(engine: Engine, svgContent: string): string {
        const b64 = engine.serialize_proto_base64();

        // Inject the namespace and metadata right after the opening <svg> tag
        const svgWithNs = svgContent.replace(
            '<svg xmlns="http://www.w3.org/2000/svg"',
            '<svg xmlns="http://www.w3.org/2000/svg"\n     xmlns:rcbvec="https://rcb.local/ns"',
        );

        // Insert metadata block right after the opening tag
        const closingBracket = svgWithNs.indexOf('>');
        if (closingBracket === -1) return svgContent;

        const before = svgWithNs.slice(0, closingBracket + 1);
        const after = svgWithNs.slice(closingBracket + 1);

        return (
            before +
            `\n  <metadata>\n    <rcbvec:data version="${engine.get_format_version()}">\n${b64}\n    </rcbvec:data>\n  </metadata>` +
            after
        );
    }

    // ─── Private Helpers ────────────────────────────────────────────────────

    private static async writeToHandle(
        handle: FileSystemFileHandle,
        data: Uint8Array | number[],
    ): Promise<void> {
        const writable = await (handle as any).createWritable();
        await writable.write(data instanceof Uint8Array ? data : new Uint8Array(data));
        await writable.close();
    }

    private static downloadBlob(data: Uint8Array, filename: string, mime: string): void {
        const blob = new Blob(
            [data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer],
            { type: mime },
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    private static openViaInput(
        engine: Engine,
        fallbackParser?: (svgText: string) => void,
    ): Promise<OpenResult | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.rcbvec,.svg';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                const loaded = await FileIO.loadFile(engine, file, fallbackParser);
                resolve(loaded ? { handle: null, name: file.name } : null);
            };
            input.click();
        });
    }
}
