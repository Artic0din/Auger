import type { AppOptions } from "./app.ts";
import { findAVPlay } from "./player/avplay.ts";
import { probeHdrPanel } from "./player/capabilities.ts";
import type { PublicStorage } from "./session/deviceIdentity.ts";
import { findTizenKeyManager } from "./session/secretStore.ts";

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function readProductString(method: string): string | undefined {
    const product = field(field(globalThis, "webapis"), "productinfo");
    const read = field(product, method);
    try {
        const value: unknown = typeof read === "function" ? read.call(product) : undefined;
        return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    } catch {
        return undefined;
    }
}

function modelName(): string {
    return readProductString("getRealModel") ?? "Samsung TV";
}

function tizenVersion(): string | undefined {
    const systeminfo = field(field(globalThis, "tizen"), "systeminfo");
    const read = field(systeminfo, "getCapability");
    try {
        const value: unknown = typeof read === "function" ? read.call(systeminfo, "http://tizen.org/feature/platform.version") : undefined;
        if (typeof value === "string" && value.trim() !== "") return `Tizen ${value.trim()}`;
    } catch {
        // Fall through to the user-agent token when Tizen systeminfo is absent.
    }
    const ua = typeof navigator === "object" && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
    const match = /Tizen\s+([0-9.]+)/i.exec(ua);
    return match?.[1] === undefined ? undefined : `Tizen ${match[1]}`;
}

function browserToken(): string | undefined {
    const ua = typeof navigator === "object" && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
    const match = /Chrome\/([0-9.]+)/i.exec(ua);
    return match?.[1] === undefined ? undefined : `Chrome/${match[1]}`;
}

function exit(): void {
    const manager = field(field(globalThis, "tizen"), "application");
    const getCurrent = field(manager, "getCurrentApplication");
    const current: unknown = typeof getCurrent === "function" ? getCurrent.call(manager) : undefined;
    const leave = field(current, "exit");
    if (typeof leave !== "function") {
        throw new Error("Application exit is unavailable");
    }
    leave.call(current);
}

function registerMediaKeys(): void {
    const input = field(field(globalThis, "tizen"), "tvinputdevice");
    const register = field(input, "registerKey");
    const supported = field(input, "getSupportedKeys");
    if (typeof register !== "function" || typeof supported !== "function") {
        return;
    }
    let keys: unknown;
    try { keys = supported.call(input); } catch { return; }
    if (!Array.isArray(keys)) return;
    for (const name of ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaRewind", "MediaFastForward"]) {
        if (!keys.some((key: unknown) => field(key, "name") === name)) continue;
        try { register.call(input, name); } catch {
            // A refused optional key must not prevent the other supported keys from registering.
        }
    }
}

export function platformOptions(appVersion: string): AppOptions {
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
        throw new Error("Secure random generation is unavailable");
    }
    let storage: PublicStorage | undefined;
    try {
        storage = window.localStorage;
    } catch {
        // The session core will use its explicit session-only path.
    }
    const randomBytes = (bytes: Uint8Array): void => { bytes.set(crypto.getRandomValues(new Uint8Array(bytes.length))); };
    const model = modelName();
    const firmware = readProductString("getFirmware");
    const os = tizenVersion();
    const browser = browserToken();
    const hdrSupported = probeHdrPanel().hdr10;
    const avplay = findAVPlay();
    registerMediaKeys();
    return {
        core: {
            fetch: (url, init) => window.fetch(url, init),
            publicStorage: storage,
            keyManager: findTizenKeyManager(),
            randomBytes,
            deviceName: model,
            devicePlatform: "tizen",
        },
        diagnostics: {
            appVersion,
            tvModel: model,
            ...(firmware === undefined ? {} : { firmware }),
            ...(os === undefined ? {} : { tizenVersion: os }),
            ...(browser === undefined ? {} : { browser }),
            hdrSupported,
        },
        player: avplay === undefined ? undefined : { avplay, randomBytes, model, appVersion },
        exit,
    };
}
