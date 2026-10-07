# WroomWroomTracker Web

The browser build is the primary product focus of this fork.

It keeps the ChooChooTracker engine and project format, but the web shell is designed around direct interaction instead of an on-screen gamepad:

- tap/click tracker cells directly;
- drag horizontally to edit values;
- double-tap/click or use **EDIT** for the selected cell's action;
- switch directly between **SONG**, **CHAIN**, **PHRASE**, **SOUND**, and **MIX**;
- use explicit **PLAY**, **STOP**, **OPEN**, and **DOWNLOAD** actions.

Imported projects and samples live in browser-local IndexedDB storage. Nothing is uploaded automatically.

## GitHub Pages

Expected URL: `https://myldy20.github.io/Wroomwroomtracker/`

The shell uses relative asset paths so it can run under the repository sub-path used by GitHub Pages.

## Local build

```bash
make -C tracker -j2 -f Makefile.web web-deploy
cd web/dist
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

The original desktop keyboard/gamepad input remains available, but it is no longer required to operate the web UI.
