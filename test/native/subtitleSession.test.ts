import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { SubtitleTruncated } from "../../src/api/http.ts";
import type { PlaybackDecision, PlaybackPlan, SelectedTracks, SubtitleTrack } from "../../src/contracts/v2/playback.ts";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import {
    downloadSubtitle,
    SUBTITLE_REFETCH_DELAYS_MS,
    SubtitleSession,
} from "../../src/player/subtitleSession.ts";
import type { NativeTextTrack } from "../../src/player/subtitleTransportRules.ts";
import type {
    PreparedTrackReplan,
    SubtitleFailure,
    SubtitleHost,
    SubtitlePostSettle,
    SubtitleTransportSnapshot,
} from "../../src/player/subtitleTypes.ts";
import type { PublicStorage } from "../../src/session/deviceIdentity.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

registerSourceCatalogs();

// --- In-memory test adapters (second adapter at the SubtitleHost seam) ---

class MemoryStorage implements PublicStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

interface ReplanAttempt {
    readonly plan: PlaybackPlan;
    readonly selected: SelectedTracks;
    readonly positionSeconds: number;
    sends: number;
}

class FakeSubtitleHost implements SubtitleHost {
    recordSwitch(): void {}
    recordCaption(): void {}
    live = true;
    plan: PlaybackPlan | undefined;
    started = true;
    presented = true;
    busy = false;
    hidden = false;
    restoring = false;
    recoveryActive = false;
    sourceSeconds = 10;
    playerTimeMs: number | undefined;
    audioVersions: SubtitleTransportSnapshot["audioVersions"] = undefined;

    textTracks: NativeTextTrack[] | undefined = [
        { index: 10, language: "eng" },
        { index: 12, language: "fra" },
    ];
    refuseSelectText = false;
    refuseSetSilent = false;
    selectedTextIndex: number | undefined;
    silentHistory: boolean[] = [];

    pendingSeek: Promise<void> | undefined;
    nextReplans: (() => Promise<PlaybackDecision>)[] = [];

    readonly replans: ReplanAttempt[] = [];
    readonly switches: ("blocking" | "non_blocking" | "reporting")[] = [];
    readonly keptPlans: PlaybackPlan[] = [];
    readonly adoptedPlans: { readonly plan: PlaybackPlan; readonly alignToPlayhead: boolean }[] = [];
    readonly settled: { readonly keepBusyIfSeeking: boolean; readonly postSettle: SubtitlePostSettle }[] = [];
    readonly failures: SubtitleFailure[] = [];
    changes = 0;
    reanchorFlushes = 0;
    closedForReplan = 0;
    recoveries = 0;
    sessionId = "sess-1";
    transportGen = 0;

    readonly nativeText = {
        canSelectInStream: true,
        listTextTracks: (): readonly NativeTextTrack[] | undefined => this.textTracks,
        selectTextTrack: (index: number): boolean => {
            if (this.refuseSelectText) return false;
            this.selectedTextIndex = index;
            return true;
        },
        setSilentSubtitle: (hidden: boolean): boolean => {
            if (this.refuseSetSilent) return false;
            this.silentHistory.push(hidden);
            return true;
        },
    };

    snapshot(): SubtitleTransportSnapshot {
        return {
            live: this.live,
            plan: this.plan,
            started: this.started,
            presented: this.presented,
            busy: this.busy,
            hidden: this.hidden,
            restoring: this.restoring,
            recoveryActive: this.recoveryActive,
            sourceSeconds: this.sourceSeconds,
            audioVersions: this.audioVersions,
        };
    }

    readPlayerTimeMs(): number | undefined {
        return this.playerTimeMs;
    }

    prepareTrackReplan(plan: PlaybackPlan, selected: SelectedTracks, positionSeconds: number): PreparedTrackReplan {
        const gen = this.transportGen;
        const record: ReplanAttempt = { plan, selected, positionSeconds, sends: 0 };
        this.replans.push(record);
        return {
            sessionId: this.sessionId,
            isCurrent: () => this.live && this.transportGen === gen,
            send: () => {
                record.sends += 1;
                const handler = this.nextReplans.shift();
                if (handler === undefined) return Promise.reject(new ApiError({ kind: "network" }));
                return handler();
            },
        };
    }

    async waitForPendingSeeks(): Promise<void> {
        while (this.pendingSeek !== undefined) {
            const p = this.pendingSeek;
            await p.catch(() => undefined);
            if (this.pendingSeek === p) break;
        }
    }

    changed(): void { this.changes += 1; }

    beginSwitch(mode: "blocking" | "non_blocking" | "reporting"): void {
        this.switches.push(mode);
        if (mode !== "non_blocking") this.busy = true;
        this.changes += 1;
    }

    keepPlan(plan: PlaybackPlan): void {
        this.plan = plan;
        this.keptPlans.push(plan);
    }

    adoptPlan(plan: PlaybackPlan, _serverFeatures: readonly string[], alignToPlayhead: boolean): void {
        this.transportGen += 1;
        this.plan = plan;
        this.busy = false;
        this.adoptedPlans.push({ plan, alignToPlayhead });
    }

    settleSwitch(keepBusyIfSeeking: boolean, postSettle: SubtitlePostSettle): void {
        if (!keepBusyIfSeeking || this.pendingSeek === undefined) this.busy = false;
        this.settled.push({ keepBusyIfSeeking, postSettle });
        this.changes += 1;
    }

    releaseBusyForReselect(): void { this.busy = false; }
    flushQueuedReanchor(): void { this.reanchorFlushes += 1; }
    closeForReplan(): void { this.started = false; this.closedForReplan += 1; }
    recoverConnection(): void { this.busy = false; this.recoveries += 1; }
    fail(error: SubtitleFailure): void { this.live = false; this.failures.push(error); }
    failFromStartError(): void { this.live = false; this.failures.push({ kind: "server" }); }
    failFromDecision(): void { this.live = false; this.failures.push({ kind: "server" }); }
    sessionFailure(): void { this.live = false; this.failures.push({ kind: "server" }); }
}

function track(id: string, overrides: Partial<SubtitleTrack> = {}): SubtitleTrack {
    return {
        trackId: id,
        combinedIndex: 0,
        source: "embedded",
        delivery: "sidecar",
        label: "English",
        language: "en",
        codec: "srt",
        forced: false,
        hearingImpaired: false,
        url: undefined,
        streamIndex: 10,
        containerTrackId: undefined,
        nativeSelectable: true,
        hlsRendition: undefined,
        ...overrides,
    };
}

function makePlan(origin: string, overrides: Partial<PlaybackPlan> = {}): PlaybackPlan {
    const en = track("file:42:subtitle:0", { combinedIndex: 0, language: "en", label: "English", streamIndex: 10, url: `${origin}/api/v2/captions/en.vtt?token=synthetic` });
    const fr = track("file:42:subtitle:1", { combinedIndex: 1, language: "fr", label: "French", streamIndex: 12, url: `${origin}/api/v2/captions/fr.vtt?token=synthetic` });
    return {
        planId: "plan-1",
        planAttemptKey: "key-1",
        effectiveMediaFileId: "42",
        delivery: "original_http",
        streamProtocol: "http",
        streamContainer: "mkv",
        streamUrl: `${origin}/api/v2/stream/42?st=tok1`,
        expiresAt: "2030-01-01T00:00:00Z",
        durationSeconds: 3600,
        sourceBitrateKbps: undefined,
        decisionReason: undefined,
        source: { container: "mkv", videoCodec: "h264", width: 1920, height: 1080, frameRate: 24, dynamicRange: "sdr", dolbyVisionProfile: undefined },
        timeline: { sourceStartSeconds: 0, playerStartSeconds: 0, streamOriginSeconds: 0, timelineOffsetSeconds: 0, canSeekAnywhere: true, seekWindowStartSeconds: undefined, seekWindowEndSeconds: undefined, seekRestoration: "direct" },
        selectedTracks: { audio: { id: "file:42:audio:0", index: 0 }, subtitle: { id: en.trackId } },
        subtitle: {
            mode: "render",
            trackId: en.trackId,
            artifact: { url: `${origin}/api/v2/captions/en.vtt?token=synthetic`, format: "vtt", origin: 0 },
            embedded: undefined,
            hlsRendition: undefined,
            inventory: [en, fr],
        },
        warnings: [],
        availableQualities: [],
        activeQuality: undefined,
        recipe: undefined,
        ...overrides,
    };
}

function makeHlsPlan(origin: string, selectedId: string | undefined, mode: PlaybackPlan["subtitle"]["mode"] = "render"): PlaybackPlan {
    const en = track("file:42:subtitle:0", { combinedIndex: 0, language: "en", label: "English", delivery: "unknown", hlsRendition: { groupId: "subs", name: "English", index: 1 } });
    const fr = track("file:42:subtitle:1", { combinedIndex: 1, language: "fr", label: "French", delivery: "unknown", hlsRendition: { groupId: "subs", name: "French", index: 2 } });
    const ext = track("file:42:subtitle:2", { combinedIndex: 2, source: "external", language: "de", label: "German", delivery: "sidecar", url: `${origin}/api/v2/captions/de.vtt?token=synthetic`, hlsRendition: undefined });
    const hlsRendition = selectedId === en.trackId
        ? { groupId: "subs", name: "English", index: 1, format: "vtt" }
        : selectedId === fr.trackId
            ? { groupId: "subs", name: "French", index: 2, format: "vtt" }
            : undefined;
    return makePlan(origin, {
        delivery: "server_remux_hls",
        streamProtocol: "hls",
        streamUrl: `${origin}/api/v2/hls/42/master.m3u8`,
        recipe: { videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, bitrateKbps: 8000, frameRate: 24, dynamicRange: "sdr", audioChannels: 2 },
        selectedTracks: { audio: { id: "file:42:audio:0", index: 0 }, ...(selectedId === undefined ? {} : { subtitle: { id: selectedId } }) },
        subtitle: {
            mode,
            trackId: selectedId,
            artifact: selectedId === ext.trackId ? { url: `${origin}/api/v2/captions/de.vtt?token=synthetic`, format: "vtt", origin: 0 } : undefined,
            embedded: undefined,
            hlsRendition,
            inventory: [en, fr, ext],
        },
    });
}

async function flush(clock: ManualClock, ms = 0): Promise<void> {
    await clock.advance(ms);
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function rig(storage?: PublicStorage) {
    const clock = new ManualClock();
    const h = await connected({ clock, fake: new FakeSilo(clock) });
    await signIn(h);
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    const host = new FakeSubtitleHost();
    const session = new SubtitleSession(
        { session: h.core.session, clock, publicStorage: storage, host },
        { contentId: "item-1", fileId: "42" },
        h.core.session.authoritySignal,
    );
    return { h, clock, host, session, profileId: owner.id };
}

function scriptModernSettings(fake: FakeSilo, deviceId: string, appearanceFontSize = "xlarge", syncMs = 500): void {
    fake.script("/settings/contract/capabilities", {
        status: 200,
        body: { api_version: 1, revision: "r1", manifest_revision: 19, state: "available", allowed: true, scopes: ["profile", "profile_device"], supports_batched_effective: true, supports_atomic_shortcuts: true, client_families: ["tv"] },
    });
    fake.script("/settings/contract", {
        status: 200,
        body: {
            api_version: 1,
            revision: 19,
            definitions: [
                { key: "playback.subtitle_appearance", introduced_in: 1, allowed_scopes: ["profile", "profile_device"] },
                { key: "player.subtitle_sync_ms", introduced_in: 1, allowed_scopes: ["profile", "profile_device"] },
            ],
        },
    });
    fake.script("/settings/values?scope=profile_device&keys=playback.subtitle_appearance", {
        status: 200,
        body: { revision: 19, items: [{ key: "playback.subtitle_appearance", scope: "profile_device", profile_id: "p-owner", device_id: deviceId, is_set: false }] },
    });
    fake.script("/settings/values?scope=profile_device&keys=player.subtitle_sync_ms", {
        status: 200,
        body: { revision: 19, items: [{ key: "player.subtitle_sync_ms", scope: "profile_device", profile_id: "p-owner", device_id: deviceId, is_set: false }] },
    });
    fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ ...DEFAULT_APPEARANCE, fontSize: appearanceFontSize }) } });
    fake.script("/settings/values/effective?keys=player.subtitle_sync_ms", { status: 200, body: { items: [{ key: "player.subtitle_sync_ms", value: syncMs }] } });
}

// --- 1. Truncation refetch (migrated from deleted subtitleRefetch.test.ts) ---

const cuesOf = (text: string): readonly string[] => text === "" ? [] : text.split(",");
const cut = (text: string) => (): string => { throw new SubtitleTruncated(text); };
const whole = (text: string) => (): string => text;
const failed = (): string => { throw new Error("Subtitle download failed"); };

function refetchRig(attempts: (() => string)[]) {
    const clock = new ManualClock();
    const shown: (readonly string[])[] = [];
    const abort = new AbortController();
    let fetched = 0;
    const run = downloadSubtitle(clock, abort.signal, async () => attempts[Math.min(fetched++, attempts.length - 1)]!(), cuesOf, cues => { shown.push(cues); });
    return { clock, shown, fetched: () => fetched, abort, run };
}

test("truncation refetch uses Apple's 2/5/10/10/10s delays and only upgrades to larger partials", async () => {
    assert.deepEqual(SUBTITLE_REFETCH_DELAYS_MS, [2000, 5000, 10000, 10000, 10000]);
    const r = refetchRig([cut("a,b,c"), cut("a"), cut("a,b,c,d"), cut("a,b,c,d"), cut("a,b,c,d,e"), whole("a,b,c,d,e,f")]);
    for (const [index, delay] of SUBTITLE_REFETCH_DELAYS_MS.entries()) {
        await r.clock.advance(delay - 1);
        assert.equal(r.fetched(), index + 1);
        await r.clock.advance(1);
    }
    assert.deepEqual(await r.run, ["a", "b", "c", "d", "e", "f"]);
    assert.equal(r.fetched(), 6);
    assert.deepEqual(r.shown.map(cues => cues.length), [3, 4, 5]);
});

test("truncation refetch caps at five retries, keeps empty cut, retries outright failure after cut, and stops on abort", async () => {
    const capped = refetchRig([cut("a,b,c"), cut("a"), cut("a,b"), cut("a"), cut("a"), cut("a")]);
    for (const delay of SUBTITLE_REFETCH_DELAYS_MS) await capped.clock.advance(delay);
    assert.deepEqual(await capped.run, ["a", "b", "c"]);
    await capped.clock.advance(60000);
    assert.equal(capped.fetched(), 6);

    const empty = refetchRig([cut("")]);
    for (const delay of SUBTITLE_REFETCH_DELAYS_MS) await empty.clock.advance(delay);
    assert.deepEqual(await empty.run, []);
    assert.deepEqual(empty.shown, [[]]);

    const firstFail = refetchRig([failed, whole("a")]);
    await assert.rejects(firstFail.run, /Subtitle download failed/);
    await firstFail.clock.advance(60000);
    assert.equal(firstFail.fetched(), 1);

    const retryAfterFail = refetchRig([cut("a"), failed, whole("a,b")]);
    await retryAfterFail.clock.advance(2000);
    await retryAfterFail.clock.advance(5000);
    assert.deepEqual(await retryAfterFail.run, ["a", "b"]);
    assert.equal(retryAfterFail.fetched(), 3);

    const aborted = refetchRig([cut("a"), whole("a,b")]);
    await aborted.clock.advance(1000);
    aborted.abort.abort();
    await assert.rejects(aborted.run);
    await aborted.clock.advance(60000);
    assert.equal(aborted.fetched(), 1);
});

// --- 2. Unified Profile subtitle preference read ---

test("modern settings contract reads effective appearance and sync delay exactly once per attempt", async () => {
    const storage = new MemoryStorage();
    const { h, clock, host, session, profileId } = await rig(storage);
    try {
        scriptModernSettings(h.fake, h.core.session.http.deviceId, "xxlarge", 1000);
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:12.000 --> 00:14.000\nHello" });
        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        host.sourceSeconds = 13.5;

        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        const display = session.trackViewSlice(plan).subtitleTools?.display;
        assert.equal(display?.styling, true, "SubtitleDisplay loaded modern styling contract");
        assert.equal(display?.delay, true, "SubtitleDisplay loaded modern delay contract");

        const appearanceReads = h.fake.requests.filter(req => req.path.startsWith("/settings/subtitle-appearance/effective"));
        const syncReads = h.fake.requests.filter(req => req.path === "/settings/values/effective?keys=player.subtitle_sync_ms");
        assert.equal(appearanceReads.length, 1, "effective appearance is read once, not duplicated between SubtitleDisplay and caption loader");
        assert.equal(syncReads.length, 1, "effective sync delay is read once");

        const captions = session.captionsView(plan, false);
        assert.equal(captions?.appearance.fontSize, "xxlarge");
        assert.equal(captions?.text, "Hello");
        assert.equal(captions?.instant, 12.5);
    } finally { session.destroy(); }
});

test("legacy 404 settings server defers preference read until an artifact loads and notices failures", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        const noSubsPlan = makePlan(h.fake.origin, {
            selectedTracks: { audio: { id: "file:42:audio:0", index: 0 } },
            subtitle: { mode: "off", trackId: undefined, artifact: undefined, embedded: undefined, hlsRendition: undefined, inventory: [] },
        });
        host.plan = noSubsPlan;
        session.onPlanAdopted(noSubsPlan, profileId);
        await flush(clock);
        assert.equal(h.fake.requests.filter(req => req.path.startsWith("/settings/subtitle-appearance")).length, 0, "no preference read when no artifact loaded");

        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:05.000 --> 00:15.000\nLine" });
        h.fake.script("/settings/subtitle-appearance/effective", { status: 500 });
        h.fake.script("/settings/values/effective?keys=player.subtitle_sync_ms", { status: 500 });
        const artifactPlan = makePlan(h.fake.origin);
        host.plan = artifactPlan;
        session.onPlanAdopted(artifactPlan, profileId);
        await flush(clock);

        assert.equal(h.fake.requests.filter(req => req.path.startsWith("/settings/subtitle-appearance")).length, 1);
        assert.ok(session.trackViewSlice(artifactPlan).notices.includes("Some subtitle preferences could not be loaded; using defaults."));
    } finally { session.destroy(); }
});

test("partial modern contract fetches only the missing setting and preserves edited appearance when legacy delay lands", async () => {
    // 1. Styling-only modern contract: appearance read once via SubtitleDisplay, delay read lazily; editing fontSize must not drop pending delay.
    {
        const storage = new MemoryStorage();
        const { h, clock, host, session, profileId } = await rig(storage);
        try {
            h.fake.script("/settings/contract/capabilities", {
                status: 200,
                body: { api_version: 1, revision: "r1", manifest_revision: 19, state: "available", allowed: true, scopes: ["profile", "profile_device"], supports_batched_effective: true, supports_atomic_shortcuts: true, client_families: ["tv"] },
            });
            h.fake.script("/settings/contract", {
                status: 200,
                body: { api_version: 1, revision: 19, definitions: [{ key: "playback.subtitle_appearance", introduced_in: 1, allowed_scopes: ["profile", "profile_device"] }] },
            });
            h.fake.script("/settings/values?scope=profile_device&keys=playback.subtitle_appearance", {
                status: 200,
                body: { revision: 19, items: [{ key: "playback.subtitle_appearance", scope: "profile_device", profile_id: "p-owner", device_id: h.core.session.http.deviceId, is_set: false }] },
            });
            h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ ...DEFAULT_APPEARANCE, fontSize: "xlarge" }) } });
            h.fake.script("/settings/values/playback.subtitle_appearance?scope=profile", { status: 200, body: { revision: 20, key: "playback.subtitle_appearance", scope: "profile", value: { ...DEFAULT_APPEARANCE, fontSize: "small" } } });
            const syncHold = h.fake.hold("/settings/values/effective?keys=player.subtitle_sync_ms");
            h.fake.script("/settings/values/effective?keys=player.subtitle_sync_ms", { status: 200, body: { items: [{ key: "player.subtitle_sync_ms", value: 1500 }] } });
            h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:11.000 --> 00:14.000\nStyled" });

            const plan = makePlan(h.fake.origin);
            host.plan = plan;
            host.sourceSeconds = 13.5;
            session.onPlanAdopted(plan, profileId);
            await flush(clock);
            assert.equal(session.trackViewSlice(plan).subtitleTools?.display?.styling, true);
            assert.equal(session.trackViewSlice(plan).subtitleTools?.display?.delay, false);

            // Edit fontSize while the legacy delay read is still in flight.
            session.applyTool({ kind: "size", size: "small" });
            await flush(clock);
            assert.equal(session.captionsView(plan, false)?.appearance.fontSize, "small");

            // Now let the legacy delay read resolve: delayMs applies without overwriting fontSize.
            syncHold.release();
            await flush(clock);

            const captions = session.captionsView(plan, false);
            assert.equal(captions?.appearance.fontSize, "small", "edited appearance is preserved");
            assert.equal(captions?.instant, 12, "pending legacy delay read still applies after appearance edit");
            assert.equal(h.fake.requests.filter(req => req.path.startsWith("/settings/subtitle-appearance/effective")).length, 1, "supported appearance is not re-read");
            assert.equal(h.fake.requests.filter(req => req.path === "/settings/values/effective?keys=player.subtitle_sync_ms").length, 1, "missing sync is fetched once");
        } finally { session.destroy(); }
    }

    // 2. Delay-only modern contract: sync read once via SubtitleDisplay, appearance read lazily; an in-flight delay save must not drop the arriving appearance.
    {
        const storage = new MemoryStorage();
        const { h, clock, host, session, profileId } = await rig(storage);
        try {
            h.fake.script("/settings/contract/capabilities", {
                status: 200,
                body: { api_version: 1, revision: "r1", manifest_revision: 19, state: "available", allowed: true, scopes: ["profile", "profile_device"], supports_batched_effective: true, supports_atomic_shortcuts: true, client_families: ["tv"] },
            });
            h.fake.script("/settings/contract", {
                status: 200,
                body: { api_version: 1, revision: 19, definitions: [{ key: "player.subtitle_sync_ms", introduced_in: 1, allowed_scopes: ["profile", "profile_device"] }] },
            });
            h.fake.script("/settings/values?scope=profile_device&keys=player.subtitle_sync_ms", {
                status: 200,
                body: { revision: 19, items: [{ key: "player.subtitle_sync_ms", scope: "profile_device", profile_id: "p-owner", device_id: h.core.session.http.deviceId, is_set: false }] },
            });
            h.fake.script("/settings/values/effective?keys=player.subtitle_sync_ms", { status: 200, body: { items: [{ key: "player.subtitle_sync_ms", value: 1000 }] } });
            const appearanceHold = h.fake.hold("/settings/subtitle-appearance/effective");
            h.fake.script("/settings/subtitle-appearance/effective", { status: 200, body: { profile_id: "p-owner", effective_value: JSON.stringify({ ...DEFAULT_APPEARANCE, fontSize: "xxlarge" }) } });
            const delayPutHold = h.fake.hold("/settings/values/player.subtitle_sync_ms?scope=profile");
            h.fake.script("/settings/values/player.subtitle_sync_ms?scope=profile", { status: 200, body: { revision: 20, key: "player.subtitle_sync_ms", scope: "profile", value: 250 } });
            h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:11.000 --> 00:14.000\nTimed" });

            const plan = makePlan(h.fake.origin);
            host.plan = plan;
            host.sourceSeconds = 13.5;
            session.onPlanAdopted(plan, profileId);
            await flush(clock);
            assert.equal(session.trackViewSlice(plan).subtitleTools?.display?.styling, false);
            assert.equal(session.trackViewSlice(plan).subtitleTools?.display?.delay, true);

            // Start a delay save while legacy appearance is in flight, then let appearance arrive before the save completes.
            session.applyTool({ kind: "delay", milliseconds: 250 });
            await flush(clock);
            appearanceHold.release();
            await flush(clock);
            delayPutHold.release();
            await flush(clock);

            const captions = session.captionsView(plan, false);
            assert.equal(captions?.appearance.fontSize, "xxlarge", "arriving appearance survives an in-flight delay save");
            assert.equal(captions?.instant, 13.25, "saved delay remains applied after appearance arrives");
            assert.equal(h.fake.requests.filter(req => req.path === "/settings/values/effective?keys=player.subtitle_sync_ms").length, 1, "supported delay is not re-read");
            assert.equal(h.fake.requests.filter(req => req.path.startsWith("/settings/subtitle-appearance/effective")).length, 1, "missing appearance is fetched once");
        } finally { session.destroy(); }
    }
});

// --- 3. Direct Play embedded switch state machine ---

test("Direct Play embedded switch stays non-blocking, waits for pending seek before keepPlan, and silences native text", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        h.fake.script("/captions/fr.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nBonjour" });
        const plan = makePlan(h.fake.origin);
        const nextPlan = makePlan(h.fake.origin, {
            planId: "plan-2",
            streamUrl: `${h.fake.origin}/api/v2/stream/42?st=tok2`,
            selectedTracks: { audio: { id: "file:42:audio:0", index: 0 }, subtitle: { id: "file:42:subtitle:1" } },
            subtitle: { ...plan.subtitle, trackId: "file:42:subtitle:1", artifact: { url: `${h.fake.origin}/api/v2/captions/fr.vtt?token=synthetic`, format: "vtt", origin: 0 } },
        });
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        let releaseSeek!: () => void;
        host.pendingSeek = new Promise<void>(resolve => { releaseSeek = resolve; });
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: nextPlan, serverFeatures: [] }));

        session.selectSubtitle("file:42:subtitle:1");
        assert.equal(session.subtitleSwitchOut, true);
        assert.equal(session.holdsTransportBusy, false);
        assert.deepEqual(host.switches, ["non_blocking"]);
        assert.equal(session.captionsView(plan, false), undefined, "replaced overlay captions are withheld while waiting for switch");

        await flush(clock);
        assert.equal(host.keptPlans.length, 0, "adoption waits for in-flight local seek before silencing native text");

        host.pendingSeek = undefined;
        releaseSeek();
        await flush(clock);

        assert.equal(session.subtitleSwitchOut, false);
        assert.equal(host.keptPlans.length, 1);
        assert.equal(host.adoptedPlans.length, 0);
        assert.equal(host.silentHistory[host.silentHistory.length - 1], true);
        assert.equal(session.captionsView(nextPlan, false)?.text, "Bonjour");
    } finally { session.destroy(); }
});

test("unanswered Direct Play switch falls back locally, retries on warm restore, wakes once on route failure, and enforces 30s deadline", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        // Refuse native select initially so drawSwitchLocally defers to warm restore.
        host.refuseSelectText = true;
        session.selectSubtitle("file:42:subtitle:1");
        await flush(clock, 1000);
        await flush(clock, 2000);
        assert.equal(host.replans[0]?.sends, 3);
        assert.equal(host.selectedTextIndex, undefined);

        host.refuseSelectText = false;
        session.onWarmRestored();
        assert.equal(host.selectedTextIndex, 12, "warm restore retries deferred local fallback draw");
        assert.equal(session.shownSubtitleId(plan), "file:42:subtitle:1");

        // Route failure while a local seek holds transport busy is left to the seek; once idle it wakes replay once and starts the 30s deadline.
        assert.equal(session.onRouteFailed("avplay_playback_error", true), "not_owned");
        assert.equal(host.replans[0]?.sends, 3, "busy seek route failure does not absorb or wake direct switch");
        assert.equal(session.onRouteFailed("avplay_playback_error", false), "absorbed_by_direct_switch");
        await flush(clock);
        assert.equal(host.replans[0]?.sends, 4, "route failure skips client backoff once");

        await flush(clock, 30000);
        assert.deepEqual(host.failures, [{ kind: "playback_failed" }]);
    } finally { session.destroy(); }
});

// --- 4. HLS rendition reporting, double-pick, and sidecar rollback (#792) ---

test("HLS rendition report coalesces latest pick and rolls back to sidecar on 409 refusal (#792)", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/de.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHallo" });
        h.fake.script("/captions/de.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHallo" });
        const plan = makeHlsPlan(h.fake.origin, "file:42:subtitle:2", "render");
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);
        assert.equal(session.captionsView(plan, false)?.text, "Hallo");

        let rejectReport!: (error: unknown) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>((_resolve, reject) => { rejectReport = reject; }));

        session.selectSubtitle("file:42:subtitle:0");
        assert.equal(session.isReporting, true);
        assert.equal(host.selectedTextIndex, 10);

        rejectReport(new ApiError({ kind: "problem", problem: { id: "conflict", status: 409, title: "Conflict", detail: "Conflict", instance: "", errors: [] }, retryAfterSeconds: undefined }));
        await flush(clock);

        assert.equal(session.isReporting, false);
        assert.equal(session.shownSubtitleId(plan), "file:42:subtitle:2", "rolled back to sidecar primary");
        assert.equal(session.captionsView(plan, false)?.text, "Hallo", "sidecar cues reloaded after rollback");
        assert.equal(host.silentHistory[host.silentHistory.length - 1], true, "native text silenced again under sidecar");
    } finally { session.destroy(); }
});

// --- 5. Dual / SECONDARY subtitles and primary failure clearing ---

test("secondary subtitle tracks primary origin changes and clears if primary fails", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        h.fake.script("/captions/fr.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nBonjour" });
        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        session.selectSecondarySubtitle("file:42:subtitle:1");
        await flush(clock);
        assert.equal(session.captionsView(plan, false)?.secondaryText, "Bonjour");

        // Primary switches to a failing artifact -> secondary must clear.
        h.fake.script("/captions/broken.vtt?token=synthetic", { status: 404 });
        host.refuseSelectText = true;
        const brokenPlan = makePlan(h.fake.origin, {
            subtitle: { ...plan.subtitle, artifact: { url: `${h.fake.origin}/api/v2/captions/broken.vtt?token=synthetic`, format: "vtt", origin: 0 } },
        });
        host.plan = brokenPlan;
        session.onPlanAdopted(brokenPlan, profileId);
        await flush(clock);

        assert.equal(session.trackViewSlice(brokenPlan).secondary, undefined);
        assert.equal(session.captionsView(brokenPlan, false)?.secondaryText, "");
    } finally { session.destroy(); }
});

// --- 6. First-frame captionFallback & nativeSubtitleUnavailable ---

test("alignOpenStream applies deferred captionFallback on first frame and replans once on native miss", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 404 });
        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        host.started = false;
        host.textTracks = undefined; // AVPlay cannot list tracks before first frame.
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        // First frame arrives: tracks become available and captionFallback selects native TEXT 10.
        host.started = true;
        host.textTracks = [{ index: 10, language: "eng" }];
        assert.equal(session.alignOpenStream(plan), "aligned");
        assert.equal(host.selectedTextIndex, 10);

        // Native-only Direct Play plan with missing text track triggers closeForReplan once, then fails on repeat.
        host.textTracks = [];
        const nativeOnly = makePlan(h.fake.origin, { subtitle: { ...plan.subtitle, artifact: undefined } });
        host.plan = nativeOnly;
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: nativeOnly, serverFeatures: [] }));
        assert.equal(session.alignOpenStream(nativeOnly), "replan_unavailable_native");
        assert.equal(host.closedForReplan, 1);
        assert.equal(session.nativeSubtitleUnavailable, true);

        assert.equal(session.alignOpenStream(nativeOnly), "failed");
        assert.deepEqual(host.failures, [{ kind: "playback_failed" }]);
    } finally { session.destroy(); }
});

// --- 7. Authority cancellation / destroy ---

test("destroy stops in-flight direct switch replays and emits no further host callbacks", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        session.selectSubtitle("file:42:subtitle:1");
        await flush(clock);
        const changesBefore = host.changes;
        const sendsBefore = host.replans[0]?.sends ?? 0;

        session.destroy();
        await flush(clock, 120000);
        assert.equal(host.changes, changesBefore);
        assert.equal(host.replans[0]?.sends, sendsBefore);
        assert.equal(host.failures.length, 0);
    } finally { session.destroy(); }
});

// --- 8. Review regression pins ---

test("active nativeOverride from 409 fallback survives starting a subsequent switch and its refusal", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        const en = track("file:42:subtitle:0", { combinedIndex: 0, language: "en", label: "English", streamIndex: 10, url: `${h.fake.origin}/api/v2/captions/en.vtt?token=synthetic` });
        const fr = track("file:42:subtitle:1", { combinedIndex: 1, language: "fr", label: "French", streamIndex: 12, url: `${h.fake.origin}/api/v2/captions/fr.vtt?token=synthetic` });
        const es = track("file:42:subtitle:2", { combinedIndex: 2, language: "es", label: "Spanish", streamIndex: 14, nativeSelectable: false, url: `${h.fake.origin}/api/v2/captions/es.vtt?token=synthetic` });
        const plan = makePlan(h.fake.origin, {
            subtitle: {
                mode: "render",
                trackId: en.trackId,
                artifact: { url: `${h.fake.origin}/api/v2/captions/en.vtt?token=synthetic`, format: "vtt", origin: 0 },
                embedded: undefined,
                hlsRendition: undefined,
                inventory: [en, fr, es],
            },
        });
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        // Pick French: 409 refusal falls back to AVPlay drawing French natively.
        const conflict = () => Promise.reject(new ApiError({ kind: "problem", problem: { id: "conflict", status: 409, title: "Conflict", detail: "Conflict", instance: "", errors: [] }, retryAfterSeconds: undefined }));
        host.nextReplans.push(conflict);
        session.selectSubtitle(fr.trackId);
        await flush(clock);
        assert.equal(host.selectedTextIndex, 12);
        assert.equal(session.shownSubtitleId(plan), fr.trackId);

        // Pick Off (blocking replan): French stays shown during the switch, and stays active if Off is refused.
        let rejectOff!: (error: unknown) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>((_resolve, reject) => { rejectOff = reject; }));
        session.selectSubtitle(undefined);
        assert.equal(session.shownSubtitleId(plan), fr.trackId, "active nativeOverride persists during blocking switch");
        assert.equal(session.chosenTracks(plan).subtitle?.id, fr.trackId);

        rejectOff(new ApiError({ kind: "problem", problem: { id: "conflict", status: 409, title: "Conflict", detail: "Conflict", instance: "", errors: [] }, retryAfterSeconds: undefined }));
        await flush(clock);
        assert.equal(session.shownSubtitleId(plan), fr.trackId, "active nativeOverride survives blocking refusal");
        assert.equal(session.chosenTracks(plan).subtitle?.id, fr.trackId);

        // Pick Spanish (direct embedded switch without nativeSelectable): French stays shown during and after refusal.
        let rejectEs!: (error: unknown) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>((_resolve, reject) => { rejectEs = reject; }));
        session.selectSubtitle(es.trackId);
        assert.equal(session.shownSubtitleId(plan), fr.trackId, "active nativeOverride persists during direct switch");
        rejectEs(new ApiError({ kind: "problem", problem: { id: "conflict", status: 409, title: "Conflict", detail: "Conflict", instance: "", errors: [] }, retryAfterSeconds: undefined }));
        await flush(clock);
        assert.equal(session.shownSubtitleId(plan), fr.trackId, "active nativeOverride survives direct switch refusal");
        assert.equal(session.chosenTracks(plan).subtitle?.id, fr.trackId);
    } finally { session.destroy(); }
});

test("queuedAfterReopen survives alignOpenStream unavailable_native replan", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        const plan1 = makeHlsPlan(h.fake.origin, "file:42:subtitle:0", "render");
        const de = track("file:42:subtitle:2", { combinedIndex: 2, source: "external", language: "de", label: "German", url: `${h.fake.origin}/api/v2/captions/de.vtt?token=synthetic` });
        const base = makePlan(h.fake.origin);
        const plan2 = makePlan(h.fake.origin, {
            planId: "plan-2",
            subtitle: { ...base.subtitle, artifact: undefined, inventory: [...base.subtitle.inventory, de] },
        });
        const plan3 = makePlan(h.fake.origin, {
            planId: "plan-3",
            subtitle: { ...base.subtitle, artifact: { url: `${h.fake.origin}/api/v2/captions/en.vtt?token=synthetic`, format: "vtt", origin: 0 }, inventory: [...base.subtitle.inventory, de] },
        });
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        host.plan = plan1;
        session.onPlanAdopted(plan1, profileId);
        await flush(clock);

        // Start an HLS report for French, then supersede it with German while server reopens into Direct Play plan2.
        let resolveReport!: (decision: PlaybackDecision) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>(resolve => { resolveReport = resolve; }));
        session.selectSubtitle("file:42:subtitle:1");
        session.selectSubtitle("file:42:subtitle:2");

        resolveReport({ outcome: "playable", sessionId: host.sessionId, plan: plan2, serverFeatures: [] });
        await flush(clock);
        assert.equal(host.adoptedPlans.length, 1);

        // Adopt plan2 with missing native tracks -> alignOpenStream triggers unavailable_native blocking replan -> adopts plan3.
        host.plan = plan2;
        session.onPlanAdopted(plan2, profileId);
        host.textTracks = [];
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: plan3, serverFeatures: [] }));
        assert.equal(session.alignOpenStream(plan2), "replan_unavailable_native");
        await flush(clock);
        assert.equal(host.adoptedPlans.length, 2);

        // Adopt plan3, mark stream started (first frame), and consumePreparedChoices -> queued German pick was preserved!
        host.plan = plan3;
        host.started = true;
        session.onPlanAdopted(plan3, profileId);
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: plan3, serverFeatures: [] }));
        session.consumePreparedChoices(plan3);
        assert.equal(host.replans[host.replans.length - 1]?.selected.subtitle?.id, "file:42:subtitle:2", "queuedAfterReopen survived unavailable_native replan");
    } finally { session.destroy(); }
});

test("transient lost-answer recovery preserves download pendingStored across connection recovery", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        h.fake.script("/subtitles/providers/status", { status: 200, body: { revision: "r1", allowed: true, state: "available", enabled: true } });
        h.fake.script("/subtitles/search", {
            status: 200,
            body: { results: [{ id: "sub-9", provider: "opensubtitles", language: "es", release_name: "Spanish", format: "srt", score: 9, downloads: 10, hearing_impaired: false }], warnings: [] },
        });
        h.fake.script("/subtitles/download", { status: 200, body: { subtitle: { id: "dl-9", media_file_id: "42" } } });

        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        // Open search and download Spanish; fail all 3 replan resends with transient network error.
        session.applyTool({ kind: "search-open" });
        await flush(clock);
        session.applyTool({ kind: "search-language", code: "es" });
        await flush(clock);

        session.applyTool({ kind: "search-download", key: "opensubtitles:sub-9" });
        await flush(clock, 1000);
        await flush(clock, 2000);
        assert.equal(host.recoveries, 1, "transient stored-track refresh failure hands off to connection recovery");

        // Connection recovery starts (must keep download pendingStored), then recovers with a new plan containing stored-dl-9.
        session.onConnectionRecoveryStarted();
        const dlTrack = track("file:42:subtitle:9", { combinedIndex: 2, source: "external", language: "es", label: "Spanish", syncKey: "stored-dl-9", url: `${h.fake.origin}/api/v2/captions/es.vtt?token=synthetic` });
        const recoveredPlan = makePlan(h.fake.origin, {
            planId: "plan-recovered",
            subtitle: { ...plan.subtitle, inventory: [...plan.subtitle.inventory, dlTrack] },
        });
        host.plan = recoveredPlan;
        session.onPlanAdopted(recoveredPlan, profileId);
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: recoveredPlan, serverFeatures: [] }));
        session.consumePreparedChoices(recoveredPlan);

        assert.equal(host.replans[host.replans.length - 1]?.selected.subtitle?.id, dlTrack.trackId, "download pendingStored survived transient recovery and activated on first frame");
    } finally { session.destroy(); }
});

test("onStreamCompleted defers during blocking and HLS reporting phases only", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        const hlsPlan = makeHlsPlan(h.fake.origin, "file:42:subtitle:0", "render");
        host.plan = hlsPlan;
        session.onPlanAdopted(hlsPlan, profileId);
        await flush(clock);
        assert.equal(session.onStreamCompleted(), "not_owned");

        let resolveReport!: (decision: PlaybackDecision) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>(resolve => { resolveReport = resolve; }));
        session.selectSubtitle("file:42:subtitle:1");
        assert.equal(session.onStreamCompleted(), "deferred");
        resolveReport({ outcome: "playable", sessionId: host.sessionId, plan: hlsPlan, serverFeatures: [] });
        await flush(clock);
        assert.equal(host.settled[host.settled.length - 1]?.postSettle.kind, "complete_stream");

        const directPlan = makePlan(h.fake.origin);
        host.plan = directPlan;
        session.onPlanAdopted(directPlan, profileId);
        await flush(clock);
        host.nextReplans.push(() => new Promise<PlaybackDecision>(() => undefined));
        session.selectSubtitle("file:42:subtitle:1");
        assert.equal(session.onStreamCompleted(), "not_owned", "direct embedded switch does not defer stream completion");
    } finally { session.destroy(); }
});

test("deferredPick stored during an in-flight seek survives plan adoption and applies on first frame", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        const en = track("file:42:subtitle:0", { combinedIndex: 0, language: "en", label: "English", streamIndex: 10, url: `${h.fake.origin}/api/v2/captions/en.vtt?token=synthetic` });
        const fr = track("file:42:subtitle:1", { combinedIndex: 1, language: "fr", label: "French", streamIndex: 12, url: `${h.fake.origin}/api/v2/captions/fr.vtt?token=synthetic` });
        const de = track("file:42:subtitle:2", { combinedIndex: 2, source: "external", language: "de", label: "German", url: `${h.fake.origin}/api/v2/captions/de.vtt?token=synthetic` });
        const plan = makePlan(h.fake.origin, {
            subtitle: { ...makePlan(h.fake.origin).subtitle, inventory: [en, fr, de] },
        });
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        // Start a Direct Play embedded switch to French, then queue German while a local seek holds transport busy.
        let rejectFr!: (error: unknown) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>((_resolve, reject) => { rejectFr = reject; }));
        session.selectSubtitle(fr.trackId);
        session.selectSubtitle(de.trackId);
        host.busy = true;
        host.pendingSeek = new Promise<void>(() => undefined);

        // 409 falls back to native French and stores German as idle.deferredPick because busy stays true for the seek.
        rejectFr(new ApiError({ kind: "problem", problem: { id: "conflict", status: 409, title: "Conflict", detail: "Conflict", instance: "", errors: [] }, retryAfterSeconds: undefined }));
        await flush(clock);
        assert.equal(host.busy, true);
        assert.equal(host.replans.length, 1, "German pick stays deferred while seek holds busy");

        // Seek fails and transport adopts a recovered plan -> deferredPick must survive onPlanAdopted and run on consumePreparedChoices.
        const recovered = makePlan(h.fake.origin, {
            planId: "plan-recovered",
            subtitle: { ...plan.subtitle },
        });
        host.busy = false;
        host.pendingSeek = undefined;
        host.plan = recovered;
        session.onPlanAdopted(recovered, profileId);
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: recovered, serverFeatures: [] }));
        session.consumePreparedChoices(recovered);

        assert.equal(host.replans[host.replans.length - 1]?.selected.subtitle?.id, de.trackId, "deferredPick survived onPlanAdopted");
    } finally { session.destroy(); }
});

test("recover_route settlement preserves pendingStored download across route recovery", async () => {
    const { h, clock, host, session, profileId } = await rig();
    try {
        h.fake.script("/captions/en.vtt?token=synthetic", { status: 200, text: "WEBVTT\n\n00:00.000 --> 00:30.000\nHello" });
        h.fake.script("/subtitles/providers/status", { status: 200, body: { revision: "r1", allowed: true, state: "available", enabled: true } });
        h.fake.script("/subtitles/search", {
            status: 200,
            body: { results: [{ id: "sub-11", provider: "opensubtitles", language: "es", release_name: "Spanish", format: "srt", score: 9, downloads: 10, hearing_impaired: false }], warnings: [] },
        });
        h.fake.script("/subtitles/download", { status: 200, body: { subtitle: { id: "dl-11", media_file_id: "42" } } });

        const plan = makePlan(h.fake.origin);
        host.plan = plan;
        session.onPlanAdopted(plan, profileId);
        await flush(clock);

        session.applyTool({ kind: "search-open" });
        await flush(clock);
        session.applyTool({ kind: "search-language", code: "es" });
        await flush(clock);

        let resolveRefresh!: (decision: PlaybackDecision) => void;
        host.nextReplans.push(() => new Promise<PlaybackDecision>(resolve => { resolveRefresh = resolve; }));
        session.applyTool({ kind: "search-download", key: "opensubtitles:sub-11" });
        await flush(clock);

        // Route fails while stored_inventory_refresh replan is in flight -> absorbed as blocking routeFailure.
        assert.equal(session.onRouteFailed("avplay_playback_error", true), "absorbed_by_blocking_change");

        // Replan resolves on the same Direct Play transport, so applyKeptSubtitle settles with recover_route and keeps pendingStored.
        const dlTrack = track("file:42:subtitle:11", { combinedIndex: 2, source: "external", language: "es", label: "Spanish", syncKey: "stored-dl-11", url: `${h.fake.origin}/api/v2/captions/es.vtt?token=synthetic` });
        const keptPlan = makePlan(h.fake.origin, {
            planId: "plan-kept",
            subtitle: { ...plan.subtitle, inventory: [...plan.subtitle.inventory, dlTrack] },
        });
        resolveRefresh({ outcome: "playable", sessionId: host.sessionId, plan: keptPlan, serverFeatures: [] });
        await flush(clock);

        assert.deepEqual(host.settled[host.settled.length - 1]?.postSettle, { kind: "recover_route", classification: "avplay_playback_error" });

        // Route recovery adopts a fresh plan -> consumePreparedChoices activates the preserved download track.
        const recoveredPlan = makePlan(h.fake.origin, {
            planId: "plan-after-route",
            subtitle: { ...plan.subtitle, inventory: [...plan.subtitle.inventory, dlTrack] },
        });
        host.plan = recoveredPlan;
        session.onPlanAdopted(recoveredPlan, profileId);
        host.nextReplans.push(async () => ({ outcome: "playable", sessionId: host.sessionId, plan: recoveredPlan, serverFeatures: [] }));
        session.consumePreparedChoices(recoveredPlan);

        assert.equal(host.replans[host.replans.length - 1]?.selected.subtitle?.id, dlTrack.trackId, "download pendingStored survived recover_route settlement");
    } finally { session.destroy(); }
});
