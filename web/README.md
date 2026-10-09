# WroomWroomTracker Web

The browser build is the primary product focus of this fork.

It keeps the ChooChooTracker engine and project format, but the web shell is designed around direct interaction instead of an on-screen gamepad:

- tap/click tracker cells directly;
- use **EDIT CELL** to edit a Song cell on desktop or phone, or double-tap a cell;
- reveal additional Song rows in increments of 16; keyboard navigation expands the view automatically;
- drag-based value adjustment remains in the legacy canvas screens until their semantic migration;
- switch directly between **SONG**, **CHAIN**, **PHRASE**, **SOUND**, and **MIX**;
- in **MIX**, adjust track pan directly using eight touch/mouse sliders. **CENTER** resets each track; **FULL MIXER** opens all original volume/send/insert-FX controls, and **DIRECT PAN** returns;
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
