import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import plugin, { resolveLaunchProfile, resolveSettings } from "../src/index.ts";

const TOOL_NAMES = [
  "bidi",
  "click",
  "eval",
  "fill",
  "mask_automation",
  "navigate",
  "press",
  "restart",
  "screenshot",
  "snapshot",
  "start",
  "status",
  "tabs",
];

const MANAGED = { profile: undefined, defaultProfile: false };

test("registers the firefox tool namespace", async () => {
  const namespaces: Array<{ name: string; description: string }> = [];
  const tools: Array<{ name: string; options?: { namespace?: string } }> = [];

  const editor = {
    namespace(namespace: { name: string; description: string }) {
      namespaces.push(namespace);
    },
    add(tool: { name: string; options?: { namespace?: string } }) {
      tools.push(tool);
    },
    list: () => [],
    get: () => undefined,
    update: () => {},
    remove: () => {},
  };

  const context = {
    tool: {
      transform: async (callback: (value: typeof editor) => void) => {
        callback(editor);
        return { dispose: async () => {} };
      },
    },
  };

  await plugin.setup(context as never);

  assert.equal(plugin.id, "firefox-bidi");
  assert.equal(namespaces.length, 1);
  assert.equal(namespaces[0]?.name, "firefox");
  assert.match(namespaces[0]?.description ?? "", /Firefox/);

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    TOOL_NAMES,
  );
  assert.ok(
    tools.every((tool) => tool.options?.namespace === "firefox"),
    "every tool must be registered in the firefox namespace",
  );
});

test("launch profile defaults to an isolated, plugin-managed profile", () => {
  const linux = join("/home/me", ".local", "share", "opencode-firefox", "profile");
  assert.deepEqual(resolveLaunchProfile(MANAGED, "linux", "/home/me"), {
    dir: linux,
    label: `isolated profile ${linux}`,
  });
  assert.equal(
    resolveLaunchProfile(MANAGED, "linux", "/home/me", false, { XDG_DATA_HOME: "/data" }).dir,
    join("/data", "opencode-firefox", "profile"),
  );
  assert.equal(
    resolveLaunchProfile(MANAGED, "darwin", "/Users/me").dir,
    join("/Users/me", "Library", "Application Support", "opencode-firefox", "profile"),
  );
  assert.equal(
    resolveLaunchProfile(MANAGED, "win32", "C:\\Users\\me", false, {
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    }).dir,
    join("C:\\Users\\me\\AppData\\Local", "opencode-firefox", "profile"),
  );
});

test("a snap-packaged Firefox gets a profile inside its confined home", () => {
  assert.equal(
    resolveLaunchProfile(MANAGED, "linux", "/home/me", true).dir,
    join("/home/me", "snap", "firefox", "common", "opencode-firefox", "profile"),
  );
});

test("the profile option overrides the managed profile", () => {
  assert.deepEqual(resolveLaunchProfile({ profile: "/profiles/agent", defaultProfile: false }, "linux", "/home/me"), {
    dir: "/profiles/agent",
    label: "profile /profiles/agent",
  });
});

test("defaultProfile opts into the user's normal profile", () => {
  assert.deepEqual(resolveLaunchProfile({ profile: undefined, defaultProfile: true }, "linux", "/home/me"), {
    label: "your default Firefox profile",
  });
});

test("profile wins over defaultProfile", () => {
  assert.deepEqual(resolveLaunchProfile({ profile: "/profiles/agent", defaultProfile: true }, "linux", "/home/me"), {
    dir: "/profiles/agent",
    label: "profile /profiles/agent",
  });
});

test("settings prefer plugin options over environment variables", () => {
  assert.deepEqual(
    resolveSettings(
      {
        FIREFOX_BIDI_PORT: "9333",
        FIREFOX_BIN: "/env/firefox",
        FIREFOX_PROFILE: "/env/profile",
        FIREFOX_DEFAULT_PROFILE: "1",
      },
      { port: 9444, binary: "/opt/firefox", profile: "/opt/profile", defaultProfile: false },
    ),
    { port: 9444, binary: "/opt/firefox", profile: "/opt/profile", defaultProfile: false },
  );
});

test("settings fall back to environment variables and defaults", () => {
  assert.deepEqual(resolveSettings({}, {}), {
    port: 9222,
    binary: undefined,
    profile: undefined,
    defaultProfile: false,
  });
  assert.deepEqual(resolveSettings({ FIREFOX_BIDI_PORT: "9333", FIREFOX_PROFILE: "/env/profile" }, {}), {
    port: 9333,
    binary: undefined,
    profile: "/env/profile",
    defaultProfile: false,
  });
  assert.equal(resolveSettings({ FIREFOX_BIDI_PORT: "not-a-port" }, {}).port, 9222);
});
