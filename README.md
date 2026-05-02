<div align="center">

  <img src="https://github.com/tapframe/NuvioTV/raw/dev/assets/brand/app_logo_wordmark.png" alt="NuvioTV webOS" width="300" />
  <br />
  <br />

  <p>
    Lightweight <b>webOS wrapper</b> for Nuvio TV.
    <br />
    Hosted TV app launcher • Release-built IPK • Minimal packaging layer
  </p>

  <p>
    ⚠️ <b>Status: BETA</b> — experimental and may be unstable.
  </p>

</div>

## About

**NuvioWebOS** is the lightweight LG webOS wrapper for the hosted Nuvio TV web app.

It is not the main application source code. This repository contains the packaged launcher that opens the hosted TV experience plus the local webOS companion service used for media helpers such as subtitle track probing.

## Install

- For direct `.ipk` install: download the latest `.ipk` built from `NuvioMedia/NuvioWeb` releases, enable Developer Mode and Key Server by following `https://www.webosbrew.org/devmode`, then install it with `webOS Dev Manager`
- For Homebrew Channel repository install: open `Homebrew Channel`, go to `Settings`, choose `Add repository`, enter `https://raw.githubusercontent.com/NuvioMedia/NuvioWebOS/main/webosbrew/apps.json`, return to the apps list, and install Nuvio TV from there

## For Developers

- Main shared app source: `NuvioMedia/NuvioWeb`
- This wrapper repo stays intentionally small and only handles webOS packaging, launch behavior, and the local `space.nuvio.webos.service`
- If you want to inspect or modify the wrapper locally, update `appinfo.json`, `index.html`, `main.js`, and `services/space.nuvio.webos.service`
- Package with `ares-package . services/space.nuvio.webos.service`
