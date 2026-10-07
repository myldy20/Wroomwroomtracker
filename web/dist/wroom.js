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
    if (!fs || storageSyncing) return;
    storageSyncing = true;
    fs.syncfs(false, (error) => {
      storageSyncing = false;
      if (error) setStatus("Browser storage could not be saved");
      done?.(error);
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
  const editCurrent = () => call("webSemanticAction", null, ["number"], [1]);

  canvas.addEventListener("pointerdown", (event) => {
    if (!trackerStarted || !window.Module?.ccall) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const p = canvasPoint(event);
    pointer = { id: event.pointerId, startX: p.x, startY: p.y, lastX: p.x, moved: false };
    selectAt(p);
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

  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  $("#helpClose").addEventListener("click", () => $("#helpDialog").close());

  $("#importProject").addEventListener("click", () => $("#projectInput").click());
  $("#importSamples").addEventListener("click", () => $("#sampleInput").click());
  $("#importFolder").addEventListener("click", () => $("#sampleFolderInput").click());
  $("#saveProject").addEventListener("click", () => {
    const path = "/user/exports/wroomwroomtracker.cct";
    if (call("webSaveProject", "number", ["string"], [path]) !== 0) {
      setStatus("Could not save the current project");
      return;
    }
    window.choochooDownloadFile(path);
    setStatus("Project downloaded");
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

    window.Module = window.Module || {};
    window.Module.canvas = canvas;
    window.Module.preRun = (window.Module.preRun || []).concat(() => {
      try { FS.mkdir("/user"); } catch (_) {}
      FS.mount(IDBFS, {}, "/user");
      addRunDependency("wroomwroom-user-storage");
      FS.syncfs(true, (error) => {
        if (error) setStatus("Browser storage could not be opened");
        ensureUserDirectories(FS);
        FS.syncfs(false, (saveError) => {
          if (saveError) setStatus("Browser storage could not be initialized");
          removeRunDependency("wroomwroom-user-storage");
        });
      });
    });

    window.Module.onAbort = () => {
      trackerStarted = false;
      setStatus("Tracker startup failed");
      startButton.disabled = false;
      startButton.textContent = "RETRY";
    };

    window.Module.onRuntimeInitialized = () => {
      fileButtons.forEach((button) => { button.disabled = false; });
      startOverlay.hidden = true;
      canvas.focus();
      setStatus("Starting tracker UI…");

      // Runtime init can fire before Emscripten invokes main(). Give appSetup()
      // a moment to create project/screen state before entering the web Song
      // workspace.
      setTimeout(() => {
        call("webOpenScreen", null, ["number"], [0]);
        refreshScreenState();
        setStatus("READY · tap a cell · drag horizontally to change it");
      }, 120);

      setInterval(() => {
        refreshScreenState();
        syncUserStorage();
      }, 1200);
      if (!localStorage.getItem("wroomwroom-web-seen")) {
        localStorage.setItem("wroomwroom-web-seen", "1");
        setTimeout(() => $("#helpDialog").showModal(), 650);
      }
    };

    const script = document.createElement("script");
    script.src = "./choochootracker.js";
    script.onerror = () => {
      setStatus("WebAssembly bundle not found");
      startButton.disabled = false;
      startButton.textContent = "RETRY";
    };
    document.body.appendChild(script);
  };

  startButton.addEventListener("click", loadTracker);
  window.addEventListener("pagehide", () => syncUserStorage());
})();
