# WroomWroomTracker

**A web-first multi-engine music tracker with direct touch controls.**

WroomWroomTracker is a fork of [ChooChooTracker](https://github.com/paiheulevrai/Choochootracker) focused on making the browser version feel like an actual music app rather than a handheld-console emulator.

**Web app:** https://myldy20.github.io/Wroomwroomtracker/

## What is different in this fork

- Browser-first UX inspired by BRKTRK.
- Compact live MASTER L/R output level indicators across all Web workspaces.
- Direct mouse/touch interaction with tracker cells.
- No virtual D-pad or A/B/Start/Select pad in the web UI.
- Explicit **SONG / CHAIN / PHRASE / SOUND / MIX** workspaces.
- Explicit **PLAY / STOP / EDIT / CLEAR / BACK** actions.
- Responsive desktop/phone shell.
- Browser-local project/sample storage and explicit downloads.
- GitHub Pages deployment.
- WroomWroom car-themed web branding.

The underlying tracker engine, project format and synthesis capabilities come from ChooChooTracker. Native/handheld versions are intentionally not the focus of this fork right now.

## Web controls

- **Tap/click** a cell to select it.
- In **SONG**, choose cells directly and use **EDIT CELL** (also available on phones) or the inspector to assign a Chain. Use **SHOW 16 MORE SONG ROWS** to extend the visible arrangement.
- **Double tap/click** a Song cell for its editor; the legacy screens still support drag-based value adjustment and their EDIT action.
- Use the workspace tabs to move directly between Song, Chain, Phrase, Sound and Mix.
- Keyboard and gamepad input still work on desktop, but they are optional.

## Engine highlights

- 8 tracker tracks.
- AY, Braids, Plaits, Plaits-Alt, sample playback, wavetable/single-cycle engines, aChChid, Bogie, MME, Sintered and native chip/FM engines.
- Per-track filters, sends, insert FX, mixer controls and modulation.
- Probability, modulo conditions, per-track speed, tables, grooves, chains and songs.
- MIDI in/out, sample editing, resampling and WAV/project export.

See [the upstream project](https://github.com/paiheulevrai/Choochootracker) and [the user manual](docs/USER_MANUAL.md) for the full tracker feature set and engine documentation.

## Build the web version

```bash
make -C tracker -j2 -f Makefile.web web-deploy
cd web/dist
python3 -m http.server 8080
```

## Status

This fork is alpha software. The current development priority is web usability, direct touch interaction, responsive layout and browser deployment. Other platform builds should remain compatible, but they are not being redesigned here.

## Credits

WroomWroomTracker is based on ChooChooTracker, which is based on ChipNomad. The project includes open-source work from Mutable Instruments, Signalsmith, Airwindows, Open303 and other upstream components; their existing license and attribution files remain authoritative.

Special thanks to the ChooChooTracker contributors for the engine, tracker workflow and ongoing upstream development.

## License

The project remains under the [MIT License](LICENSE), subject to the third-party notices already included in the repository.
