import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const readWebFile = (...parts: string[]) =>
  readFileSync(path.join(process.cwd(), ...parts), "utf8");

test("the retired agent setup and selection UI has no route or composer entry", () => {
  assert.equal(existsSync(path.join(process.cwd(), "app/(utility)/agents")), false);
  assert.equal(
    existsSync(path.join(process.cwd(), "components/agents/ConnectedAgents.tsx")),
    false,
  );
  assert.equal(
    existsSync(path.join(process.cwd(), "components/chat/home/AgentSelector.tsx")),
    false,
  );
  const composer = readWebFile("components", "chat", "home", "ComposerInput.tsx");
  assert.doesNotMatch(composer, /Talk to an agent|No connected agents/);
  assert.doesNotMatch(composer, /my_agents|AgentSelector/);
});

test("internal execution event glyphs retain their local assets", () => {
  const icons = readWebFile("components", "agents", "agent-icons.tsx");
  for (const asset of [
    "kimi.svg",
    "opencode.svg",
    "mimo-code.svg",
    "hermes.svg",
    "openclaw.svg",
    "deepseek-harness.svg",
  ]) {
    assert.ok(
      existsSync(path.join(process.cwd(), "public", "agent-icons", asset)),
      `${asset} internal execution icon is missing`,
    );
    assert.match(icons, new RegExp(`/agent-icons/${asset}`));
  }
});
