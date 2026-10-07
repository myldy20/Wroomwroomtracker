import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const html = fs.readFileSync("web/index.html", "utf8");
const shell = fs.readFileSync("web/wroom.js", "utf8");

const bootstrapMatch = html.match(/<script id="wroom-bootstrap">([\s\S]*?)<\/script>/);
assert.ok(bootstrapMatch, "inline Start bootstrap must exist");

class MockElement {
  constructor(name = "") {
    this.name = name;
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.style = {};
    this.dataset = {};
    this.value = "";
    this.files = [];
    this.open = false;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler({ target: this, ...event });
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  append() {}
  appendChild() {}
  replaceChildren() {}
  focus() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
  setPointerCapture() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; }
}

function makeContext() {
  const elements = new Map();
  const appendedScripts = [];

  const get = (key) => {
    if (!elements.has(key)) elements.set(key, new MockElement(key));
    return elements.get(key);
  };

  const document = {
    title: "",
    body: {
      appendChild(node) {
        appendedScripts.push(node);
      },
    },
    querySelector(selector) {
      return get(selector);
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return get("#" + id);
    },
    createElement(tag) {
      return new MockElement(tag);
    },
    createDocumentFragment() {
      return new MockElement("fragment");
    },
  };

  const windowListeners = new Map();
  const window = {
    Module: undefined,
    WROOM_BUILD: undefined,
    __wroomStartRequested: undefined,
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
  };

  const context = vm.createContext({
    window,
    document,
    console,
    performance: { now: () => 0 },
    setTimeout: () => 1,
    setInterval: () => 1,
    clearTimeout() {},
    clearInterval() {},
    requestAnimationFrame: (fn) => fn(),
    localStorage: {
      getItem() { return "1"; },
      setItem() {},
    },
    matchMedia: () => ({ matches: false }),
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL() {},
    },
    Blob: class Blob {},
  });

  return { context, get, appendedScripts };
}

function runBootstrap(env) {
  vm.runInContext(bootstrapMatch[1], env.context, { filename: "index-bootstrap.js" });
}

function runShell(env) {
  vm.runInContext(shell, env.context, { filename: "wroom.js" });
}

function assertStarted(env, message) {
  const button = env.get("#startButton");
  assert.equal(button.disabled, true, message + ": Start must disable once startup begins");
  assert.equal(button.textContent, "STARTING…", message + ": Start must visibly enter STARTING state");
  assert.equal(env.appendedScripts.length, 1, message + ": runtime script must be appended exactly once");
  assert.match(
    String(env.appendedScripts[0].src),
    /^\.\/choochootracker\.js\?v=/,
    message + ": runtime JS must be cache-busted",
  );
}

// Normal path: shell is initialized before the user clicks START.
{
  const env = makeContext();
  runBootstrap(env);
  runShell(env);
  env.get("#startButton").dispatch("click");
  assertStarted(env, "normal click");
}

// Race path: user clicks before wroom.js has initialized.
{
  const env = makeContext();
  runBootstrap(env);
  const button = env.get("#startButton");
  button.dispatch("click");
  assert.equal(button.disabled, true, "queued click must react immediately");
  assert.equal(button.textContent, "LOADING UI…", "queued click must show immediate feedback");
  assert.equal(env.context.window.__wroomStartRequested, true, "queued click must be remembered");

  runShell(env);
  assert.equal(env.context.window.__wroomStartRequested, false, "shell must consume queued Start");
  assertStarted(env, "queued click");
}

assert.match(html, /wroom\.css\?v=__WROOM_BUILD__/, "CSS must be cache-busted");
assert.match(html, /wroom\.js\?v=__WROOM_BUILD__/, "browser shell must be cache-busted");

console.log("Web Start bootstrap smoke test passed");
