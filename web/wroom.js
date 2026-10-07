(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const canvas = $("#canvas");
  const status = $("#status");
  const startOverlay = $("#startOverlay");
  const startButton = $("#startButton");
  const fileButtons = $$("[data-needs-runtime]");
  let trackerStarted = false;
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

  const screenNames = ["SONG", "CHAIN", "PHRASE", "SOUND", "MIX", "PROJECT", "SETTINGS", "START"];
  const refreshScreenState = () => {
    if (!window.Module?.ccall) return;
    const current = call("webCurrentScreen", "number");
    $$(".view-tabs [data-screen]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.screen) === current);
    });
    $("#screenName").textContent = screenNames[current] || "TRACKER";

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

  $$(".view-tabs [data-screen], .utility-buttons [data-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      call("webOpenScreen", null, ["number"], [Number(button.dataset.screen)]);
      refreshScreenState();
      canvas.focus();
    });
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
      call("webOpenScreen", null, ["number"], [Number(button.dataset.menuScreen)]);
      closeMobileMenu();
      refreshScreenState();
      canvas.focus();
    });
  });

  $("#projectInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const path = "/user/projects/" + userPath(file.name);
    await importFiles([file], "/user/projects");
    const result = call("webLoadProject", "number", ["string"], [path]);
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
          refreshScreenState();
          canvas.focus();
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
    script.src = "./choochootracker.js";
    script.onerror = () => {
      trackerStarted = false;
      setStatus("WebAssembly bundle could not be loaded");
      startButton.disabled = false;
      startButton.textContent = "RETRY";
    };
    document.body.appendChild(script);
  };

  startButton.addEventListener("click", loadTracker);
  window.addEventListener("pagehide", () => syncUserStorage());
})();
