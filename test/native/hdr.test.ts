import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_CAPABILITIES, clientCapabilities, hdrDetails, playbackContext, probeHdr, probeHdrPanel, probeUhd, resolutionFor, type HdrReport, type UhdProbe } from "../../src/player/capabilities.ts";

const OFF: HdrReport = { panel: { hdr10: false, hlg: false, dolbyVision: false }, preference: { hdrEnabled: false } };

test("a missing or throwing HDR probe is SDR and never reports Dolby Vision", () => {
    assert.deepEqual(probeHdrPanel({}), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: {} }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: {} } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => false } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => "true" } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => { throw new Error("NotSupportedError"); } } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } }), { hdr10: true, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({
        webapis: {
            avinfo: { isHdrTvSupport: () => true },
            productinfo: { getModel: () => "QN55S95C", isUHDAModel: () => true, is8KPanelSupported: () => true, isOledPanelSupported: () => true },
            systeminfo: { isSupportedVideoCodec: (codec: string) => codec === "HEVC" },
            avplay: {
                getStreamingProperty: () => "HDR10+",
                getTotalTrackInfo: () => [{ type: "VIDEO", extra_info: "{\"fourCC\":\"hev1\"}" }],
            },
        },
        tizen: { systeminfo: { getCapability: () => true } },
    }), { hdr10: true, hlg: false, dolbyVision: false });
});

test("off or an unsupported panel matches the SDR capability profile exactly", () => {
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    for (const report of [
        OFF,
        { panel: supporting, preference: { hdrEnabled: false } },
        { panel: { hdr10: false, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } },
    ]) {
        assert.equal(hdrDetails(report), undefined);
        assert.equal(clientCapabilities(report), CLIENT_CAPABILITIES);
        assert.deepEqual(playbackContext("S95C", "0.1.0", report), playbackContext("S95C", "0.1.0"));
    }
});

test("HDR off omits HDR on the output and on every delivery", () => {
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    const report: HdrReport = { panel: supporting, preference: { hdrEnabled: false } };
    const capabilities = clientCapabilities(report);
    const context = playbackContext("S95C", "0.1.0", report);
    assert.equal(capabilities.hdr, false);
    assert.equal(capabilities.hdr_details, undefined);
    assert.equal(context.output.hdr_details, undefined);
    assert.deepEqual(Object.keys(context.deliveries).sort(), ["hls", "original_http"]);
    for (const kind of ["original_http", "hls"]) {
        const delivery = context.deliveries[kind];
        assert.ok(delivery, kind);
        assert.equal(delivery.enabled, true);
        assert.equal(delivery.hdr_details, undefined, kind);
        assert.equal(delivery.validated_claims.includes("client_managed_dynamic_range_v1"), false, kind);
    }
});

test("HDR on claims HDR10 only, and leaves HDR10+, HLG and Dolby Vision unclaimed", () => {
    const claimed = { hdr10: true, hdr10_plus: false, hlg: false, dolby_vision_profiles: [] as readonly number[] };
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    const report: HdrReport = { panel: supporting, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(report), claimed);
    const vision: HdrReport = { panel: { ...supporting, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(vision), claimed);
    const profileOnly: HdrReport = { panel: { hdr10: false, hlg: false, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.equal(hdrDetails(profileOnly), undefined);
    assert.equal(clientCapabilities(profileOnly).hdr_details, undefined);
    assert.equal(clientCapabilities(profileOnly).hdr, false);
    const context = playbackContext("S95C", "0.1.0", { panel: { hdr10: true, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } });
    assert.deepEqual(context.output.hdr_details, claimed);
    assert.deepEqual(context.deliveries.original_http?.hdr_details, claimed);
    assert.deepEqual(context.deliveries.hls?.hdr_details, claimed);
    const probed = playbackContext("S95C", "0.1.0", report);
    assert.deepEqual(probed.output.hdr_details, claimed);
    assert.deepEqual(probed.deliveries.original_http?.hdr_details, claimed);
    assert.deepEqual(probed.deliveries.hls?.hdr_details, claimed);
    const hlgOnly = { hdr10: false, hdr10_plus: false, hlg: true, dolby_vision_profiles: [] as readonly number[] };
    const named = playbackContext("S95C", "0.1.0", { panel: { hdr10: false, hlg: true, dolbyVision: false }, preference: { hdrEnabled: true } });
    assert.deepEqual(named.output.hdr_details, hlgOnly);
});

test("the HDR probe tells an observed answer from no usable answer", () => {
    assert.equal(probeHdr({}), "unavailable");
    assert.equal(probeHdr({ webapis: { avinfo: {} } }), "unavailable");
    assert.equal(probeHdr({ webapis: { avinfo: { isHdrTvSupport: () => "true" } } }), "unavailable");
    assert.equal(probeHdr({ webapis: { avinfo: { isHdrTvSupport: () => { throw new Error("NotSupportedError"); } } } }), "unavailable");
    assert.equal(probeHdr({ webapis: { avinfo: { isHdrTvSupport: () => false } } }), "sdr");
    assert.equal(probeHdr({ webapis: { avinfo: { isHdrTvSupport: () => true } } }), "hdr");
});

test("only a strict true from isUdPanelSupported reads as a 4K panel", () => {
    const panel = (isUdPanelSupported: () => unknown) => ({ webapis: { productinfo: { isUdPanelSupported } } });
    const answers: readonly (readonly [unknown, UhdProbe])[] = [
        [{}, "unavailable"],
        [{ webapis: {} }, "unavailable"],
        [{ webapis: { productinfo: {} } }, "unavailable"],
        [panel(() => false), "fhd"],
        [panel(() => "true"), "unavailable"],
        [panel(() => 1), "unavailable"],
        [panel(() => { throw new Error("NotSupportedError"); }), "unavailable"],
        [panel(() => true), "uhd"],
        [{ webapis: { productinfo: { ud: true, isUdPanelSupported() { return this.ud; } } } }, "uhd"],
    ];
    for (const [scope, probe] of answers) {
        assert.equal(probeUhd(scope), probe, JSON.stringify(scope));
        assert.equal(resolutionFor(probeUhd(scope)), probe === "uhd" ? "2160p" : "1080p");
    }
});

test("panel resolution and HDR compose independently on the capability body", () => {
    const hdr: HdrReport = { panel: { hdr10: true, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } };
    const claimed = { hdr10: true, hdr10_plus: false, hlg: false, dolby_vision_profiles: [] };
    for (const [resolution, width, height] of [["1080p", 1920, 1080], ["2160p", 3840, 2160]] as const) {
        for (const report of [undefined, OFF, hdr]) {
            const capabilities = clientCapabilities(report, resolution);
            assert.equal(capabilities.max_resolution, resolution);
            assert.deepEqual(capabilities.video_decode, [
                { codec: "h264", hardware: true, bit_depths: [8], max_width: width, max_height: height },
                { codec: "hevc", hardware: true, bit_depths: [8, 10], max_width: width, max_height: height },
            ]);
            assert.equal(capabilities.video_evidence, "declared");
            assert.equal(capabilities.hdr, report === hdr);
            assert.deepEqual(capabilities.hdr_details, report === hdr ? claimed : undefined);
        }
    }
    assert.equal(clientCapabilities(undefined, "1080p"), CLIENT_CAPABILITIES);
});
