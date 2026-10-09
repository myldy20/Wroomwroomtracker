# ChooChooTracker architecture

## Overview

ChooChooTracker is a portable C++ tracker. `tracker/` provides the application
and its screens; `chipnomad_lib/` contains the project model, sequencer and
audio renderer. Windows, Web and PortMaster share the same engine.

```
UI / screens ── UI Project ── snapshots + commands ── audio engine
     ▲                                                │
     └──────── playback status + motion events ───────┘
```

## Browser semantic workspace migration

The Web build keeps native screens as a fallback until each musical workspace has semantic feature parity. Browser UI must read and write the same project and playback state as native code; it must not maintain a second sequencer model.

Current migration contract:

| Native behavior | Semantic Web equivalent | Regression coverage |
| --- | --- | --- |
| Song cursor / selected cell | `webSongSelect` + DOM `.selected` | live Pages exact-cell selection |
| Long Song editing up to native row limit | Incremental 16-row reveal, auto-expand on keyboard navigation, explicit touch EDIT | live Pages row expansion / edit dialog / ArrowDown |
| Song playback markers from `PlaybackStatus.tracks[].songRow` | compact `webPlaybackTrackPacked` + `.playing-row` / `.playing` classes | live Pages PLAY / selection independence / STOP |
| Song Chain reference editing | Chain picker backed by `webSongChainSummary`; direct number remains secondary | live Pages picker assignment |
| Chain picker content preview | `webSongChainPreview` reads actual Chain steps, Phrase note events and explicit Instrument IDs/names; no invented inherited instruments | live Pages picker preview / semantic contract |
| Song highlight / content state | packed Song cell state + semantic CSS classes | Web contract + existing engine state |
| Native global piano monitor | `webMonitorPianoNotes` delegates to native `monitorPianoNotes()`, preserving chord and trackEnabled mask; 12-key pitch-class UI across Song and legacy screens | browser smoke on Song and Chain + native-source contract |
| Per-track MUTE/SOLO controls | `webSongToggleTrackMute` / `webSongToggleTrackSolo` call `audioManager.toggleTrackMute/Solo`; Web readback from track activity packed status | browser smoke single track and cross-track transition |
| Pending LIVE queue indicators | `webSongLiveQueuePacked` from `PlaybackStatus.tracks[].queue`; independent `+` / `!` / `−` visual marks, playback still engine-owned | native bridge + browser no-queue smoke, launch action remains pending |
| Native group-track M/S selection | **Not yet migrated**: `selectedTrackBounds` and `toggleSelectedMute/Solo` support multiple native columns; browser currently exposes independent tracks only | tracked in parity inventory, must gain range selection and regression E2E |
| Native per-track activity strip | `webTrackActivityPacked`, `webTrackActivityNote` read canonical status; native canvas retains `webTrackActivityGlyph` and chip-specific visuals. Web reads real 256-sample post-level PCM as signed 16-bit hex via `webTrackAudioScopeHex`; visual-only per-track auto gain + silence gate at ~30 Hz Canvas/rAF, with no DSP or audio callback changes; desktop inspector + mobile expander | browser smoke verifies tracks, native glyph, PCM payload and high-res canvas; responsive checks |
| Direct Web MIX volume and PAN | `webMixTrackVolume` / `webMixSetTrackVolume` and `webMixTrackPan` / `webMixSetTrackPan` edit native `Project` (0–100% volume; 0–255 pan); browser never maintains audio gain or panning state | Chromium verifies native readback, isolation, invalid values and reset controls; WASM export contract |
| Screens without semantic parity | legacy 640×480 canvas fallback | navigation / native CI remain authoritative |

**Song is not yet native-feature-parity complete.** Native `screen_song.cpp` also implements rectangular selection, copy/cut/paste, multi-cell move, shallow/deep chain cloning, the clear-on-empty shift behavior, MUTE/SOLO status, and LIVE mode with queued/urgent/stop indicators. The DOM Song workspace currently lacks the following mappings:

| Native Song behavior still missing | Planned browser equivalent | Required coverage |
| --- | --- | --- |
 | Rectangular selection, copy/cut/paste, move | Direct range selection and contextual clipboard/structural tools | Range/bounds/clipboard E2E + native compatibility |
| Shallow/deep Chain clone, clear-on-empty column shift | Named editing actions with confirmation when destructive | Clone/shift semantics, persistence and undo expectations |
| LIVE mode per-track Chain queue and urgent transitions | Intentional live-performance UX backed by existing engine queue | Queue/play/stop ordering, status and track targeting |

The machine-readable inventory `web/native_parity_inventory.json` and CI guard `web/native_parity_contract_test.mjs` now track known native controls across Song, Chain, Phrase, Sound, Mix and secondary screens (including all 37 registered native screens and all 26 InstrumentType entries), preserving fallbacks until feature parity is implemented. This prevents silent deletion of listed native behavior, but is **not** a claim of exhaustive feature parity; expand coverage as each screen is audited. CI must be extended with real browser interaction tests before marking any entry semantic. The `web/wasm_bridge_contract_test.mjs` also verifies the checked-in compiled runtime actually exports Chain preview and search before Pages serves it.

Implement and test in dependency order: read-only state first, then track actions, then structural editing, then LIVE workflow. No second JS-owned sequencer state; no reliance on hidden modifier keys.

For every later screen migration, preserve the same order: inventory native behavior, add a minimal `WEB_BUILD` bridge to canonical state, implement direct browser interaction, add regression coverage, then reduce reliance on the legacy view.

## Web stereo output metering

The cross-workspace MASTER L/R meters read final stereo samples from the Web audio callback **after** the ordinary tracker mix and sample-preview contribution, just before PCM conversion. Under `WEB_BUILD` only, the callback accumulates independently clamped 12-bit peaks into lock-free atomics; `webOutputStereoPeaksPacked` returns and clears both peak windows via one call. The JS shell polls at 100 ms and applies display-only decay / dBFS conversion. This is telemetry, not a second audio engine or a transport signal, and does not alter native builds.

## Modules

- `tracker/src/`: application loop, SDL audio, tracker screens, editing,
  import/export and saving.
- `chipnomad_lib/project*`: in-memory format, serialization and utilities.
- `chipnomad_lib/playback*`: song/chain/phrase playback, ticks and FX.
- `chipnomad_lib/synth/`: Braids, Plaits, sample, SCWF and BYOWTBL voices,
  plus master effects.
- `chipnomad_lib/chips/`: AY emulation and chip abstraction.
- `chipnomad_lib/export/`: offline WAV rendering.
- `tracker/platforms/`: SDL/Web/PortMaster adapters and packaging.

## Project and instruments

`Project` is the editable song: song, chains, phrases, tables, instruments,
samples and global settings. The saved format remains the historical one.

`project_instruments.*` is the source of truth for instrument families. For
each family it declares:

- UI name and category, associated screen, init/free callbacks;
- modulation destinations, ranges and ADSR/Trigger capabilities;
- visible FX;
- destination-to-FX mappings for motion recording.

Family-specific data is still accessed through typed code. No union member of
`InstrumentChipData` is addressed through offset-based reflection.

## Real-time boundary

The UI owns `ChipNomadState::project`. The callback only reads
`audioProject` and `PlaybackState`.

1. The UI edits the project and publishes a snapshot through a fixed
   three-slot handoff.
2. At a tick boundary, the engine adopts the latest available snapshot,
   applies coalesced settings, then FIFO transport commands.
3. The callback renders frames between ticks without allocation or locking.

An edit made while playing therefore becomes audible on the next tick.
`Stop` is priority; play, preview and phrase queue commands are FIFO; loop,
mute/solo, sticks and project refresh keep their latest value.

The engine publishes `PlaybackStatus` for UI cursors. Screens do not read the
mutable `PlaybackState`. Motion recording travels in the other direction via
a fixed audio-to-UI queue: audio emits events; UI writes the phrase and marks
the project dirty.

Mix, reverb and delay buffers are reserved before start or during explicit
reconfiguration. An oversized callback is bounded and reported; it never
resizes memory inside the callback.

See [realtime-architecture.md](realtime-architecture.md) for detailed
constraints and diagnostics.
See [codebase-map.md](codebase-map.md) for the visual code map and suggested
review paths.
Coding agents should load the matching file under [agents/](agents/README.md)
instead of this overview when implementing a change.

## Render flow

`audio_manager` receives the platform callback, calls `chipnomadRender`,
converts the floating-point buffer to the output format, and performs no
editing. `chipnomadRender` drives ticks; `playback` resolves notes, FX and
modulation; voices and master effects produce the stereo mix.

WAV export uses the same engine offline, where it can initialize a local
playback state.

## Validation and builds

- Engine tests: `cd tracker && make -f Makefile.test -j4`.
- Windows: MSYS2 UCRT64, `make -j4 windows`.
- Web: Emscripten, then `Makefile.web web-deploy`; `web/dist/` is versioned.
- PortMaster: `make -j4 PortMaster`, then package and test on RG353V.

Unit tests cover modulation limits, the instrument catalogue, handoffs and
commands, and voices. Final validation remains auditory and hardware-based:
dense playback, live editing, motion recording, effects and saving.


### Native MIX fallback safety

The direct Web MIX screen owns volume/PAN edits in the canonical Project. Opening
FULL MIXER must re-enter native `webOpenScreen(4)` to trigger a native Mixer
`fullRedraw`; its ordinary `draw()` only refreshes meters and analyzers.
The DIRECT MIX button is unavailable while a different native screen,
including the Auto Mix Apply/Cancel confirmation, is active. The native dialog
must be resolved before switching back to semantic controls; previews must
not be silently accepted by hiding the canvas.

The native `webOpenScreen()` call queues `screenSetup()` and only commits
`currentScreen` in the following draw frame. Web tab navigation holds a short
bounded pending target so a stale `webCurrentScreen()` poll cannot replace the
new workspace while the transition is in flight. This also applies when
entering FULL MIXER.
