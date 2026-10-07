(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const canvas = $("#canvas");
  const status = $("#status");
  const startOverlay = $("#startOverlay");
  const startButton = $("#startButton");
  const fileButtons = $("[data-needs-runtime]");
  const semanticWorkspace = $("#semanticWorkspace");
  const legacyWorkspace = $("#legacyWorkspace");
  const songGrid = $("#songGrid");
  const songScroll = $("#songScroll");
  let trackerStarted = false;
  let activeUiScreen = 0;
  let songRendered = false;
  let songSelection = { row: 0, track: 0 };
  let songLastTap = { row: -1, track: -1, time: 0 };
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
    publishProjectEdit();
    songRendered = false;
    renderSongWorkspace();
    if (announce) setStatus(normalized < 0 ? "Song cell cleared" : "Chain " + hex2(normalized) + " assigned");
    return true;
  };

  const selectSongCell = (row, track, scroll = false) => {
    if (call("webSongSelect", "number", ["number", "number"], [row, track]) !== 0) return;
    songSelection = { row, track };
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
    input.setAttribute("aria-label", "Chain number");
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    control.append(minus, input, plus);
    root.appendChild(control);

    const actions = document.createElement("div");
    actions.className = dialogMode ? "song-cell-actions" : "inspector-actions";
    const empty = document.createElement("button");
    empty.type = "button";
    empty.textContent = "EMPTY";
    const highlight = document.createElement("button");
    highlight.type = "button";
    highlight.textContent = state.highlighted ? "UNHIGHLIGHT" : "HIGHLIGHT";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "primary";
    open.textContent = "OPEN CHAIN";
    actions.append(empty, highlight, open);
    root.appendChild(actions);

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
    const rows = Math.min(maxRows, Math.max(32, lastUsed + 10, cursorRow + 6));
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
      head.innerHTML = "<strong>TRACK " + (track + 1) + "</strong><span>CHAIN</span>";
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
        if (state.hasNotes) cell.classList.add("has-notes");
        if (state.highlighted) cell.classList.add("highlighted");
        if (row === songSelection.row && track === songSelection.track) cell.classList.add("selected");
        cell.dataset.songRow = String(row);
        cell.dataset.songTrack = String(track);
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-label",
          "Row " + hex2(row) + ", track " + (track + 1) + ", " +
          (state.value < 0 ? "empty" : "chain " + hex2(state.value)));

        const value = document.createElement("span");
        value.className = "song-cell-value";
        value.textContent = state.value < 0 ? "—" : hex2(state.value);
        const meta = document.createElement("span");
        meta.className = "song-cell-meta";
        meta.textContent = state.value < 0 ? "EMPTY" : state.hasNotes ? "CHAIN" : "EMPTY CHAIN";
        cell.append(value, meta);
        line.appendChild(cell);
      }
      fragment.appendChild(line);
    }

    songGrid.replaceChildren(fragment);
    songScroll.scrollTop = previousTop;
    songScroll.scrollLeft = previousLeft;
    songRendered = true;
    updateSongInspector();
  };

  const setWorkspaceMode = (screen, syncNative = false) => {
    activeUiScreen = screen;
    $(".view-tabs [data-screen]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.screen) === screen);
    });
    $("#screenName").textContent = screenNames[screen] || "TRACKER";
    $("#workspaceEyebrow").textContent = screenEyebrows[screen] || "WORKSPACE";

    const semantic = screen === 0;
    semanticWorkspace.hidden = !semantic;
    legacyWorkspace.hidden = semantic;
    $("#gestureHint").textContent = semantic
      ? "CLICK A CELL · EDIT IN THE INSPECTOR · DOUBLE CLICK TO OPEN"
      : "DIRECT WEB WORKSPACE COMING NEXT · LEGACY VIEW FOR NOW";

    if (semantic) {
      if (!songRendered) renderSongWorkspace();
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

  $("#songJumpCursor").addEventListener("click", () => {
    const row = Math.max(0, call("webSongCursorRow", "number") || 0);
    const track = Math.max(0, call("webSongCursorTrack", "number") || 0);
    selectSongCell(row, track, true);
  });

  $("#songCellDialogClose").addEventListener("click", () => $("#songCellDialog").close());

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
  };

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
  $("[data-menu-screen]").forEach((button) => {
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
