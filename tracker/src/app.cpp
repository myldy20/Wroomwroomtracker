#include <string.h>
#include "corelib_gfx.h"
#include "corelib_font.h"
#include "corelib_file.h"
#include "common.h"
#include "audio_manager.h"
#include "app.h"
#include "screens.h"
#include "screens/selection_popup.h"
#include "chipnomad_lib.h"
#include "project_utils.h"
#include "waveform_display.h"
#include "piano_display.h"
#include "monitor_display.h"
#include "corelib_input.h"
#include "corelib_keymap.h"
#include "screens/screen_quick_help.h"
#include "screens/screen_instrument.h"
#include "midi/midi_router.h"
#include "midi/midi_backend_desktop.h"
#ifdef ANDROID_BUILD
#include "midi/midi_backend_android.h"
#endif

#ifdef WEB_BUILD
#include <emscripten/emscripten.h>
#include "audio_monitor.h"

static void webStartupStage(const char* stage) {
  EM_ASM({
    if (typeof window !== 'undefined' && typeof window.wroomStartupStage === 'function') {
      window.wroomStartupStage(UTF8ToString($0));
    }
  }, stage);
  // Yield so the browser can actually paint the stage before the next
  // potentially expensive synchronous initialization step.
  emscripten_sleep(0);
}
#else
static void webStartupStage(const char*) {}
#endif

// Raw input callback for key mapping screen
void (*inputRawCallback)(InputCode input, int isDown) = NULL;

// Input handling vars:

/** Currently pressed buttons */
static int pressedButtons;
/** Frame counter for tap detection */
static int tapTimerCount;
/** Button that triggered tap timer */
static int tapButton;
/** Number of taps detected */
static int tapCount;
/** Frame counter for key repeats */
static int keyRepeatCount;
static int motionRecordHeld;
static int motionEraseHeld;
// One bit per mapped input, plus one for logical input. Overlapping delivery
// of the same press must be released completely before toggling again.
static int motionLiveHeld;
static int motionLiveLatched;
static int quickHelpSelectHeld;
static int quickHelpSelectAlone;
static int audioProjectDirty;
static MidiCCMapping midiCCApplied[PROJECT_MAX_MIDI_CC_MAPPINGS];
static uint8_t midiCCAppliedValue[PROJECT_MAX_MIDI_CC_MAPPINGS];
static uint8_t midiCCAppliedValid[PROJECT_MAX_MIDI_CC_MAPPINGS];
static uint32_t midiCCAppliedSerial[PROJECT_MAX_MIDI_CC_MAPPINGS];

// Port indices aren't saved (see common.h's AppSettings comment): this
// resolves the saved device name back to whatever live port currently has
// that name, or leaves it unresolved (index -1, name kept as-is so this
// keeps retrying on future launches) if none matches - never silently picks
// a different port just because one happens to be available.
static int findMidiPortByName(int isInput, const char* name) {
  if (!name || !name[0]) return -1;
  int count = isInput ? midiRouterInputPortCount() : midiRouterOutputPortCount();
  char portName[MIDI_DEVICE_NAME_LENGTH + 1];
  for (int i = 0; i < count; i++) {
    int ok = isInput ? midiRouterInputPortName(i, portName, sizeof(portName)) : midiRouterOutputPortName(i, portName, sizeof(portName));
    if (ok == 0 && strcmp(portName, name) == 0) return i;
  }
  return -1;
}

#ifdef ANDROID_BUILD
static void refreshAndroidMidiConnections(void) {
  // Android closes a port when its device disappears. Reconcile the saved
  // index with the live name list, then retry the saved name when it returns.
  int inputCount = midiRouterInputPortCount();
  if (appSettings.midiInputDevice >= 0) {
    char name[MIDI_DEVICE_NAME_LENGTH + 1];
    if (appSettings.midiInputDevice >= inputCount ||
        midiRouterInputPortName(appSettings.midiInputDevice, name, sizeof(name)) != 0 ||
        strcmp(name, appSettings.midiInputDeviceName) != 0) {
      midiRouterResetHeldNotes(chipnomadState->midiRouter);
      midiRouterCloseInput();
      appSettings.midiInputDevice = -1;
    }
  }
  if (appSettings.midiInputDevice < 0 && appSettings.midiInputDeviceName[0]) {
    int index = findMidiPortByName(1, appSettings.midiInputDeviceName);
    if (index >= 0 && midiRouterOpenInput(index) == 0) appSettings.midiInputDevice = index;
  }

  int outputCount = midiRouterOutputPortCount();
  if (appSettings.midiOutputDevice >= 0) {
    char name[MIDI_DEVICE_NAME_LENGTH + 1];
    if (appSettings.midiOutputDevice >= outputCount ||
        midiRouterOutputPortName(appSettings.midiOutputDevice, name, sizeof(name)) != 0 ||
        strcmp(name, appSettings.midiOutputDeviceName) != 0) {
      chipnomadMidiPanic(chipnomadState);
      midiRouterCloseOutput();
      appSettings.midiOutputDevice = -1;
    }
  }
  if (appSettings.midiOutputDevice < 0 && appSettings.midiOutputDeviceName[0]) {
    int index = findMidiPortByName(0, appSettings.midiOutputDeviceName);
    if (index >= 0 && midiRouterOpenOutput(index) == 0) appSettings.midiOutputDevice = index;
  }
}
#endif

static int applyMotionRecordEvent(const MotionRecordEvent& event) {
  if (event.phrase >= PROJECT_MAX_PHRASES || event.row >= 16 || event.fx >= fxTotalCount) return 0;
  PhraseRow* row = &chipnomadState->project.phrases[event.phrase].rows[event.row];
  int column = -1;
  for (int i = 2; i >= 0; --i) if (row->fx[i][0] == event.fx) { column = i; break; }
  if (event.erase) {
    if (column < 0) return 0;
    row->fx[column][0] = EMPTY_VALUE_8;
    row->fx[column][1] = 0;
    return 1;
  }
  if (column < 0)
    for (int i = 2; i >= 0; --i) if (row->fx[i][0] == EMPTY_VALUE_8) { column = i; break; }
  if (column < 0) {
    chipnomadSetMotionRecordOverflow();
    return 0;
  }
  if (row->fx[column][0] == event.fx && row->fx[column][1] == event.value) return 0;
  row->fx[column][0] = event.fx;
  row->fx[column][1] = event.value;
  return 1;
}

static int isMotionRecordTrigger(InputCode input) {
  for (int i = 0; i < 3; i++)
    if (appSettings.keyMapping.keyMotionRecord[i].deviceType == input.deviceType && appSettings.keyMapping.keyMotionRecord[i].code == input.code) return 1;
  return 0;
}

static int motionLiveInputMask(InputCode input) {
  if (input.deviceType == InputDeviceType::logical)
    return input.code == keyMotionLive ? 1 << 3 : 0;
  int mask = 0;
  for (int i = 0; i < 3; i++)
    if (appSettings.keyMapping.keyMotionLive[i].deviceType == input.deviceType && appSettings.keyMapping.keyMotionLive[i].code == input.code) mask |= 1 << i;
  return mask;
}

static int motionLiveActive(void) {
  if (appSettings.stickLiveMode == StickLiveMode::free) return 1;
  return appSettings.stickLiveMode == StickLiveMode::toggle ? motionLiveLatched : motionLiveHeld != 0;
}

static int isMotionEraseTrigger(InputCode input) {
  for (int i = 0; i < 3; i++)
    if (appSettings.keyMapping.keyMotionErase[i].deviceType == input.deviceType && appSettings.keyMapping.keyMotionErase[i].code == input.code) return 1;
  return 0;
}

static void updateMotionRecordMode(void) {
  chipnomadSetMotionRecordMode(motionRecordHeld, motionEraseHeld);
  chipnomadSetLiveStickEnabled(motionLiveActive() || motionRecordHeld || motionEraseHeld);
}

void appSetStickLiveMode(StickLiveMode mode) {
  if (mode != StickLiveMode::toggle && mode != StickLiveMode::free) mode = StickLiveMode::hold;
  if (appSettings.stickLiveMode == mode) return;
  appSettings.stickLiveMode = mode;
  motionLiveLatched = 0;
  updateMotionRecordMode();
}

/**
* @brief Convert InputCode to Key enum value
*
* @param input Input code
* @return Key value or 0 if not recognized
*/
static int inputCodeToKey(InputCode input) {
  // Logical buttons are not remappable
  if (input.deviceType == InputDeviceType::logical) {
    return input.code;
  }

  // Check key mapping for keyboard and gamepad inputs
  for (int i = 0; i < 3; i++) {
    if (appSettings.keyMapping.keyUp[i].deviceType == input.deviceType && appSettings.keyMapping.keyUp[i].code == input.code) return keyUp;
    if (appSettings.keyMapping.keyDown[i].deviceType == input.deviceType && appSettings.keyMapping.keyDown[i].code == input.code) return keyDown;
    if (appSettings.keyMapping.keyLeft[i].deviceType == input.deviceType && appSettings.keyMapping.keyLeft[i].code == input.code) return keyLeft;
    if (appSettings.keyMapping.keyRight[i].deviceType == input.deviceType && appSettings.keyMapping.keyRight[i].code == input.code) return keyRight;
    if (appSettings.keyMapping.keyEdit[i].deviceType == input.deviceType && appSettings.keyMapping.keyEdit[i].code == input.code) return keyEdit;
    if (appSettings.keyMapping.keyOpt[i].deviceType == input.deviceType && appSettings.keyMapping.keyOpt[i].code == input.code) return keyOpt;
    if (appSettings.keyMapping.keyPlay[i].deviceType == input.deviceType && appSettings.keyMapping.keyPlay[i].code == input.code) return keyPlay;
    if (appSettings.keyMapping.keyShift[i].deviceType == input.deviceType && appSettings.keyMapping.keyShift[i].code == input.code) return keyShift;
  }

  // Return keyUnmapped for any input that doesn't match a mapping
  return keyUnmapped;
}

static void applyLoopRange(void) {
  LoopRange range = screenGetLoopRange(currentScreen);
  if (range.enabled) {
    chipnomadQueueLoopRange(chipnomadState, range);
  } else {
    chipnomadQueueClearLoopRange(chipnomadState);
  }
}

/**
* @brief Handle play/stop key commands
*
* @param keys Pressed keys
* @param tapCount number of taps
* @return int 0 - input not handled, 1 - input handled
*/
static int inputPlayback(int keys, int tapCount) {
  if (!chipnomadState) return 0;

  const PlaybackStatus* playback = chipnomadGetPlaybackStatus(chipnomadState);
  int isPlaying = playback->isPlaying;
  ScreenPlaybackLevel playbackLevel = screenGetPlaybackLevel(currentScreen);

  // Play song/chain/phrase depending on the screen's playback level
  if (!isPlaying && keys == keyPlay) {
    if (playbackLevel == ScreenPlaybackLevel::none) {
      return 0; // This screen doesn't support playback
    }

    chipnomadQueuePlaybackStop(chipnomadState);
    waveformDisplayInvalidate();
    waveformDisplayRefresh();
    LoopRange range = screenGetLoopRange(currentScreen);

    if (playbackLevel == ScreenPlaybackLevel::song) {
      int startRow = range.enabled ? range.startSongRow : *pSongRow;
      chipnomadQueuePlaybackStartSong(chipnomadState, startRow, 0, 1);
      applyLoopRange();
    } else if (playbackLevel == ScreenPlaybackLevel::chain) {
      int startRow = range.enabled ? range.startChainRow : *pChainRow;
      chipnomadQueuePlaybackStartChain(chipnomadState, *pSongTrack, *pSongRow, startRow, 1);
      applyLoopRange();
    } else if (playbackLevel == ScreenPlaybackLevel::phrase) {
      chipnomadQueuePlaybackStartPhrase(chipnomadState, *pSongTrack, *pSongRow, *pChainRow, 1);
      applyLoopRange();
    }
    return 1;
  }
  // Play song from music screens (Shift+Play)
  else if (!isPlaying && keys == (keyPlay | keyShift)) {
    if (playbackLevel == ScreenPlaybackLevel::none) {
      return 0; // This screen doesn't support playback
    }

    chipnomadQueuePlaybackStop(chipnomadState);
    waveformDisplayInvalidate();
    waveformDisplayRefresh();
    LoopRange range = screenGetLoopRange(currentScreen);

    if (playbackLevel == ScreenPlaybackLevel::song) {
      int startRow = range.enabled ? range.startSongRow : *pSongRow;
      chipnomadQueuePlaybackStartSong(chipnomadState, startRow, 0, 1);
      applyLoopRange();
    } else if (playbackLevel == ScreenPlaybackLevel::chain || playbackLevel == ScreenPlaybackLevel::phrase) {
      int startChainRow = range.enabled ? range.startChainRow : *pChainRow;
      chipnomadQueuePlaybackStartSong(chipnomadState, *pSongRow, startChainRow, 1);
      applyLoopRange();
    }
    return 1;
  }
  // Stop playback
  else if (isPlaying && keys == keyPlay) {
    chipnomadQueuePlaybackStop(chipnomadState);
    return 1;
  }
  return 0;
}

/**
* @brief App input handler. Handles app-wide commands and then forwards the call to the current screen
*
* @param isKeyDown whether this is a key press (1) or key release (0)
* @param keys Pressed buttons
* @param tapCount number of taps
*/
static bool inputBranchNavigation(int keys) {
  if (keys != (keyShift | keyLeft) && keys != (keyShift | keyRight)) return false;
  int column = -1;
  if (currentScreen == &screenProject || currentScreen == &screenSettings ||
      currentScreen == &screenSynthSettings || currentScreen == &screenMixerSettings ||
      currentScreen == &screenGraphicsSettings || currentScreen == &screenTrackVisuals ||
      currentScreen == &screenMidi || currentScreen == &screenMidiChannelMap ||
      currentScreen == &screenMidiCC) column = 1;
  else if (currentScreen == &screenGroove) column = 3;
  else if (currentScreen == &screenModulation || currentScreen == &screenInsertFX) column = 4;
  else if (currentScreen == &screenAYWavetable) column = 5;
  if (column < 0) return false;
  const AppScreen* spine[] = {&screenMixer, &screenSong, &screenChain,
                             &screenPhrase, &screenInstrument, &screenTable};
  column += keys & keyRight ? 1 : -1;
  if (column > 5) column = 5;
  chipnomadQueuePlaybackStopPreview(chipnomadState, *pSongTrack);
  screenMessage(0, "");
  screenSetup(spine[column], column >= 4 ? cInstrument : -1);
  return true;
}

static void appInput(int isKeyDown, int keys, int tapCount) {
  // Stop phrase row and preview
  if (chipnomadGetPlaybackStatus(chipnomadState)->tracks[*pSongTrack].mode == PlaybackMode::phraseRow && keys == 0) {
    chipnomadQueuePlaybackStop(chipnomadState);
  }
  // Let screen handle input first, then try global playback if not handled
  if (!(isKeyDown && inputBranchNavigation(keys)) &&
      !currentScreen->onInput(isKeyDown, keys, tapCount)) {
    if (isKeyDown) {
      inputPlayback(keys, tapCount);
    }
  }
  // The UI owns Project. Coalesce edits into one snapshot for the next audio tick.
  // Popup choices (including native presets) commit on release. Publish those
  // edits too, even if no further button is pressed while the song plays.
  audioProjectDirty = 1;
}


#define AUTOSAVE_INTERVAL_FRAMES (60 * 60) // 1 minute at 60 FPS

static int autosaveCounter = 0;

///////////////////////////////////////////////////////////////////////////////
//

void appResetInputState(void) {
  pressedButtons = 0;
  tapTimerCount = 0;
  tapButton = 0;
  tapCount = 0;
  keyRepeatCount = 0;
  quickHelpSelectHeld = 0;
  quickHelpSelectAlone = 0;
}

/**
* @brief Initialize the application: setup audio system, load auto-saved project, show the first screen
*/
void appSetup(void) {
  // Registered before anything else touches MIDI: chipnomad_lib's engine
  // path (applyVoiceEvents/chipnomadMidiPanic) now goes through the router,
  // which does nothing until a backend is registered.
#ifdef ANDROID_BUILD
  midiRouterSetBackend(midiBackendAndroidGet());
#else
  midiRouterSetBackend(midiBackendDesktopGet());
#endif

  // LOGD("--- ChipNomad started ---");
  // Initialize default key mappings if not loaded from settings
  if (appSettings.keyMapping.keyUp[0].deviceType == InputDeviceType::none) {
    inputInitDefaultKeyMapping();
  }
  if (appSettings.keyMapping.keyMotionLive[0].deviceType == InputDeviceType::none) {
    appSettings.keyMapping.keyMotionLive[0] = (InputCode){InputDeviceType::keyboard, BTN_L1};
    if (appSettings.keyMapping.keyMotionRecord[0].deviceType == InputDeviceType::none ||
        (appSettings.keyMapping.keyMotionRecord[0].code == BTN_R2 && appSettings.keyMapping.keyMotionErase[0].code == BTN_L2)) {
      appSettings.keyMapping.keyMotionRecord[0] = (InputCode){InputDeviceType::keyboard, BTN_L2};
      appSettings.keyMapping.keyMotionErase[0] = (InputCode){InputDeviceType::keyboard, BTN_R2};
    }
  }

  // Keyboard input reset
  appResetInputState();
  motionRecordHeld = 0;
  motionEraseHeld = 0;
  motionLiveHeld = 0;
  motionLiveLatched = 0;
  quickHelpSelectHeld = 0;
  quickHelpSelectAlone = 0;
  updateMotionRecordMode();

  webStartupStage("STATE");
  // Clear screen
  gfxSetBgColor(appSettings.colorScheme.background);
  gfxClear();

  // Initialize waveform display
  waveformDisplayInit();
  monitorDisplayInit();

  // Create ChipNomad state
  chipnomadState = chipnomadCreate();
  if (!chipnomadState) {
#ifdef WEB_BUILD
    webStartupStage("STATE FAILED");
#endif
    return;
  }

  webStartupStage("PROJECT");

  // Restore autosave; a bundled Grieg demo is the first-launch fallback.
  int projectLoaded = 0;
  FILE* autosaveCheck = fopen(getAutosavePath(), "rb");
  int autosaveExists = autosaveCheck != NULL;
  if (autosaveCheck) fclose(autosaveCheck);
  if (projectLoad(&chipnomadState->project, getAutosavePath()) == 0) {
    projectLoaded = 1;
  }
  // Only a genuine parse failure is worth warning about - no autosave yet
  // (first launch) is normal and falls through to the demo silently.
  autosaveLoadFailed = autosaveExists && !projectLoaded;
#ifdef WEB_BUILD
  const char* defaultProject = "/projects/grieg-mountain-king-fm.cct";
#else
  const char* defaultProject = "projects/grieg-mountain-king-fm.cct";
#endif
  if (!projectLoaded && projectLoad(&chipnomadState->project, defaultProject) == 0) {
    projectLoaded = 1;
    extractFilenameWithoutExtension(defaultProject, appSettings.projectFilename, FILENAME_LENGTH + 1);
  }
  if (!projectLoaded) projectInitAY(&chipnomadState->project);

  webStartupStage("SCREENS");

  // Initialize all screen states
  screensInitAll();

  playbackInit(&chipnomadState->playbackState, &chipnomadState->project);

  // Set mix volume from settings
  chipnomadState->mixVolume = appSettings.mixVolume;
  chipnomadState->aySampleDithering = appSettings.aySampleDithering;

  webStartupStage("DSP");

  // Initialize audio system
  chipnomadInitChips(chipnomadState, appSettings.audioSampleRate, NULL);
  chipnomadSetQuality(chipnomadState, (ChipNomadQuality)appSettings.quality);
  chipnomadSetBraidsSettings(chipnomadState, appSettings.braidsBits,
    appSettings.braidsDrift, appSettings.braidsSignature,
    appSettings.braidsSignatureSeed);

  webStartupStage("AUDIO");
  audioManager.start(appSettings.audioSampleRate, appSettings.audioBufferSize);
  audioManager.resume();

  webStartupStage("MIDI");
  int savedInputPort = findMidiPortByName(1, appSettings.midiInputDeviceName);
  if (savedInputPort >= 0 && midiRouterOpenInput(savedInputPort) == 0) appSettings.midiInputDevice = savedInputPort;
  int savedOutputPort = findMidiPortByName(0, appSettings.midiOutputDeviceName);
  if (savedOutputPort >= 0 && midiRouterOpenOutput(savedOutputPort) == 0) appSettings.midiOutputDevice = savedOutputPort;
  midiRouterSetChannelInstrumentMap(chipnomadState->midiRouter, appSettings.midiChannelInstrument);

#ifdef WEB_BUILD
  // Do not yield after the last native startup stage. A final emscripten_sleep(0)
  // here can leave the browser waiting for the main loop before JavaScript ever
  // receives the ready handoff.
  screenSetup(&screenSong, 0);
  EM_ASM({
    if (typeof window !== 'undefined' && typeof window.wroomStartupStage === 'function') {
      window.wroomStartupStage('READY');
    }
    if (typeof window !== 'undefined' && typeof window.wroomRuntimeReady === 'function') {
      window.wroomRuntimeReady();
    }
  });
#else
  screenSetup(&screenTitle, 0);
#endif
}

#ifdef WEB_BUILD
extern "C" EMSCRIPTEN_KEEPALIVE int webSaveProject(const char* path) {
  if (!chipnomadState || !path || !path[0]) return 1;
  return projectSave(&chipnomadState->project, path);
}

extern "C" EMSCRIPTEN_KEEPALIVE int webCurrentScreen(void) {
  if (currentScreen == &screenSong) return 0;
  if (currentScreen == &screenChain) return 1;
  if (currentScreen == &screenPhrase) return 2;
  if (currentScreen == &screenInstrument) return 3;
  if (currentScreen == &screenMixer) return 4;
  if (currentScreen == &screenProject) return 5;
  if (currentScreen == &screenSettings) return 6;
  if (currentScreen == &screenTitle) return 7;
  return -1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int webOpenScreen(int screen) {
  if (!chipnomadState) return 1;

  if (screen == 1 || screen == 2) {
    if (!pSongRow || !pSongTrack || *pSongRow < 0 || *pSongRow >= PROJECT_MAX_LENGTH ||
        *pSongTrack < 0 || *pSongTrack >= chipnomadState->project.tracksCount) return 2;
    uint16_t chain = chipnomadState->project.song[*pSongRow][*pSongTrack];
    if (chain == EMPTY_VALUE_16 || chain >= PROJECT_MAX_CHAINS) return 3;

    if (screen == 2) {
      if (!pChainRow || *pChainRow < 0 || *pChainRow >= 16) return 4;
      uint16_t phrase = chipnomadState->project.chains[chain].rows[*pChainRow].phrase;
      if (phrase == EMPTY_VALUE_16 || phrase >= PROJECT_MAX_PHRASES) return 5;
    }
  }

  switch (screen) {
    case 0: screenSetup(&screenSong, 0); break;
    case 1: screenSetup(&screenChain, 0); break;
    case 2: screenSetup(&screenPhrase, 0); break;
    case 3: screenSetup(&screenInstrument, cInstrument); break;
    case 4: screenSetup(&screenMixer, 0); break;
    case 5: screenSetup(&screenProject, 0); break;
    case 6: screenSetup(&screenSettings, 0); break;
    default: return 6;
  }
  return 0;
}

// Read-only representation of the native appDraw() per-track monitor.
// The tiny waveform is the actual waveformDisplayGetBitmap() glyph, honoring
// TrackVisualMode and chip-specific rendering, not a second synthetic scope.
// Preserve the native all-screen keyboard: engine-resolved pitches and
// chord voices, respecting the actual enabled track mask.
extern "C" EMSCRIPTEN_KEEPALIVE int webMonitorPianoNotes(void) {
  return (int)monitorPianoNotes();
}

extern "C" EMSCRIPTEN_KEEPALIVE int webTrackActivityPacked(int track) {
  if (!chipnomadState || track < 0 || track >= chipnomadState->project.tracksCount) return -1;
  const PlaybackStatus* playback = chipnomadGetPlaybackStatus(chipnomadState);
  if (!playback) return -1;
  return (playback->tracks[track].note.pitchFinal & 255) |
    ((audioManager.trackStates[track] & 3) << 8) |
    ((chipnomadState->trackClipping[track] > 0 ? 1 : 0) << 10) |
    ((appSettings.pitchConflictWarning && chipnomadState->trackWarnings[track] > 0 ? 1 : 0) << 11) |
    ((pSongTrack && *pSongTrack == track ? 1 : 0) << 12);
}
extern "C" EMSCRIPTEN_KEEPALIVE const char* webTrackActivityNote(int track) {
  if (!chipnomadState || track < 0 || track >= chipnomadState->project.tracksCount) return "---";
  const PlaybackStatus* playback = chipnomadGetPlaybackStatus(chipnomadState);
  return playback ? noteName(&chipnomadState->project, playback->tracks[track].note.pitchFinal) : "---";
}
// 2 hex digits width, 2 hex digits height, one grayscale nibble per pixel.
// Max 32x32, no heap allocation. Called on UI thread only.
extern "C" EMSCRIPTEN_KEEPALIVE const char* webTrackActivityGlyph(int track) {
  static char data[4 + 32 * 32 + 1];
  data[0] = 0;
  if (!chipnomadState || track < 0 || track >= chipnomadState->project.tracksCount) return data;
  const Bitmap* bmp = waveformDisplayGetBitmap(track);
  if (!bmp || !bmp->data || bmp->widthPixels < 1 || bmp->widthPixels > 32 ||
      bmp->heightPixels < 1 || bmp->heightPixels > 32) return data;
  static const char digits[] = "0123456789ABCDEF";
  const int w = bmp->widthPixels, h = bmp->heightPixels;
  data[0] = digits[(w >> 4) & 15]; data[1] = digits[w & 15];
  data[2] = digits[(h >> 4) & 15]; data[3] = digits[h & 15];
  for (int i = 0; i < w * h; ++i) data[i + 4] = digits[bmp->data[i] >> 4];
  data[4 + w * h] = 0;
  return data;
}

// Web visual telemetry from the existing post-level per-track PCM monitor.
// Preserve small genuine signals as signed 16-bit samples. Browser auto-gain
// changes only the picture, never the engine, track level, or audio callback.
extern "C" EMSCRIPTEN_KEEPALIVE const char* webTrackAudioScopeHex(int track) {
  if (!chipnomadState || track < 0 || track >= chipnomadState->project.tracksCount) return "";
  const float* samples = monitorDisplayTrackSamples(track);
  if (!samples) return "";
  static char data[AUDIO_MONITOR_SAMPLES * 4 + 1];
  static const char digits[] = "0123456789ABCDEF";
  for (int i = 0; i < AUDIO_MONITOR_SAMPLES; ++i) {
    float v = samples[i];
    if (!(v >= -1.0f && v <= 1.0f)) {
      if (v < -1.0f) v = -1.0f;
      else if (v > 1.0f) v = 1.0f;
      else v = 0.0f; // NaN
    }
    const int amplitude = (int)(v * (v < 0.0f ? 32768.0f : 32767.0f) +
                               (v < 0.0f ? -0.5f : 0.5f));
    const unsigned bits = (unsigned)(uint16_t)(int16_t)amplitude;
    data[i * 4] = digits[(bits >> 12) & 15];
    data[i * 4 + 1] = digits[(bits >> 8) & 15];
    data[i * 4 + 2] = digits[(bits >> 4) & 15];
    data[i * 4 + 3] = digits[bits & 15];
  }
  data[AUDIO_MONITOR_SAMPLES * 4] = 0;
  return data;
}

extern "C" EMSCRIPTEN_KEEPALIVE int webPlaybackIsPlaying(void) {
  if (!chipnomadState) return 0;
  const PlaybackStatus* status = chipnomadGetPlaybackStatus(chipnomadState);
  return status && status->isPlaying ? 1 : 0;
}

// Compact UI-facing playback snapshot for one track.
// song/chain/phrase positions are encoded as value+1 so zero means "inactive".
// Keeping this behind WEB_BUILD lets the browser render canonical engine state
// without exposing mutable PlaybackState or polling every Song cell.
extern "C" EMSCRIPTEN_KEEPALIVE int webPlaybackTrackPacked(int track) {
  if (!chipnomadState || track < 0 || track >= chipnomadState->project.tracksCount) return 0;
  const PlaybackStatus* status = chipnomadGetPlaybackStatus(chipnomadState);
  if (!status) return 0;

  const PlaybackTrackState* state = &status->tracks[track];
  int song = state->songRow >= 0 && state->songRow < PROJECT_MAX_LENGTH ? state->songRow + 1 : 0;
  int chain = state->chainRow >= 0 && state->chainRow < 16 ? state->chainRow + 1 : 0;
  int phrase = state->phraseRow >= 0 && state->phraseRow < 16 ? state->phraseRow + 1 : 0;
  int mode = ((int)state->mode) & 0x1f;

  return (song & 0x1ff) |
    ((chain & 0x1f) << 9) |
    ((phrase & 0x1f) << 14) |
    (mode << 19);
}

extern "C" EMSCRIPTEN_KEEPALIVE void webStopPlayback(void) {
  if (chipnomadState) chipnomadQueuePlaybackStop(chipnomadState);
}

extern "C" EMSCRIPTEN_KEEPALIVE void webProjectChanged(void) {
  audioProjectDirty = 1;
}

// The Web mixer edits canonical Project state; DSP consumes the next safe audio snapshot.
extern "C" EMSCRIPTEN_KEEPALIVE int webMixTrackPan(int track) {
  if (!chipnomadState || track < 0 ||
      track >= chipnomadState->project.tracksCount) return -1;
  return (int)chipnomadState->project.trackPan[track];
}

extern "C" EMSCRIPTEN_KEEPALIVE int webMixSetTrackPan(int track, int value) {
  if (!chipnomadState || track < 0 ||
      track >= chipnomadState->project.tracksCount ||
      value < 0 || value > 255) return 1;
  if (chipnomadState->project.trackPan[track] != (uint8_t)value) {
    chipnomadState->project.trackPan[track] = (uint8_t)value;
    projectModified = 1;
    audioProjectDirty = 1;
  }
  return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE void webSemanticAction(int action) {
  int keys = 0;
  switch (action) {
    case 0: keys = keyPlay; break;
    case 1: keys = keyEdit; break;
    case 2: keys = keyOpt; break;
    case 3: keys = keyEdit | keyOpt; break;
    default: return;
  }
  appInput(1, keys, 1);
  appInput(0, 0, 0);
}

extern "C" EMSCRIPTEN_KEEPALIVE void webTouchTapAt(int physicalX, int physicalY) {
  int col = 0, row = 0;
  if (!gfxGetTouchGridPosition(physicalX, physicalY, &col, &row)) return;
  screenTouchTap(col, row);
}

extern "C" EMSCRIPTEN_KEEPALIVE void webTouchAdjustAt(int physicalX, int physicalY, int delta) {
  int col = 0, row = 0;
  if (!gfxGetTouchGridPosition(physicalX, physicalY, &col, &row)) return;
  TouchAdjustResult adjust = screenTouchAdjust(col, row);
  if (!adjust || delta == 0) return;
  int direction = delta > 0 ? keyUp : keyDown;
  if (adjust == touchAdjustFine) direction = delta > 0 ? keyRight : keyLeft;
  appInput(1, keyEdit | direction, 1);
  appInput(0, 0, 0);
}
#endif

/**
* @brief Release all resources before closing the application
*/
void appCleanup(void) {
  audioManager.stop();
  // Explicitly flush and close MIDI I/O rather than relying on process exit:
  // the output port owns a worker thread that must be stopped and joined
  // cleanly, and any still-sounding note must get a Note Off while the port
  // is still open.
  chipnomadMidiPanic(chipnomadState);
  midiRouterCloseInput();
  midiRouterCloseOutput();
  midiRouterResetHeldNotes(chipnomadState->midiRouter);
  chipnomadDestroy(chipnomadState);
  chipnomadState = NULL;
}

/**
* @brief Main draw function. Draws playback status
*/
void appDraw(void) {
  const ColorScheme cs = appSettings.colorScheme;

  monitorDisplayUpdate();
  screenDraw();

  if (currentScreen == &screenTitle ||
      currentScreen == &screenSelectionPopup) return;

  if (!chipnomadState) return;

  pianoDisplayDraw();
  waveformDisplayRefresh();

  // Tracks
  char digit[2] = "0";
  for (int c = 0; c < chipnomadState->project.tracksCount; c++) {
    // Draw mute/solo indicator to the left of track number
    gfxSetFgColor(cs.textTitles);
    if (audioManager.trackStates[c] == TRACK_MUTED) {
      gfxPrint(34, 3 + c, "M");
    } else if (audioManager.trackStates[c] == TRACK_SOLO) {
      gfxPrint(34, 3 + c, "S");
    } else {
      gfxPrint(34, 3 + c, " "); // Clear indicator
    }

    // Keep the clipping source visible on every screen, not only in the mixer.
    int useOverloadColor = (chipnomadState->trackClipping[c] > 0);
    gfxSetFgColor(useOverloadColor ? cs.warning :
      (*pSongTrack == c ? cs.textDefault : cs.textInfo));
    digit[0] = c + 49;
    gfxPrint(35, 3 + c, digit);

    // Draw waveform between track number and note
    gfxSetFgColor(cs.textInfo);
    Bitmap* waveformBitmap = waveformDisplayGetBitmap(c);
    gfxClearRect(36, 3 + c, 1, 1);
    if (waveformBitmap) {
      gfxDrawBitmap(waveformBitmap, 36, 3 + c);
    }

    uint8_t note = chipnomadGetPlaybackStatus(chipnomadState)->tracks[c].note.pitchFinal;
    const char* noteStr = noteName(&chipnomadState->project, note);

    // Use warning color if track warning is active
    int useWarningColor = (appSettings.pitchConflictWarning && chipnomadState->trackWarnings[c] > 0);

    gfxSetFgColor(useWarningColor ? cs.warning :
      (noteStr[0] == '-' ? cs.textEmpty : cs.textValue));
      gfxPrint(37, 3 + c, noteStr);
  }

  int realtimeOverflow = chipnomadGetMotionRecordOverflow() ||
    chipnomadGetCommandOverflow(chipnomadState) || chipnomadGetRenderBufferOverflow(chipnomadState);
  if (motionEraseHeld) {
    gfxSetFgColor(cs.warning);
    gfxPrint(39, 19, "x");
  } else if (motionRecordHeld) {
    gfxSetFgColor(realtimeOverflow ? cs.warning : cs.textTitles);
    gfxPrint(39, 19, realtimeOverflow ? "!" : "*");
  } else if (motionLiveActive()) {
    gfxSetFgColor(cs.textTitles);
    gfxPrint(39, 19, "~");
  } else {
    gfxPrint(39, 19, " ");
  }
}

/**
* @brief Main event handler
*
* @param event Event
* @param value Event value
* @param userdata Arbitraty event data
*/
void appOnEvent(MainLoopEventData eventData) {
  static int dPadMask = keyLeft | keyRight | keyUp | keyDown;
  static int doubleTapMask = keyEdit | keyOpt | keyUnmapped | keyPlay;

  switch (eventData.type) {
  case MainLoopEvent::keyDown: {
    int value = inputCodeToKey(eventData.data.input);
    int rawInputActive = inputRawCallback != NULL;

    // Call raw input callback if set (for key mapping screen)
    if (inputRawCallback) {
      inputRawCallback(eventData.data.input, 1);
    }

    if (quickHelpSelectHeld && !rawInputActive && value != keyShift) quickHelpSelectAlone = 0;

#ifdef DESKTOP_BUILD
    // After the quick-help-alone bookkeeping above (it must see every key,
    // even ones key jazz fully consumes below - otherwise releasing Shift
    // after e.g. Shift+S to type an uppercase S would wrongly open Quick
    // Help, since that key never reached the normal pipeline to cancel it).
    if (currentScreen == &screenPhrase && phraseKeyJazzHandleRawKey(eventData.data.input, 1)) break;
    if (currentScreen == &screenSong && songKeyJazzHandleRawKey(eventData.data.input, 1)) break;
    if (currentScreen == &screenChain && chainKeyJazzHandleRawKey(eventData.data.input, 1)) break;
    if (keyJazzTextHandleRawKey(eventData.data.input, 1, currentScreen)) break;
#endif

    if (!rawInputActive && (isMotionRecordTrigger(eventData.data.input) ||
        (eventData.data.input.deviceType == InputDeviceType::logical && eventData.data.input.code == keyMotionRecord))) {
      motionRecordHeld = 1;
      updateMotionRecordMode();
      break;
    }
    int liveInputMask = motionLiveInputMask(eventData.data.input);
    if (!rawInputActive && liveInputMask) {
      if (!motionLiveHeld && appSettings.stickLiveMode == StickLiveMode::toggle)
        motionLiveLatched = !motionLiveLatched;
      motionLiveHeld |= liveInputMask;
      updateMotionRecordMode();
      break;
    }
    if (!rawInputActive && (isMotionEraseTrigger(eventData.data.input) ||
        (eventData.data.input.deviceType == InputDeviceType::logical && eventData.data.input.code == keyMotionErase))) {
      motionEraseHeld = 1;
      updateMotionRecordMode();
      break;
    }

    // PortMaster may expose the same physical control through gptokeyb and
    // SDL's controller API. Ignore an unmapped controller duplicate even on
    // the key-mapping screen: otherwise it can stay held while the mapped
    // keyboard event switches screens, making every later D-pad press a
    // combination and freezing navigation.
#if defined(PORTMASTER_BUILD) || defined(TEST_PORTMASTER_INPUT)
    if (eventData.data.input.deviceType == InputDeviceType::gamepad && value == keyUnmapped) break;
#endif
    if (value == keyUnmapped && currentScreen != &screenKeyMapping) break;

    // Ignore duplicate downs. SDL keyboard repeat is filtered by the platform
    // loop, but this also protects tap detection from duplicate device events.
    if (pressedButtons & value) break;

    if (!rawInputActive && value == keyShift && pressedButtons == 0) {
      quickHelpSelectHeld = 1;
      quickHelpSelectAlone = 1;
    } else if (quickHelpSelectHeld) {
      quickHelpSelectAlone = 0;
    }

    pressedButtons |= value;

    // Multi-tap detection
    if (value & doubleTapMask) {
      if (value == tapButton && tapTimerCount > 0) {
        // Same button pressed again within timer - increment tap count
        tapCount++;
      } else {
        // First tap or different button - start new tap sequence
        tapButton = value;
        tapCount = 1;
      }
      tapTimerCount = appSettings.doubleTapFrames;
    } else {
      // Non-multi-tap button pressed - reset tap state
      tapButton = 0;
      tapCount = 1;
      tapTimerCount = 0;
    }

    if (value & dPadMask) {
      // Key repeats are only applicable to d-pad
      keyRepeatCount = appSettings.keyRepeatDelay;
      // As we don't support multiple d-pad keys, keep only the last pressed one
      pressedButtons = (pressedButtons & ~dPadMask) | value;
    }
    appInput(1, pressedButtons, tapCount);

    break;
  }
  case MainLoopEvent::keyUp: {
#ifdef DESKTOP_BUILD
    if (currentScreen == &screenPhrase && phraseKeyJazzHandleRawKey(eventData.data.input, 0)) break;
    if (currentScreen == &screenSong && songKeyJazzHandleRawKey(eventData.data.input, 0)) break;
    if (currentScreen == &screenChain && chainKeyJazzHandleRawKey(eventData.data.input, 0)) break;
    if (keyJazzTextHandleRawKey(eventData.data.input, 0, currentScreen)) break;
#endif
    int value = inputCodeToKey(eventData.data.input);
    int rawInputActive = inputRawCallback != NULL;

    // Call raw input callback if set (for key mapping screen)
    if (inputRawCallback) {
      inputRawCallback(eventData.data.input, 0);
    }

    if (!rawInputActive && (isMotionRecordTrigger(eventData.data.input) ||
        (eventData.data.input.deviceType == InputDeviceType::logical && eventData.data.input.code == keyMotionRecord))) {
      motionRecordHeld = 0;
      updateMotionRecordMode();
      break;
    }
    int liveInputMask = motionLiveInputMask(eventData.data.input);
    if (!rawInputActive && liveInputMask) {
      motionLiveHeld &= ~liveInputMask;
      updateMotionRecordMode();
      break;
    }
    if (!rawInputActive && (isMotionEraseTrigger(eventData.data.input) ||
        (eventData.data.input.deviceType == InputDeviceType::logical && eventData.data.input.code == keyMotionErase))) {
      motionEraseHeld = 0;
      updateMotionRecordMode();
      break;
    }

    // See keyDown: PortMaster's unmapped SDL duplicate must never affect the
    // held-button state, including if its release arrives after a screen swap.
#if defined(PORTMASTER_BUILD) || defined(TEST_PORTMASTER_INPUT)
    if (eventData.data.input.deviceType == InputDeviceType::gamepad && value == keyUnmapped) break;
#endif
    if (value == keyUnmapped && currentScreen != &screenKeyMapping) break;

    pressedButtons &= ~value;

    appInput(0, pressedButtons, 0);

    if (!rawInputActive && value == keyShift && quickHelpSelectHeld &&
        quickHelpSelectAlone && pressedButtons == 0 && appSettings.quickHelpReleaseSeen < 5) {
      appSettings.quickHelpReleaseSeen++;
      screenQuickHelpOpen(currentScreen);
    }
    if (value == keyShift) quickHelpSelectHeld = 0;

    if (pressedButtons == 0) {
      // Clean untimed screen message when all keys are released
      screenMessage(0, "");
    }

    break;
  }
  case MainLoopEvent::gamepadAxes:
    chipnomadSetLiveStickAxes(eventData.data.axes[0], eventData.data.axes[1],
                              eventData.data.axes[2], eventData.data.axes[3]);
    break;
  case MainLoopEvent::tick: {
    int motionRecordChanged = 0;
    MotionRecordEvent motionRecordEvent;
    while (chipnomadConsumeMotionRecordEvent(&motionRecordEvent))
      motionRecordChanged |= applyMotionRecordEvent(motionRecordEvent);
    if (motionRecordChanged) {
      projectModified = 1;
      audioProjectDirty = 1;
      if (currentScreen == &screenPhrase) currentScreen->fullRedraw();
    }
    if (audioProjectDirty && chipnomadQueueProjectRefresh(chipnomadState)) audioProjectDirty = 0;

#ifdef ANDROID_BUILD
    refreshAndroidMidiConnections();
#endif

    // MIDI-in sound preview: an external MIDI keyboard auditions a sound on
    // the current track - not note entry into the song - the same way the
    // on-screen Edit+Play preview shortcut does on the Instrument screen.
    // Available on every screen so a multi-channel keyboard (channel mapping
    // is Settings > MIDI > Channel mapping) can be played live regardless of
    // what's on screen. Channel routing, last-note-priority legato and the
    // held-note stack all live in the router now (see midi/midi_router.h);
    // this just applies the resulting intents to the current track.
    //
    // midiRouterTick always drains the backend's poll queue even when we
    // won't act on the result (below), so a keyboard held/played while the
    // song is actually playing doesn't back up in the backend's own queue
    // and dump a burst of stale notes once the song stops. Previewing itself
    // puts the track in PlaybackMode::phraseRow, which must stay "safe"
    // here - gating on the track being merely "not stopped" (e.g.
    // chipnomadGetPlaybackStatus's isPlaying) would block every note after
    // the first, since the first note's own preview never fully lets go of
    // the track between key presses.
    {
      PlaybackMode trackMode = chipnomadGetPlaybackStatus(chipnomadState)->tracks[*pSongTrack].mode;
      int previewSafe = trackMode == PlaybackMode::stopped || trackMode == PlaybackMode::phraseRow;
      MidiPreviewIntent intents[16];
      int intentCount = midiRouterTick(chipnomadState->midiRouter, cInstrument, intents, 16);
      if (previewSafe) {
        for (int i = 0; i < intentCount; i++) {
          if (intents[i].stop) {
            chipnomadQueuePlaybackStopPreview(chipnomadState, *pSongTrack);
          } else if (!instrumentIsEmpty(&chipnomadState->project, intents[i].instrument)) {
            chipnomadQueuePlaybackPreviewNote(chipnomadState, *pSongTrack, intents[i].note, intents[i].instrument);
          }
        }
      }
      for (int i = 0; i < PROJECT_MAX_MIDI_CC_MAPPINGS; ++i) {
        MidiCCMapping& mapping = chipnomadState->project.midiCCMappings[i];
        int globalTrack = mapping.destination >= midiCCDestinationTrackMute &&
          mapping.destination <= midiCCDestinationTrackDelaySend;
        int valid = mapping.enabled && mapping.channel < 16 && mapping.cc < 128 &&
          (mapping.destination == midiCCDestinationSongPlayStop ||
           (globalTrack && mapping.instrument < PROJECT_MAX_TRACKS) ||
           (mapping.instrument < PROJECT_MAX_INSTRUMENTS &&
            instrumentCCDestinationAvailable(&chipnomadState->project.instruments[mapping.instrument], mapping.destination)));
        int changed = !midiCCAppliedValid[i] || memcmp(&mapping, &midiCCApplied[i], sizeof(mapping)) != 0;
        uint8_t value = 0; uint32_t serial = 0;
        int received = valid && midiRouterGetCCValue(chipnomadState->midiRouter, mapping.channel, mapping.cc, &value, &serial);
        if (valid && changed) {
          midiCCApplied[i] = mapping;
          midiCCAppliedValue[i] = 0;
          midiCCAppliedValid[i] = 1;
          // Soft takeover: a mapping must see a new physical CC movement
          // after it is assigned, so MIDI Learn cannot overwrite a patch
          // with the controller's stale (often zero) position.
          midiCCAppliedSerial[i] = serial;
        } else if (valid && received && serial != midiCCAppliedSerial[i]) {
          if (mapping.destination == midiCCDestinationSongPlayStop) {
            if (value >= 64 && midiCCAppliedValue[i] < 64 && !chipnomadGetPlaybackStatus(chipnomadState)->isPlaying)
              chipnomadQueuePlaybackStartSong(chipnomadState, *pSongRow, 0, 1);
            else if (value < 64 && midiCCAppliedValue[i] >= 64 && chipnomadGetPlaybackStatus(chipnomadState)->isPlaying)
              chipnomadQueuePlaybackStop(chipnomadState);
          } else if (globalTrack) {
            int track = mapping.instrument;
            if (mapping.destination == midiCCDestinationTrackMute &&
                ((value >= 64) != (audioManager.trackStates[track] == TRACK_MUTED))) audioManager.toggleTrackMute(track);
            else if (mapping.destination == midiCCDestinationTrackSolo &&
                     ((value >= 64) != (audioManager.trackStates[track] == TRACK_SOLO))) audioManager.toggleTrackSolo(track);
            else if (mapping.destination == midiCCDestinationTrackVolume)
              chipnomadState->project.trackVolume[track] = (uint8_t)((value * 100 + 63) / 127);
            else if (mapping.destination == midiCCDestinationTrackReverbSend)
              chipnomadState->project.trackReverbSend[track] = (uint8_t)((value * 100 + 63) / 127);
            else if (mapping.destination == midiCCDestinationTrackDelaySend)
              chipnomadState->project.trackDelaySend[track] = (uint8_t)((value * 100 + 63) / 127);
          } else {
            instrumentSetCCDestination(&chipnomadState->project.instruments[mapping.instrument], mapping.destination, value);
          }
          midiCCAppliedValue[i] = value;
          midiCCAppliedSerial[i] = serial;
          projectModified = 1;
          audioProjectDirty = 1;
          if (currentScreen) currentScreen->fullRedraw();
        } else if (!valid && midiCCAppliedValid[i]) {
          midiCCAppliedValid[i] = 0;
        }
      }
    }
    // Autosave
    if (++autosaveCounter >= AUTOSAVE_INTERVAL_FRAMES) {
      autosaveCounter = 0;
      projectSave(&chipnomadState->project, getAutosavePath());
    }

    // Multi-tap timer handling
    if (tapTimerCount > 0) {
      tapTimerCount--;
      if (tapTimerCount == 0) {
        // Timer expired, reset tap count
        tapCount = 0;
        tapButton = 0;
      }
    }

    // Key repeat handling
    if (keyRepeatCount > 0) {
      int maskedButtons = pressedButtons & dPadMask;
      // Only one d-pad button can be pressed for key repeats
      if (maskedButtons == keyLeft || maskedButtons == keyRight || maskedButtons == keyUp || maskedButtons == keyDown) {
        keyRepeatCount--;
        if (keyRepeatCount == 0) {
          keyRepeatCount = appSettings.keyRepeatSpeed;
          appInput(1, pressedButtons, 0);
        }
      } else {
        keyRepeatCount = 0;
      }
    }
    break;
  }
  case MainLoopEvent::exit:
    // Auto-save the current project and settings on exit
    projectSave(&chipnomadState->project, getAutosavePath());
    settingsSave();
    break;
  case MainLoopEvent::sleep:
    // Pause audio when app goes to background
    audioManager.pause();
    if (chipnomadState) {
      // Stop playback to avoid state issues
      chipnomadQueuePlaybackStop(chipnomadState);
      // Auto-save project
      projectSave(&chipnomadState->project, getAutosavePath());
    }
    // Save settings
    settingsSave();
    break;
  case MainLoopEvent::wake:
    // Resume audio when app comes back to foreground
    audioManager.resume();
    break;
  case MainLoopEvent::fullRedraw:
    // Force full screen redraw
    gfxSetBgColor(appSettings.colorScheme.background);
    gfxClear();
    if (currentScreen) {
      currentScreen->fullRedraw();
      if (currentScreen != &screenTitle)
        drawScreenMap();
    }
    break;
  case MainLoopEvent::touchTap:
    screenTouchTap(eventData.data.touch.x, eventData.data.touch.y);
    break;
  case MainLoopEvent::touchAdjust:
    if (TouchAdjustResult adjust = screenTouchAdjust(eventData.data.touch.x, eventData.data.touch.y)) {
      int direction = eventData.data.touch.direction;
      if (adjust == touchAdjustFine)
        direction = direction == keyUp ? keyRight : keyLeft;
      appInput(1, keyEdit | direction, 1);
    }
    break;
  case MainLoopEvent::touchNavigate:
    appInput(1, keyShift | eventData.data.touch.direction, 1);
    appInput(0, 0, 0);
    break;
  }
}
