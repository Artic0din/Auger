# Reporting Bugs and Gathering Info

This guide explains what to include in a bug report and where to find each piece of information on a Samsung TV, in Auger, and in Silo.

Open a [GitHub bug report](https://github.com/Artic0din/Auger-Tizen/issues/new?template=bug-report.yml) when you can.
If you cannot create a GitHub account, post the same details in the Silo Discord thread and a maintainer can log the issue for you.

Before reporting, check whether the same problem happens in the Silo web app.
Problems that also happen in the web app usually belong in [silo-server](https://github.com/Silo-Server/silo-server/issues/new/choose).

## Fastest way: send a Diagnostics report straight from Auger

Auger can gather your TV model, firmware/Tizen version, JS heap memory and uptime, Auger version, Silo server version, source and transcoded playback stats (including subtitle mode and delivery), rebuffer count, and recent redacted events automatically.
Server URLs, IP addresses, account names, media titles, and tokens are stripped before anything leaves the TV.

1. Open your **Profile** icon (top-right of Auger) → **Settings** → **Diagnostics**.
2. **Primary (no GitHub or Discord account needed):** Select **Send Diagnostics Report** and choose the category that best matches the issue (**Playback failed**, **Audio / Subtitles**, **Buffering / Quality**, or **App / Navigation**).
   Auger submits the redacted report through the Auger diagnostics relay, which deduplicates against open `diagnostics` issues (opening a new issue or appending a compact diff comment when new details appear) and displays the reference number on your TV (for example, `AUG-901`).
3. **Optional Automatic Error Reports:** Toggle **Automatic Error Reports** on (off by default) to send a redacted report automatically in the background after fatal playback errors or uncaught app errors (capped to once per unique issue per app version, with a 15-minute cooldown).
4. **Backup (copy for Discord or add your own details on GitHub):** Select **Share via QR Code** and scan with your phone camera (iPhone or Android).
   The helper page decodes the link `#fragment` locally in your browser (never sent to a server) and lets you tap **Copy for Discord** or **Open Pre-filled GitHub Bug Report**.

If Auger cannot open **Settings**, follow the manual steps below instead.

## 1. TV model and Tizen / firmware version

Samsung TVs do not always show the Tizen OS version number directly, so share both the **Model Code** and **Software Version**.

1. Press **Home** on your Samsung remote and open **Settings** (the TV's own settings, not Auger's).
2. Open **Support** → **About This TV**.
3. Note the **Model Code** (for example, `UE50CU7095` or `QE65S95C`) and **Software Version**.
4. Mention if you know the Tizen version (for example, `Tizen 8.0` or `Tizen 9.0`).

If you installed through **Apps2Samsung**, the connected TV model also appears at the top of the Apps2Samsung screen.

## 2. Auger version and install method

1. From Auger's top navigation bar, move to your **Profile** icon at the top right and open **Settings**.
2. Read the version at the bottom of the left sidebar (for example, `Auger 0.2.1`), or open **Server** → **About** → **App Version**.
3. Note how you installed Auger: **Apps2Samsung** (official catalog or custom source), a `.wgt` from **GitHub Releases**, or **built from source**.

## 3. Silo server version

1. Open your Silo server in a web browser and go to **Admin**.
2. Read the **Build** value at the bottom of the admin sidebar (for example, `412 · 1a2b3c4d`).
3. If someone else runs the server, ask them for the build version.

## 4. Playback problems: how to open the Stats tab

For Direct Play, Remux, Transcode, audio, subtitle, HDR, or stuttering issues, the **Stats** tab inside Auger's player gives the exact plan your server sent to the TV.

### Reaching the Stats tab on a Samsung remote

- **Fastest way (while video is playing and controls are hidden):**
  1. Press **Down** on the remote to open the player options panel (it opens on **Video**).
  2. Move one tab toward **Info** (**Left** in left-to-right layouts) to highlight **Stats**.
- **From the playback controls:**
  1. Press **Up** to show the timeline and transport bar.
  2. Press **Down** to move onto the transport buttons, then move **Right** to the **Options** button (beside Close) and press **Select**.
  3. Move along the top tab bar (`Info`, `Stats`, `Video`, `Audio`, `Subtitles`, `Chapters`) to **Stats**.

Press **Down** to focus and scroll the **Stats** pane.
Press **Back** to close the options panel.

### What to copy or photograph from Stats

A quick phone photo of the **Stats** tab is fine (crop or blur the **Source** host if it is private).
Otherwise, note these rows:

- **Playback:** play method and container (for example, `Direct play · MKV`, `Remuxed · MKV`, or `Transcoded · MKV`)
- **Video:** codec, resolution, frame rate, and bitrate (for example, `HEVC · 3840×2160 · 23.976 fps · 24.5 Mbps`)
- **Dynamic range:** `SDR`, `HDR10`, `HDR10+`, `HLG`, `Dolby Vision`, or a tone-mapping arrow such as `HDR10 → SDR`
- **Audio:** codec and channel layout shown on Stats, plus your physical audio setup (TV speakers, soundbar over eARC/optical, or AV receiver)
- **Subtitles:** off, or the selected track and format (SRT, ASS/SSA, PGS, VobSub, WebVTT, or AI-generated)
- **Diagnostics:** any decision reason or warning lines listed under `Diagnostics`
- **Stream / Engine:** `Playback status` (`Playing`, `Paused`, `Rebuffering`) and `Delivery` (`Original HTTP`, `Server Remux`, `Server Remux HLS`, or `Server Transcode HLS`)

Note that Samsung's AVPlay does not expose live buffer, dropped-frame, or audio passthrough counters, so those rows are not shown in Auger.

### Helpful extra playback checks

- Open **Settings → Playback** in Auger and note your **Preferred Quality**, **Max Bitrate**, and **Connection Speed** test result.
- Note whether the same item plays cleanly in the Silo web app or on another Silo client (Apple TV / Android TV).
- If you can access server logs, copy the relevant lines around the playback timestamp from Silo's **Admin → Logs**.

## 5. Performance or sluggishness problems

If the app feels slow, laggy, or stutters:

1. Say **where** it happens: launching the app, scrolling Home or a library grid, opening a title's Details page, navigating player menus, or during video playback.
2. Note roughly how large the library or row is, and whether it happens every time or only after long use.
3. Share your **TV model** (entry-level TVs have much less CPU and memory than flagship models) and whether the slowness happens in **normal motion** or also with **reduced motion**.

## Privacy before posting

Before attaching screenshots, photos, or server logs, redact:

- Server URLs, domains, and local IP addresses
- Account names, emails, tokens, and cookies
- Personal TV DUIDs or certificates
- Private media titles if you prefer not to share them

Mark each redaction clearly (for example, `<redacted-host>`).

## Quick template (for Discord or non-GitHub reports)

```text
What happened:
Steps to reproduce:
Expected behavior:
TV model & firmware/Tizen version:
Auger version & install method (Apps2Samsung / .wgt / source):
Silo server version:
Playback Stats (if playback issue):
- Playback / Delivery:
- Video & Dynamic range:
- Audio & audio setup (TV / soundbar / AVR):
- Subtitles:
- Diagnostics line(s):
```
