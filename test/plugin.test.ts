import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../src/index.ts";

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
