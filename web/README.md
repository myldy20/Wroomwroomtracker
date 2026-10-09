# WroomWroomTracker Web

The browser build is the primary product focus of this fork.

It keeps the ChooChooTracker engine and project format, but the web shell is designed around direct interaction instead of an on-screen gamepad:

- tap/click tracker cells directly;
- use **EDIT CELL** to edit a Song cell on desktop or phone, or double-tap a cell;
- reveal additional Song rows in increments of 16; keyboard navigation expands the view automatically;
- drag-based value adjustment remains in the legacy canvas screens until their semantic migration;
- switch directly between **SONG**, **CHAIN**, **PHRASE**, **SOUND**, and **MIX**;\n- edit Chain phrase IDs/transposition and Phrase notes/instrument/volume in native-backed Web rows; FULL CHAIN and FULL PHRASE preserve the original editor for complex FX and structural operations;
- in **MIX**, adjust each track's volume and panorama directly using touch/mouse sliders. **CENTER** resets each track; **FULL MIXER** opens the native level, sends, tilt, PAN, Auto Mix, reverb and delay controls; **DIRECT MIX** returns after any open Apply/Cancel prompt is resolved;
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

## SOUND and imported USER presets

SOUND offers a direct instrument-slot selector, native instrument volume (hex
00–FF), and stereo PAN. **FULL SOUND** opens the complete native editor for
oscillators, envelopes, modulation, import/export and other parameters.
**DIRECT SOUND** returns after the native editor is finished.

For compatible chip/FM instruments, **IMPORT FILES** adds .cni, .zip or
engine-specific preset programs to the selected engine's USER folder in browser
IndexedDB. Use **BROWSE IN ENGINE** to open the native compatible USER preset
browser, audition and load them. The Web bundle deliberately does not preload
the large factory library. Files are local to the browser and may be erased
when site data is cleared.
