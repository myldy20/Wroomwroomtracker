(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const canvas = $("#canvas");
  const status = $("#status");
  const startOverlay = $("#startOverlay");
  const startButton = $("#startButton");
  const fileButtons = $$("[data-needs-runtime]");
  const semanticWorkspace = $("#semanticWorkspace");
  const legacyWorkspace = $("#legacyWorkspace");
  const songWorkspace = $("#songWorkspace");
  const mixWorkspace = $("#mixWorkspace");
  const mixTrackRows = $("#mixTrackRows");
  const songGrid = $("#songGrid");
  const songScroll = $("#songScroll");
  const masterMeterChannels = [...document.querySelectorAll("#masterMeter .master-meter-channel")];
  const masterMeterFills = [$("#masterPeakL"), $("#masterPeakR")];
  const masterDisplayed = [0, 0];
  const chainPickerDialog = $("#chainPickerDialog");
  const chainPickerSearch = $("#chainPickerSearch");
  const chainPickerList = $("#chainPickerList");
  let trackerStarted = false;
  let activeUiScreen = 0;
  let nativeMixerExpanded = false;
  let songRendered = false;
  let songMinimumRows = 32;
  let songSelection = { row: 0, track: 0 };
  let songLastTap = { row: -1, track: -1, time: 0 };
  let chainPickerEntries = [];
  let lastPlaybackVisualKey = "";
  let storageSyncing = false;
  let storageMounted = false;
  let storageReady = false;
  let pointer = null;
  let lastTap = { time: 0, x: 0, y: 0 };

  const call = (name, returnType = null, argTypes = [], args = []) => {
    if (!window.Module?.ccall) return null;
    return window.Module.ccall(name, returnType, argTypes, args);
  };

  const setStatus = (text) => { status.textContent = text || "READY"; };
  const getFs = () => (typeof FS !== "undefined" ? FS : window.Module?.FS);

  const userPath = (name) => name.split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  const ensureUserDirectories = (fs) => {
    fs.mkdirTree("/user/projects");
    fs.mkdirTree("/user/samples");
    fs.mkdirTree("/user/exports");
  };

  const syncUserStorage = (done) => {
    const fs = getFs();
    if (!fs || !storageMounted || storageSyncing) {
      done?.(null);
      return;
    }
    storageSyncing = true;
    fs.syncfs(false, (error) => {
      storageSyncing = false;
      if (error) setStatus("Browser storage could not be saved");
      done?.(error);
    });
  };

  const initUserStorage = () => {
    const fs = getFs();
    if (!fs || storageMounted) return;

    try { fs.mkdir("/user"); } catch (_) {}
    try {
      fs.mount(IDBFS, {}, "/user");
      storageMounted = true;
    } catch (error) {
      console.warn("Persistent browser storage unavailable", error);
      setStatus("READY · persistent browser storage unavailable");
      return;
    }

    // Persistence is useful but not required for the tracker to start.
    // Populate IDBFS in the background so a slow/blocked IndexedDB can never
    // hold the Emscripten runtime behind a run dependency.
    fs.syncfs(true, (error) => {
      if (error) {
        console.warn("Could not open browser storage", error);
        setStatus("READY · browser storage unavailable");
        return;
      }
      ensureUserDirectories(fs);
      fs.syncfs(false, (saveError) => {
        storageReady = !saveError;
        if (saveError) {
          console.warn("Could not initialize browser storage", saveError);
          setStatus("READY · browser storage is temporary");
        } else {
          setStatus("READY · browser storage connected");
        }
      });
    });
  };

  window.choochooDownloadFile = (path) => {
    const fs = getFs();
    if (!fs) return;
    try {
      const bytes = fs.readFile(path);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([bytes]));
      link.download = path.split("/").pop();
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      syncUserStorage();
    } catch (_) {
      setStatus("Could not download " + path.split("/").pop());
    }
  };

  const importFiles = async (files, root) => {
    const fs = getFs();
    if (!fs) return 0;
    let count = 0;
    for (const file of files) {
      const relativePath = userPath(file.webkitRelativePath || file.name);
      if (!relativePath) continue;
      const path = root + "/" + relativePath;
      fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
      count++;
    }
    syncUserStorage((error) => setStatus(error ? "Imported in memory; persistent save failed" : count + " file(s) imported"));
    return count;
  };

  const canvasPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - rect.left) * canvas.width / rect.width),
      y: Math.round((event.clientY - rect.top) * canvas.height / rect.height),
    };
  };

  const selectAt = (point) => call("webTouchTapAt", null, ["number", "number"], [point.x, point.y]);
  const performEdit = () => call("webSemanticAction", null, ["number"], [1]);

  const setPhraseNote = (value) => {
    const result = call("webPhraseSetNote", "number", ["number"], [value]);
    if (result === 0) {
      call("webProjectChanged");
      $("#noteDialog").close();
      canvas.focus();
      setStatus(value === -1 ? "Note cleared" : value === -2 ? "Note Off inserted" : "Note changed");
    }
  };

  const openNoteEditor = () => {
    if (call("webCurrentScreen", "number") !== 2 ||
        call("webPhraseCursorColumn", "number") !== 0) return false;

    const noteDialog = $("#noteDialog");
    const noteGrid = $("#noteGrid");
    const pitchCount = Math.max(0, call("webPitchCount", "number") || 0);
    const octaveSize = Math.max(1, call("webPitchOctaveSize", "number") || 12);
    const current = call("webPhraseCurrentNote", "number");
    const row = call("webPhraseCursorRow", "number");

    $("#noteDialogTitle").textContent = "Row " + (row >= 0 ? row.toString(16).toUpperCase().padStart(2, "0") : "--");
    noteGrid.replaceChildren();

    const fragment = document.createDocumentFragment();
    for (let note = 0; note < pitchCount; note++) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.noteValue = String(note);
      button.dataset.octaveStart = note % octaveSize === 0 ? "true" : "false";
      button.classList.toggle("active", note === current);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", note === current ? "true" : "false");
      button.textContent = call("webPitchName", "string", ["number"], [note]) || String(note);
      fragment.appendChild(button);
    }
    noteGrid.appendChild(fragment);

    noteDialog.showModal();
    requestAnimationFrame(() => {
      noteGrid.querySelector(".active")?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return true;
  };

  const editCurrent = () => {
    if (!openNoteEditor()) performEdit();
  };

  const screenNames = ["SONG", "CHAIN", "PHRASE", "SOUND", "MIX", "PROJECT", "SETTINGS", "START"];
  const screenEyebrows = ["ARRANGEMENT", "STRUCTURE", "NOTES + FX", "INSTRUMENT", "MIXER", "PROJECT", "SETTINGS", "START"];
  const hex2 = (value) => Math.max(0, value | 0).toString(16).toUpperCase().padStart(2, "0");

  const chainSummary = (chain) => {
    const packed = call("webSongChainSummary", "number", ["number"], [chain]);
    if (packed == null || packed < 0) return null;
    return {
      chain,
      usage: packed & 0x0fff,
      steps: (packed >> 12) & 0x1f,
      hasNotes: !!(packed & (1 << 17)),
    };
  };

  const songCellState = (row, track) => {
    const packed = call("webSongCellPacked", "number", ["number", "number"], [row, track]);
    if (packed == null || packed < 0) return { value: -1, hasNotes: false, highlighted: false };
    const encoded = packed & 0xffff;
    return {
      value: encoded === 0 ? -1 : encoded - 1,
      hasNotes: !!(packed & (1 << 16)),
      highlighted: !!(packed & (1 << 17)),
    };
  };

  const publishProjectEdit = () => {
    call("webProjectChanged");
    syncUserStorage();
  };

  const setSongValue = (row, track, value, announce = true) => {
    const maxChain = call("webSongMaxChain", "number") ?? 254;
    const normalized = value < 0 ? -1 : Math.max(0, Math.min(maxChain, value | 0));
    if (call("webSongSetCell", "number", ["number", "number", "number"], [row, track, normalized]) !== 0) {
      setStatus("Could not change Song cell");
      return false;
    }
    songSelection = { row, track };
    chainPickerEntries = [];
    publishProjectEdit();
    songRendered = false;
    renderSongWorkspace();
    if (announce) setStatus(normalized < 0 ? "Song cell cleared" : "Chain " + hex2(normalized) + " assigned");
    return true;
  };

  const ensureSongRowRendered = (row) => {
    if (row < songGrid.querySelectorAll(".song-grid-row").length) return;
    const maxRows = Math.max(1, call("webSongRowCount", "number") || 256);
    songMinimumRows = Math.min(maxRows, Math.max(songMinimumRows, row + 8));
    songRendered = false;
    renderSongWorkspace();
  };

  const selectSongCell = (row, track, scroll = false) => {
    if (call("webSongSelect", "number", ["number", "number"], [row, track]) !== 0) return;
    songSelection = { row, track };
    ensureSongRowRendered(row);
    songGrid.querySelectorAll(".song-cell.selected").forEach((cell) => cell.classList.remove("selected"));
    songGrid.querySelectorAll(".song-grid-row.cursor-row").forEach((line) => line.classList.remove("cursor-row"));
    const cell = songGrid.querySelector(`[data-song-row="${row}"][data-song-track="${track}"]`);
    cell?.classList.add("selected");
    cell?.closest(".song-grid-row")?.classList.add("cursor-row");
    updateSongInspector();
    if (scroll) cell?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  };

  const openSelectedChain = () => {
    const state = songCellState(songSelection.row, songSelection.track);
    if (state.value < 0) {
      setStatus("Assign a chain before opening it");
      return;
    }
    call("webSongSelect", "number", ["number", "number"], [songSelection.row, songSelection.track]);
    navigateToScreen(1);
  };

  const loadChainPickerEntries = () => {
    const maxChain = call("webSongMaxChain", "number") ?? 254;
    chainPickerEntries = [];
    for (let chain = 0; chain <= maxChain; chain++) {
      const entry = chainSummary(chain);
      if (!entry) continue;
      // Read a preview once while opening the palette; no extra WASM work
      // during search, playback ticks or normal Song grid rendering.
      entry.preview = (entry.steps || entry.usage)
        ? (call("webSongChainPreview", "string", ["number"], [chain]) || "")
        : "";
      entry.instrumentSearch = entry.steps
        ? (call("webSongChainInstrumentSearch", "string", ["number"], [chain]) || "")
        : "";
      chainPickerEntries.push(entry);
    }
    chainPickerEntries.sort((a, b) =>
      Number(b.usage > 0) - Number(a.usage > 0) ||
      Number(b.hasNotes) - Number(a.hasNotes) ||
      Number(b.steps > 0) - Number(a.steps > 0) ||
      a.chain - b.chain);
  };

  const renderChainPicker = () => {
    const query = chainPickerSearch.value.trim().toUpperCase();
    const current = songCellState(songSelection.row, songSelection.track).value;
    const fragment = document.createDocumentFragment();

    for (const entry of chainPickerEntries) {
      const hex = hex2(entry.chain);
      const decimal = String(entry.chain);
      if (!query && !entry.usage && !entry.steps && entry.chain !== current) continue;
      if (query && !hex.includes(query) && !decimal.includes(query) &&
          !entry.preview.toUpperCase().includes(query) &&
          !entry.instrumentSearch.toUpperCase().includes(query)) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "chain-picker-item";
      if (entry.hasNotes) button.classList.add("has-notes");
      if (entry.chain === current) button.classList.add("current");
      button.dataset.chainValue = String(entry.chain);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", entry.chain === current ? "true" : "false");

      const code = document.createElement("strong");
      code.textContent = hex;
      const details = document.createElement("div");
      details.className = "chain-picker-details";
      const meta = document.createElement("span");
      const usage = entry.usage > 1 ? " · used " + entry.usage + "×" : "";
      meta.textContent = entry.steps
        ? entry.steps + " phrase step" + (entry.steps === 1 ? "" : "s") + usage
        : entry.usage ? "No Phrase assigned" : "Empty slot";
      details.appendChild(meta);
      if (entry.preview) {
        const contents = document.createElement("span");
        contents.className = "chain-picker-preview";
        contents.textContent = entry.preview;
        details.appendChild(contents);
      }
      const dot = document.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      button.append(code, details, dot);
      fragment.appendChild(button);
    }

    const hasResults = fragment.childNodes.length > 0;
    chainPickerList.replaceChildren(fragment);
    $("#chainPickerEmpty").hidden = hasResults;
  };

  const openChainPicker = () => {
    loadChainPickerEntries();
    chainPickerSearch.value = "";
    $("#chainPickerTitle").textContent =
      "Row " + hex2(songSelection.row) + " · Track " + (songSelection.track + 1);
    renderChainPicker();
    if (!chainPickerDialog.open) chainPickerDialog.showModal();
    requestAnimationFrame(() => {
      const current = chainPickerList.querySelector(".chain-picker-item.current");
      (current || chainPickerList.querySelector(".chain-picker-item"))?.scrollIntoView({ block: "center" });
    });
  };

  const buildSongEditorControls = (root, dialogMode = false) => {
    const { row, track } = songSelection;
    const state = songCellState(row, track);
    const maxChain = call("webSongMaxChain", "number") ?? 254;

    root.replaceChildren();

    if (!dialogMode) {
      const stats = document.createElement("div");
      stats.className = "inspector-selection";
      stats.innerHTML =
        '<div class="inspector-stat"><span>ROW</span><strong>' + hex2(row) + '</strong></div>' +
        '<div class="inspector-stat"><span>TRACK</span><strong>' + (track + 1) + '</strong></div>';
      root.appendChild(stats);
    }

    if (state.value >= 0) {
      const preview = call("webSongChainPreview", "string", ["number"], [state.value]) || "";
      const information = document.createElement("div");
      information.className = "song-chain-preview";
      information.textContent = preview || "This Chain has no Phrase steps yet";
      root.appendChild(information);
    }

    const choose = document.createElement("button");
    choose.type = "button";
    choose.id = dialogMode ? "songDialogChooseChain" : "songInspectorChooseChain";
    choose.className = "song-choose-chain";
    choose.textContent = state.value < 0 ? "CHOOSE CHAIN" : "CHANGE CHAIN · " + hex2(state.value);
    choose.addEventListener("click", openChainPicker);
    root.appendChild(choose);

    const actions = document.createElement("div");
    actions.className = dialogMode ? "song-cell-actions" : "inspector-actions";
    const empty = document.createElement("button");
    empty.type = "button";
    empty.textContent = "CLEAR";
    const highlight = document.createElement("button");
    highlight.type = "button";
    highlight.textContent = state.highlighted ? "UNHIGHLIGHT" : "HIGHLIGHT";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "primary";
    open.textContent = "OPEN CHAIN";
    open.disabled = state.value < 0;
    actions.append(empty, highlight, open);
    root.appendChild(actions);

    const direct = document.createElement("details");
    direct.className = "song-direct-number";
    const summary = document.createElement("summary");
    summary.textContent = "DIRECT CHAIN NUMBER";
    const control = document.createElement("div");
    control.className = dialogMode ? "song-chain-input-row" : "inspector-chain-control";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(maxChain);
    input.inputMode = "numeric";
    input.placeholder = "--";
    input.value = state.value < 0 ? "" : String(state.value);
    input.setAttribute("aria-label", "Direct chain number");
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    control.append(minus, input, plus);
    direct.append(summary, control);
    root.appendChild(direct);

    const applyInput = () => {
      if (input.value.trim() === "") return setSongValue(row, track, -1);
      const value = Number.parseInt(input.value, 10);
      if (!Number.isFinite(value)) return false;
      return setSongValue(row, track, value);
    };

    input.addEventListener("change", applyInput);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (applyInput() && dialogMode) $("#songCellDialog").close();
      }
    });
    minus.addEventListener("click", () => {
      const current = songCellState(row, track).value;
      setSongValue(row, track, current < 0 ? 0 : Math.max(0, current - 1));
      if (dialogMode) buildSongDialog();
    });
    plus.addEventListener("click", () => {
      const current = songCellState(row, track).value;
      setSongValue(row, track, current < 0 ? 0 : Math.min(maxChain, current + 1));
      if (dialogMode) buildSongDialog();
    });
    empty.addEventListener("click", () => {
      setSongValue(row, track, -1);
      if (dialogMode) buildSongDialog();
    });
    highlight.addEventListener("click", () => {
      call("webSongToggleHighlight", "number", ["number", "number"], [row, track]);
      publishProjectEdit();
      songRendered = false;
      renderSongWorkspace();
      if (dialogMode) buildSongDialog();
    });
    open.addEventListener("click", openSelectedChain);
  };

  const updateSongInspector = () => {
    const title = $("#inspectorTitle");
    const location = $("#inspectorLocation");
    const body = $("#inspectorBody");
    if (!title || !body) return;
    title.textContent = "SONG CELL";
    location.textContent = "row " + hex2(songSelection.row) + " · track " + (songSelection.track + 1);
    buildSongEditorControls(body, false);
  };

  const buildSongDialog = () => {
    $("#songCellDialogTitle").textContent =
      "Row " + hex2(songSelection.row) + " · Track " + (songSelection.track + 1);
    const body = $("#songCellDialog .field-body");
    buildSongEditorControls(body, true);
  };

  const openSongDialog = () => {
    buildSongDialog();
    const dialog = $("#songCellDialog");
    if (!dialog.open) dialog.showModal();
  };

  const renderSongWorkspace = () => {
    if (!window.Module?.ccall || activeUiScreen !== 0) return;
    const tracks = Math.max(1, call("webSongTrackCount", "number") || 1);
    const maxRows = Math.max(1, call("webSongRowCount", "number") || 256);
    const cursorRow = Math.max(0, call("webSongCursorRow", "number") || 0);
    const cursorTrack = Math.max(0, call("webSongCursorTrack", "number") || 0);
    const lastUsed = Math.max(0, call("webSongLastUsedRow", "number") || 0);
    const rows = Math.min(maxRows, Math.max(songMinimumRows, lastUsed + 10, cursorRow + 6));
    const previousTop = songScroll.scrollTop;
    const previousLeft = songScroll.scrollLeft;

    songSelection = { row: cursorRow, track: Math.min(tracks - 1, cursorTrack) };
    songGrid.style.setProperty("--song-track-count", String(tracks));

    const fragment = document.createDocumentFragment();
    const header = document.createElement("div");
    header.className = "song-grid-header";
    header.style.setProperty("--song-tracks", tracks);
    header.setAttribute("role", "row");
    const corner = document.createElement("div");
    corner.className = "song-corner";
    corner.textContent = "ROW";
    header.appendChild(corner);
    for (let track = 0; track < tracks; track++) {
      const head = document.createElement("div");
      head.className = "song-track-header";
      head.innerHTML = "<strong>TRACK " + (track + 1) + "</strong>";
      const mode = document.createElement("span");
      mode.className = "song-track-mode";
      mode.dataset.track = String(track);
      head.appendChild(mode);
      header.appendChild(head);
    }
    fragment.appendChild(header);

    for (let row = 0; row < rows; row++) {
      const line = document.createElement("div");
      line.className = "song-grid-row";
      line.style.setProperty("--song-tracks", tracks);
      line.setAttribute("role", "row");
      if (row === songSelection.row) line.classList.add("cursor-row");

      const label = document.createElement("div");
      label.className = "song-row-label";
      label.textContent = hex2(row);
      line.appendChild(label);

      for (let track = 0; track < tracks; track++) {
        const state = songCellState(row, track);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "song-cell";
        if (state.value < 0) cell.classList.add("song-cell-empty");
        if (state.value >= 0 && !state.hasNotes) cell.classList.add("assigned-empty");
        if (state.hasNotes) cell.classList.add("has-notes");
        if (state.highlighted) cell.classList.add("highlighted");
        if (row === songSelection.row && track === songSelection.track) cell.classList.add("selected");
        cell.dataset.songRow = String(row);
        cell.dataset.songTrack = String(track);
        cell.setAttribute("role", "gridcell");
        const baseLabel = "Row " + hex2(row) + ", track " + (track + 1) + ", " +
          (state.value < 0 ? "empty" : "chain " + hex2(state.value));
        cell.dataset.baseAriaLabel = baseLabel;
        cell.setAttribute("aria-label", baseLabel);

        const value = document.createElement("span");
        value.className = "song-cell-value";
        value.textContent = state.value < 0 ? "—" : hex2(state.value);
        const queued = document.createElement("span");
        queued.className = "song-cell-queue";
        queued.setAttribute("aria-hidden", "true");
        cell.append(value, queued);
        line.appendChild(cell);
      }
      fragment.appendChild(line);
    }

    songGrid.replaceChildren(fragment);
    songScroll.scrollTop = previousTop;
    songScroll.scrollLeft = previousLeft;
    const moreRowsButton = $("#songMoreRows");
    moreRowsButton.hidden = rows >= maxRows;
    moreRowsButton.textContent = "SHOW 16 MORE SONG ROWS · " + rows + " / " + maxRows;
    songRendered = true;
    lastPlaybackVisualKey = "";
    updateSongInspector();
    updateSongPlaybackVisuals();
    updateTrackActivity();
  };


  // No browser-owned mixer: every displayed value and edit belongs to
  // native Project, with edits adopted by DSP on its normal snapshot boundary.
  const formatTrackPan = (value) => {
    if (value === 128) return "CENTER";
    if (value < 128) return "L " + Math.round((128 - value) / 128 * 100) + "%";
    return "R " + Math.round((value - 128) / 127 * 100) + "%";
  };

  const updateMixWorkspace = () => {
    if (!window.Module?.ccall || activeUiScreen !== 4) return;
    const count = Math.max(0, Math.min(8, Number(call("webSongTrackCount", "number")) || 0));
    if (mixTrackRows.childElementCount !== count) {
      const fragment = document.createDocumentFragment();
      for (let track = 0; track < count; track++) {
        const row = document.createElement("section");
        row.className = "mix-track-row";
        row.dataset.track = String(track);
        const heading = document.createElement("strong");
        heading.className = "mix-track-heading";
        heading.textContent = "TRACK " + (track + 1);

        const makeControl = (label, cssName, max, initial) => {
          const control = document.createElement("div");
          control.className = "mix-control-row";
          const name = document.createElement("span");
          name.className = "mix-control-label";
          name.textContent = label;
          const slider = document.createElement("input");
          slider.type = "range";
          slider.className = cssName;
          slider.min = "0"; slider.max = String(max); slider.step = "1";
          slider.value = String(initial);
          slider.setAttribute("aria-label", "Track " + (track + 1) + " " + label.toLowerCase());
          const output = document.createElement("output");
          output.className = cssName + "-value";
          control.append(name, slider, output);
          return {control, slider, output};
        };

        const pan = makeControl("PAN", "mix-pan-slider", 255, 128);
        pan.output.textContent = "CENTER";
        const center = document.createElement("button");
        center.type = "button";
        center.className = "mix-pan-center";
        center.textContent = "CENTER";
        center.setAttribute("aria-label", "Center track " + (track + 1));
        const setPan = (value) => {
          const result = call("webMixSetTrackPan", "number", ["number", "number"], [track, value]);
          if (result !== 0) { setStatus("PAN update failed"); return; }
          pan.slider.value = String(value);
          pan.output.textContent = formatTrackPan(value);
        };
        pan.slider.addEventListener("input", () => setPan(Number(pan.slider.value)));
        center.addEventListener("click", () => setPan(128));
        pan.control.appendChild(center);

        const volume = makeControl("VOL", "mix-volume-slider", 100, 100);
        volume.output.textContent = "100%";
        const maxVolume = document.createElement("button");
        maxVolume.type = "button";
        maxVolume.className = "mix-volume-max";
        maxVolume.textContent = "100%";
        maxVolume.setAttribute("aria-label", "Set track " + (track + 1) + " volume to 100 percent");
        const setVolume = (value) => {
          const result = call("webMixSetTrackVolume", "number", ["number", "number"], [track, value]);
          if (result !== 0) { setStatus("VOLUME update failed"); return; }
          volume.slider.value = String(value);
          volume.output.textContent = value + "%";
        };
        volume.slider.addEventListener("input", () => setVolume(Number(volume.slider.value)));
        maxVolume.addEventListener("click", () => setVolume(100));
        volume.control.appendChild(maxVolume);

        row.append(heading, volume.control, pan.control);
        fragment.appendChild(row);
      }
      mixTrackRows.replaceChildren(fragment);
    }
    for (const row of mixTrackRows.children) {
      const track = Number(row.dataset.track);
      const volume = call("webMixTrackVolume", "number", ["number"], [track]);
      if (Number.isInteger(volume) && volume >= 0 && volume <= 100) {
        const slider = row.querySelector(".mix-volume-slider");
        if (document.activeElement !== slider) slider.value = String(volume);
        row.querySelector(".mix-volume-slider-value").textContent = volume + "%";
      }
      const pan = call("webMixTrackPan", "number", ["number"], [track]);
      if (Number.isInteger(pan) && pan >= 0 && pan <= 255) {
        const slider = row.querySelector(".mix-pan-slider");
        if (document.activeElement !== slider) slider.value = String(pan);
        row.querySelector(".mix-pan-slider-value").textContent = formatTrackPan(pan);
      }
    }
  };

  const setWorkspaceMode = (screen, syncNative = false) => {
    activeUiScreen = screen;
    $$(".view-tabs [data-screen]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.screen) === screen);
    });
    $("#screenName").textContent = screenNames[screen] || "TRACKER";
    $("#workspaceEyebrow").textContent = screenEyebrows[screen] || "WORKSPACE";

    const semantic = screen === 0 || (screen === 4 && !nativeMixerExpanded);
    semanticWorkspace.hidden = !semantic;
    legacyWorkspace.hidden = semantic;
    songWorkspace.hidden = screen !== 0;
    mixWorkspace.hidden = screen !== 4 || nativeMixerExpanded;
    $("#mixReturnDirect").hidden = screen !== 4 || !nativeMixerExpanded;
    $("#gestureHint").textContent = screen === 0
      ? "CLICK A CELL · EDIT IN THE INSPECTOR · DOUBLE CLICK TO OPEN"
      : screen === 4 && !nativeMixerExpanded ? "DRAG VOL / PAN · TAP BUTTONS TO RESET"
      : screen === 4 ? "FULL NATIVE MIXER · DIRECT MIX TO RETURN"
      : "DIRECT WEB WORKSPACE COMING NEXT · LEGACY VIEW FOR NOW";

    if (screen === 0) {
      if (!songRendered) renderSongWorkspace();
    } else if (screen === 4 && !nativeMixerExpanded) {
      updateMixWorkspace();
    } else if (syncNative) {
      requestAnimationFrame(() => canvas.focus());
    }
  };

  function navigateToScreen(screen) {
    const result = call("webOpenScreen", "number", ["number"], [screen]);
    if (result !== 0) {
      if (screen === 1) setStatus("Choose a non-empty Song cell before opening Chain");
      else if (screen === 2) setStatus("Choose a Chain row with a Phrase before opening Phrase");
      else setStatus("This workspace is not available in the current context");
      return false;
    }

    nativeMixerExpanded = false;
    setWorkspaceMode(screen, true);
    if (screen === 0) {
      songRendered = false;
      requestAnimationFrame(renderSongWorkspace);
    }
    setTimeout(refreshScreenState, 80);
    return true;
  }

  songGrid.addEventListener("click", (event) => {
    const cell = event.target.closest(".song-cell");
    if (!cell) return;
    const row = Number(cell.dataset.songRow);
    const track = Number(cell.dataset.songTrack);
    const wasSelected = row === songSelection.row && track === songSelection.track;
    selectSongCell(row, track);

    const coarsePointer = matchMedia("(pointer: coarse)").matches;
    const now = performance.now();
    const repeatedTap = songLastTap.row === row && songLastTap.track === track && now - songLastTap.time < 520;
    songLastTap = { row, track, time: now };
    if ((coarsePointer && wasSelected && repeatedTap) || event.detail >= 2) openSongDialog();
  });

  songGrid.addEventListener("dblclick", (event) => {
    const cell = event.target.closest(".song-cell");
    if (!cell) return;
    selectSongCell(Number(cell.dataset.songRow), Number(cell.dataset.songTrack));
    openSongDialog();
  });

  songGrid.addEventListener("keydown", (event) => {
    const cell = event.target.closest(".song-cell");
    if (!cell) return;
    let row = Number(cell.dataset.songRow);
    let track = Number(cell.dataset.songTrack);
    const tracks = Math.max(1, call("webSongTrackCount", "number") || 1);
    if (event.key === "ArrowUp") row--;
    else if (event.key === "ArrowDown") row++;
    else if (event.key === "ArrowLeft") track--;
    else if (event.key === "ArrowRight") track++;
    else if (event.key === "Enter") {
      event.preventDefault();
      openSongDialog();
      return;
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setSongValue(row, track, -1);
      return;
    } else return;

    event.preventDefault();
    row = Math.max(0, Math.min((call("webSongRowCount", "number") || 256) - 1, row));
    track = Math.max(0, Math.min(tracks - 1, track));
    selectSongCell(row, track, true);
    songGrid.querySelector(`[data-song-row="${row}"][data-song-track="${track}"]`)?.focus();
  });

  $("#songEditSelected").addEventListener("click", openSongDialog);

  $("#songMoreRows").addEventListener("click", () => {
    const firstNewRow = songGrid.querySelectorAll(".song-grid-row").length;
    const maxRows = Math.max(1, call("webSongRowCount", "number") || 256);
    songMinimumRows = Math.min(maxRows, Math.max(songMinimumRows, firstNewRow) + 16);
    songRendered = false;
    renderSongWorkspace();
    songGrid.querySelector('[data-song-row="' + firstNewRow + '"]')?.scrollIntoView({
      block: "center", inline: "nearest"
    });
  });

  $("#songJumpCursor").addEventListener("click", () => {
    const row = Math.max(0, call("webSongCursorRow", "number") || 0);
    const track = Math.max(0, call("webSongCursorTrack", "number") || 0);
    selectSongCell(row, track, true);
  });

  $("#songCellDialogClose").addEventListener("click", () => $("#songCellDialog").close());

  $("#chainPickerClose").addEventListener("click", () => chainPickerDialog.close());
  chainPickerSearch.addEventListener("input", renderChainPicker);
  chainPickerList.addEventListener("click", (event) => {
    const item = event.target.closest(".chain-picker-item");
    if (!item) return;
    if (setSongValue(songSelection.row, songSelection.track, Number(item.dataset.chainValue))) {
      chainPickerDialog.close();
    }
  });
  $("#chainPickerClear").addEventListener("click", () => {
    if (setSongValue(songSelection.row, songSelection.track, -1)) chainPickerDialog.close();
  });
  $("#chainPickerNew").addEventListener("click", () => {
    const chain = call("webSongFindFreeChain", "number");
    if (chain == null || chain < 0) {
      setStatus("No free Chain slots");
      return;
    }
    if (setSongValue(songSelection.row, songSelection.track, chain, false)) {
      chainPickerDialog.close();
      setStatus("Free Chain " + hex2(chain) + " assigned");
    }
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (!trackerStarted || !window.Module?.ccall) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const p = canvasPoint(event);
    pointer = { id: event.pointerId, startX: p.x, startY: p.y, lastX: p.x, moved: false };
    selectAt(p);
    refreshScreenState();
    canvas.focus();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const p = canvasPoint(event);
    const step = 34;
    const delta = p.x - pointer.lastX;
    if (Math.abs(delta) < step) return;
    const steps = Math.floor(Math.abs(delta) / step);
    for (let i = 0; i < steps; i++) {
      call("webTouchAdjustAt", null, ["number", "number", "number"],
        [pointer.startX, pointer.startY, delta > 0 ? 1 : -1]);
    }
    pointer.lastX += (delta > 0 ? 1 : -1) * step * steps;
    pointer.moved = true;
  });

  canvas.addEventListener("pointerup", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    const p = canvasPoint(event);
    if (!pointer.moved) {
      const now = performance.now();
      const near = Math.abs(lastTap.x - p.x) < 24 && Math.abs(lastTap.y - p.y) < 24;
      if (near && now - lastTap.time < 360) {
        editCurrent();
        lastTap.time = 0;
      } else {
        lastTap = { time: now, x: p.x, y: p.y };
      }
    }
    pointer = null;
  });
  canvas.addEventListener("pointercancel", () => { pointer = null; });

  const updateMasterMeters = () => {
    if (!window.Module?.ccall) return;
    const packed = call("webOutputStereoPeaksPacked", "number");
    if (packed == null) return;
    const levels = [(packed & 4095) / 4095, ((packed >> 12) & 4095) / 4095];
    for (let index = 0; index < 2; ++index) {
      const level = levels[index];
      // UI-only visual decay, never an alternative source of audio state.
      const db = level > 0 ? Math.max(-60, Math.min(0, 20 * Math.log10(level))) : -60;
      const normalized = Math.max(0, (db + 60) / 60);
      masterDisplayed[index] = Math.max(normalized, masterDisplayed[index] * 0.72);
      masterMeterFills[index].style.transform = "scaleX(" + masterDisplayed[index].toFixed(3) + ")";
      masterMeterChannels[index].setAttribute("aria-valuenow", String(Math.round(db)));
      masterMeterChannels[index].setAttribute("aria-valuetext", Math.round(db) + " dBFS peak");
    }
  };

  const activityContainers = [$("#songActivityRows"), $("#songActivityMobileRows")];
  const monitorPianos = [$("#songActivityPiano"), $("#songActivityMobilePiano")];
  const pitchClasses = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const whitePitches = [0, 2, 4, 5, 7, 9, 11];
  const blackPitches = [1, 3, 6, 8, 10];
  const blackBoundaries = [1, 2, 4, 5, 6];
  const initializePianoKeys = () => {
    for (const piano of monitorPianos) {
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < whitePitches.length; ++i) {
        const key = document.createElement("span");
        key.className = "monitor-key white";
        key.dataset.pitch = String(whitePitches[i]);
        key.style.left = (100 * i / 7) + "%";
        fragment.appendChild(key);
      }
      for (let i = 0; i < blackPitches.length; ++i) {
        const key = document.createElement("span");
        key.className = "monitor-key black";
        key.dataset.pitch = String(blackPitches[i]);
        key.style.left = "calc(" + (100 * blackBoundaries[i] / 7) + "% - 4.5%)";
        fragment.appendChild(key);
      }
      piano.replaceChildren(fragment);
    }
  };
  initializePianoKeys();
  let lastPianoMask = -1;
  const updateMonitorPiano = () => {
    const mask = call("webMonitorPianoNotes", "number");
    if (mask == null || mask === lastPianoMask) return;
    lastPianoMask = mask;
    const active = pitchClasses.filter((_, pitch) => mask & (1 << pitch));
    for (const piano of monitorPianos) {
      for (const key of piano.children) {
        const pitch = Number(key.dataset.pitch);
        key.classList.toggle("active", !!(mask & (1 << pitch)));
      }
      piano.setAttribute("aria-label", active.length ?
        "Playing pitch classes: " + active.join(", ") : "No notes playing");
      piano.dataset.activeMask = String(mask);
    }
  };
  const applyTrackMode = (track, mode) => {
    const exportName = mode === "mute" ? "webSongToggleTrackMute" : "webSongToggleTrackSolo";
    const value = call(exportName, "number", ["number"], [track]);
    if (value == null || value < 0) return;
    setStatus("Track " + (track + 1) + (value === 2 ? " muted" : value === 1 ? " solo" : " normal"));
    updateTrackActivity();
  };
  let activityTrackCount = -1;
  const ensureTrackActivity = () => {
    if (!window.Module?.ccall) return;
    const count = Math.max(0, call("webSongTrackCount", "number") || 0);
    if (count === activityTrackCount) return;
    activityTrackCount = count;
    for (const container of activityContainers) {
      const fragment = document.createDocumentFragment();
      for (let track = 0; track < count; track++) {
        const row = document.createElement("div");
        row.className = "track-activity-row";
        row.dataset.track = String(track);
        row.innerHTML = '<span class="track-activity-index"></span>' +
          '<span class="track-activity-actions">' +
          '<button type="button" class="track-mute" aria-pressed="false">M</button>' +
          '<button type="button" class="track-solo" aria-pressed="false">S</button></span>' +
          '<canvas class="track-activity-wave" role="img"></canvas>' +
          '<span class="track-activity-note"></span>' +
          '<span class="track-activity-warning"></span>';
        for (const mode of ["mute", "solo"]) {
          const button = row.querySelector(".track-" + mode);
          button.setAttribute("aria-label", (mode === "mute" ? "Mute" : "Solo") +
            " track " + (track + 1));
          button.addEventListener("click", () => applyTrackMode(track, mode));
        }
        row.querySelector(".track-activity-index").textContent = String(track + 1);
        const scope = row.querySelector("canvas");
        scope.width = 256;
        scope.height = 48;
        scope.setAttribute("aria-label", "Waveform of track " + (track + 1));
        fragment.appendChild(row);
      }
      container.replaceChildren(fragment);
    }
  };
  // The scope shows SHAPE, not loudness. Signed 16-bit native PCM retains
  // quiet samples that 8-bit transport previously collapsed into a flat line.
  const TRACK_SCOPE_SAMPLES = 256;
  const trackScopeStates = [];
  const readTrackScope = (track, hex) => {
    if (!hex || hex.length !== TRACK_SCOPE_SAMPLES * 4) return null;
    const scope = trackScopeStates[track] || (trackScopeStates[track] = {
      samples: new Float32Array(TRACK_SCOPE_SAMPLES), gain: 0
    });
    let peak = 0, energy = 0;
    for (let i = 0; i < TRACK_SCOPE_SAMPLES; ++i) {
      const encoded = Number.parseInt(hex.slice(i * 4, i * 4 + 4), 16);
      if (!Number.isFinite(encoded)) return null;
      const sample = (encoded >= 32768 ? encoded - 65536 : encoded) / 32768;
      scope.samples[i] = sample;
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / TRACK_SCOPE_SAMPLES);
    // Gate quantization residue (~-78 dBFS peak / -84 dBFS RMS).
    // No input means a flat reference line, never manufactured waves.
    if (peak < 4 / 32768 || rms < 2 / 32768) {
      scope.gain = 0;
      return scope;
    }
    const targetGain = 0.86 / peak;
    // Quick attenuation at attacks, slower recovery as a note gets quieter.
    scope.gain = scope.gain === 0 || targetGain < scope.gain ?
      targetGain : scope.gain + (targetGain - scope.gain) * 0.4;
    return scope;
  };
  const drawTrackScope = (canvas, scope, muted) => {
    if (!scope) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(94, 215, 255, .17)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    if (!scope.gain) return;
    ctx.strokeStyle = muted ? "#6e7d8b" : "#5ed7ff";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < TRACK_SCOPE_SAMPLES; ++i) {
      const x = i * (width - 1) / (TRACK_SCOPE_SAMPLES - 1);
      const normalized = Math.max(-0.94, Math.min(0.94, scope.samples[i] * scope.gain));
      const y = (1 - normalized) * (height - 1) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  const updateTrackScopes = () => {
    if (!window.Module?.ccall || document.hidden || activityTrackCount < 1) return;
    for (let track = 0; track < activityTrackCount; ++track) {
      const hex = call("webTrackAudioScopeHex", "string", ["number"], [track]);
      const scope = readTrackScope(track, hex);
      if (!scope) continue;
      for (const container of activityContainers) {
        if (container === activityContainers[1] && !$("#songActivityMobile").open) continue;
        const row = container.children[track];
        if (row) drawTrackScope(row.querySelector(".track-activity-wave"), scope,
          row.classList.contains("muted"));
      }
    }
  };
  // Bound native telemetry reads to 30Hz, painting on the next display
  // frame. No recursive rAF loop (also safe for synchronous test shims).
  let scopeFramePending = false;
  const scheduleTrackScope = () => {
    if (scopeFramePending || document.hidden) return;
    scopeFramePending = true;
    requestAnimationFrame(() => {
      scopeFramePending = false;
      try { updateTrackScopes(); }
      catch (error) { console.error("Track scope refresh failed", error); }
    });
  };
  const updateTrackActivity = () => {
    if (!window.Module?.ccall) return;
    ensureTrackActivity();
    updateMonitorPiano();
    if (songRendered) {
      for (let track = 0; track < activityTrackCount; ++track) {
        const state = call("webTrackActivityPacked", "number", ["number"], [track]);
        const head = songGrid.querySelector('.song-track-mode[data-track="' + track + '"]');
        if (!head || state == null || state < 0) continue;
        const mode = (state >> 8) & 3;
        head.textContent = mode === 2 ? "MUTED" : mode === 1 ? "SOLO" : "";
        head.classList.toggle("muted", mode === 2);
        head.classList.toggle("solo", mode === 1);
      }
    }
    for (let track = 0; track < activityTrackCount; ++track) {
      const packed = call("webTrackActivityPacked", "number", ["number"], [track]);
      if (packed < 0) continue;
      const muted = ((packed >> 8) & 3) === 2;
      const solo = ((packed >> 8) & 3) === 1;
      const clipped = !!(packed & (1 << 10));
      const warning = !!(packed & (1 << 11));
      const note = call("webTrackActivityNote", "string", ["number"], [track]) || "---";
      for (const container of activityContainers) {
        if (container === activityContainers[1] && !$("#songActivityMobile").open) continue;
        const row = container.children[track];
        if (!row) continue;
        row.classList.toggle("muted", muted);
        row.classList.toggle("clipping", clipped);
        row.classList.toggle("selected", !!(packed & (1 << 12)));
        row.classList.toggle("note-warning", warning);
        row.querySelector(".track-mute").setAttribute("aria-pressed", String(muted));
        row.querySelector(".track-solo").setAttribute("aria-pressed", String(solo));
        row.querySelector(".track-activity-note").textContent = note;
        row.querySelector(".track-activity-warning").textContent = clipped ? "CLIP" : warning ? "!" : "";
        row.setAttribute("aria-label", "Track " + (track + 1) +
          (muted ? ", muted" : solo ? ", solo" : "") +
          ", note " + note + (clipped ? ", clipping" : warning ? ", pitch warning" : ""));
      }
    }
  };

  const decodePlaybackTrack = (packed) => ({
    songRow: (packed & 0x1ff) ? (packed & 0x1ff) - 1 : -1,
    chainRow: ((packed >> 9) & 0x1f) ? ((packed >> 9) & 0x1f) - 1 : -1,
    phraseRow: ((packed >> 14) & 0x1f) ? ((packed >> 14) & 0x1f) - 1 : -1,
    mode: (packed >> 19) & 0x1f,
  });

  const readLiveQueue = (packed) => ({
    row: (packed & 0x1ff) ? (packed & 0x1ff) - 1 : -1,
    action: (packed >> 9) & 7,
  });

  const updateSongPlaybackVisuals = () => {
    if (!window.Module?.ccall || activeUiScreen !== 0 || !songRendered) return;

    const playing = !!call("webPlaybackIsPlaying", "number");
    const tracks = Math.max(1, call("webSongTrackCount", "number") || 1);
    const rows = [];
    const snapshot = [playing ? 1 : 0];

    for (let track = 0; track < tracks; track++) {
      const packed = call("webPlaybackTrackPacked", "number", ["number"], [track]) || 0;
      const state = decodePlaybackTrack(packed);
      rows.push(state.songRow);
      snapshot.push(packed);
      snapshot.push(call("webSongLiveQueuePacked", "number", ["number"], [track]) || 0);
    }

    const key = snapshot.join(",");
    if (key === lastPlaybackVisualKey) return;
    lastPlaybackVisualKey = key;

    songGrid.querySelectorAll(".song-cell.playing").forEach((cell) => cell.classList.remove("playing"));
    songGrid.querySelectorAll(".song-grid-row.playing-row").forEach((row) => row.classList.remove("playing-row"));
    songGrid.querySelectorAll(".song-cell.queued-live").forEach((cell) => {
      cell.classList.remove("queued-live", "queued-stop", "queued-urgent");
      cell.querySelector(".song-cell-queue").textContent = "";
      cell.setAttribute("aria-label", cell.dataset.baseAriaLabel);
    });

    for (let track = 0; track < tracks; ++track) {
      const { row, action } = readLiveQueue(snapshot[2 + track * 2]);
      if (row < 0 || action === 0) continue;
      const cell = songGrid.querySelector('[data-song-row="' + row + '"][data-song-track="' + track + '"]');
      if (!cell) continue;
      const stop = action === 3 || action === 4;
      const urgent = action === 2 || action === 4;
      cell.classList.add("queued-live");
      cell.classList.toggle("queued-stop", stop);
      cell.classList.toggle("queued-urgent", urgent);
      cell.querySelector(".song-cell-queue").textContent = stop ? "−" : urgent ? "!" : "+";
      const queueName = stop ? (urgent ? "urgent stop queued" : "stop queued") :
        (urgent ? "urgent chain launch queued" : "chain launch queued");
      cell.setAttribute("aria-label", cell.dataset.baseAriaLabel + ", " + queueName);
    }

    if (!playing) return;

    const playingRows = new Set();
    rows.forEach((row, track) => {
      if (row < 0) return;
      const cell = songGrid.querySelector('[data-song-row="' + row + '"][data-song-track="' + track + '"]');
      if (!cell) return;
      cell.classList.add("playing");
      playingRows.add(row);
    });
    for (const row of playingRows) {
      songGrid.querySelector('[data-song-row="' + row + '"]')?.closest(".song-grid-row")?.classList.add("playing-row");
    }
  };

  const refreshScreenState = () => {
    if (!window.Module?.ccall) return;
    const current = call("webCurrentScreen", "number");
    if (current >= 0 && current !== activeUiScreen) setWorkspaceMode(current);

    let editLabel = "EDIT";
    if (current === 2) {
      const column = call("webPhraseCursorColumn", "number");
      if (column === 0) editLabel = "NOTE";
      else if (column === 1) editLabel = "INSTRUMENT";
      else if (column === 2) editLabel = "VOLUME";
      else if (column === 3 || column === 5 || column === 7) editLabel = "FX";
      else if (column === 4 || column === 6 || column === 8) editLabel = "VALUE";
    }
    $("#editAction").textContent = editLabel;

    const playing = !!call("webPlaybackIsPlaying", "number");
    $("#playToggle").setAttribute("aria-pressed", playing ? "true" : "false");
    $("#playToggle").textContent = playing ? "❚❚ PLAYING" : "▶ PLAY";
    updateSongPlaybackVisuals();
    updateMixWorkspace();
  };

  $("#mixOpenNative").addEventListener("click", () => {
    nativeMixerExpanded = true;
    setWorkspaceMode(4, true);
  });
  $("#mixReturnDirect").addEventListener("click", () => {
    nativeMixerExpanded = false;
    setWorkspaceMode(4, true);
  });

  $(".view-tabs [data-screen], .utility-buttons [data-screen]").forEach((button) => {
    button.addEventListener("click", () => navigateToScreen(Number(button.dataset.screen)));
  });

  $("#playToggle").addEventListener("click", () => {
    call("webSemanticAction", null, ["number"], [0]);
    setTimeout(refreshScreenState, 20);
  });
  $("#stopButton").addEventListener("click", () => {
    call("webStopPlayback");
    setTimeout(refreshScreenState, 20);
  });
  $("#editAction").addEventListener("click", editCurrent);
  $("#backAction").addEventListener("click", () => call("webSemanticAction", null, ["number"], [2]));
  $("#clearAction").addEventListener("click", () => call("webSemanticAction", null, ["number"], [3]));

  $("#noteDialog").addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-value]");
    if (!button) return;
    setPhraseNote(Number(button.dataset.noteValue));
  });
  $("#noteClose").addEventListener("click", () => {
    $("#noteDialog").close();
    canvas.focus();
  });

  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  $("#helpClose").addEventListener("click", () => $("#helpDialog").close());

  const closeMobileMenu = () => {
    const dialog = $("#mobileMenuDialog");
    if (dialog?.open) dialog.close();
  };

  const downloadProject = () => {
    const path = "/user/exports/wroomwroomtracker.cct";
    if (call("webSaveProject", "number", ["string"], [path]) !== 0) {
      setStatus("Could not save the current project");
      return;
    }
    window.choochooDownloadFile(path);
    setStatus("Project downloaded");
  };

  $$("[data-file-action]").forEach((button) => {
    button.addEventListener("click", () => {
      closeMobileMenu();
      switch (button.dataset.fileAction) {
        case "open-project": $("#projectInput").click(); break;
        case "download-project": downloadProject(); break;
        case "add-samples": $("#sampleInput").click(); break;
        case "add-folder": $("#sampleFolderInput").click(); break;
      }
    });
  });

  $("#mobileMenuButton").addEventListener("click", () => $("#mobileMenuDialog").showModal());
  $("#mobileMenuClose").addEventListener("click", closeMobileMenu);
  $$("[data-menu-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      closeMobileMenu();
      navigateToScreen(Number(button.dataset.menuScreen));
    });
  });

  $("#projectInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const path = "/user/projects/" + userPath(file.name);
    await importFiles([file], "/user/projects");
    const result = call("webLoadProject", "number", ["string"], [path]);
    if (result === 0) {
      songRendered = false;
      if (activeUiScreen === 0) renderSongWorkspace();
    }
    setStatus(result === 0 ? "Loaded " + file.name : "Could not load " + file.name);
    event.target.value = "";
  });

  const importSamples = async (event) => {
    if (event.target.files.length) await importFiles(event.target.files, "/user/samples");
    event.target.value = "";
  };
  $("#sampleInput").addEventListener("change", importSamples);
  $("#sampleFolderInput").addEventListener("change", importSamples);

  const loadTracker = () => {
    if (trackerStarted) return;
    trackerStarted = true;
    startButton.disabled = true;
    startButton.textContent = "STARTING…";
    setStatus("Loading audio engine");

    document.title = "WroomWroomTracker — Web";
    window.Module = window.Module || {};
    const buildId = encodeURIComponent(String(window.WROOM_BUILD || "dev"));
    window.Module.locateFile = (asset, prefix = "") => {
      const url = prefix + asset;
      return url + (url.includes("?") ? "&" : "?") + "v=" + buildId;
    };
    window.Module.canvas = canvas;
    window.Module.setStatus = (message) => {
      if (!message) return;
      setStatus(message);
      const match = message.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
      if (match) {
        const loaded = Number(match[1]);
        const total = Number(match[2]);
        const percent = total > 0 ? Math.min(99, Math.round(loaded * 100 / total)) : 0;
        startButton.textContent = "LOADING " + percent + "%";
      } else if (/download|prepare|compile|instantiate/i.test(message)) {
        startButton.textContent = "LOADING…";
      }
    };
    window.Module.monitorRunDependencies = (left) => {
      if (left > 0 && startButton.textContent === "STARTING…") {
        startButton.textContent = "LOADING…";
      }
    };

    window.Module.onAbort = () => {
      trackerStarted = false;
      setStatus("Tracker startup failed");
      startButton.disabled = false;
      startButton.textContent = "RETRY";
    };

    let startupFinished = false;
    window.wroomStartupStage = (stage) => {
      const label = String(stage || "STARTING");
      startButton.textContent = label;
      setStatus("Starting · " + label);
    };

    window.wroomRuntimeReady = () => {
      if (startupFinished) return;
      startupFinished = true;

      // This callback is invoked synchronously from C++ via EM_ASM while
      // appSetup() is still on the WASM stack. Do not ccall back into WASM
      // here: that re-entrant call can abort before the splash is hidden.
      fileButtons.forEach((button) => { button.disabled = false; });
      startOverlay.hidden = true;
      startOverlay.style.display = "none";
      startOverlay.setAttribute("aria-hidden", "true");
      setStatus("READY · tap a cell · drag horizontally to change it");

      requestAnimationFrame(() => {
        try {
          setWorkspaceMode(0);
          songRendered = false;
          renderSongWorkspace();
          refreshScreenState();
        } catch (error) {
          console.error("Post-start UI refresh failed", error);
          setStatus("READY · UI refresh warning");
        }

        setInterval(() => {
          try {
            refreshScreenState();
            syncUserStorage();
          } catch (error) {
            console.error("Periodic UI refresh failed", error);
          }
        }, 1200);

        // Master output peak data is read once per bounded UI tick, regardless
        // of which tracker workspace is open.
        setInterval(() => {
          try { updateMasterMeters(); }
          catch (error) { console.error("Master metering failed", error); }
        }, 100);

        // Original cross-screen tracker strip is drawn by the legacy canvas.
        // Semantic Song mirrors the exact native waveform/notes in its inspector.
        setInterval(() => {
          try { updateTrackActivity(); }
          catch (error) { console.error("Track activity refresh failed", error); }
        }, 80);
        setInterval(scheduleTrackScope, 33);

        // Playback visualization is intentionally bounded and reads one compact
        // snapshot per track. It only toggles DOM classes when engine state
        // changes; it never rebuilds the Song grid on a playback tick.
        setInterval(() => {
          try {
            updateSongPlaybackVisuals();
          } catch (error) {
            console.error("Playback UI refresh failed", error);
          }
        }, 50);

        if (!localStorage.getItem("wroomwroom-web-seen")) {
          localStorage.setItem("wroomwroom-web-seen", "1");
          setTimeout(() => $("#helpDialog").showModal(), 450);
        }
      });
    };

    window.Module.onRuntimeInitialized = () => {
      startButton.textContent = "OPENING…";
      setStatus("Initializing tracker…");
      initUserStorage();
    };

    const script = document.createElement("script");
    script.src = "./choochootracker.js?v=" + buildId;
    script.onerror = () => {
      trackerStarted = false;
      setStatus("WebAssembly bundle could not be loaded");
      startButton.disabled = false;
      startButton.textContent = "RETRY";
    };
    document.body.appendChild(script);
  };

  // index.html owns the tiny START bootstrap so a failure elsewhere in this
  // shell cannot leave the primary button completely inert.
  window.wroomStartTracker = loadTracker;
  if (window.__wroomStartRequested) {
    window.__wroomStartRequested = false;
    loadTracker();
  }

  window.addEventListener("pagehide", () => syncUserStorage());
})();
