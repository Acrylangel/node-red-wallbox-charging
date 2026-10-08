// Tests configure.mjs against an anonymised export. Run: node --test departure-charging/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../configure.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/example-export.json", import.meta.url));
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

function run(exportNodes, ...args) {
    const dir = mkdtempSync(join(tmpdir(), "departure-charging-"));
    const input = join(dir, "export.json");
    const out = join(dir, "out.json");
    writeFileSync(input, JSON.stringify(exportNodes));
    const r = spawnSync(process.execPath, [SCRIPT, input, "--out", out, ...args], { encoding: "utf8" });
    let flow = null;
    try { flow = JSON.parse(readFileSync(out, "utf8")); } catch { /* not written */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, flow };
}

const fn = (flow) => flow.find((n) => n.type === "function" && n.name === "Departure charging").func;
const cfgValue = (func, name) => func.match(new RegExp(`^\\s+${name}:\\s*([^,\\n]+),`, "m"))[1];

test("detects sources, setpoint, gateway, tab and group", () => {
    const nodes = fixture();
    const { code, flow, stdout } = run(nodes);
    assert.equal(code, 0, stdout);

    const func = fn(flow);
    assert.equal(cfgValue(func, "soc"), '"car.soc"');
    assert.equal(cfgValue(func, "wallbox_status"), '"wallbox.status"');
    assert.equal(cfgValue(func, "current"), '"wallbox.current_power"');

    const setpoint = nodes.find((n) => n.name === "Set charge current");
    const write = flow.find((n) => n.type === "knxUltimate");
    assert.equal(write.topic, setpoint.topic);
    assert.equal(write.server, setpoint.server);

    const group = nodes.find((n) => n.type === "ui_group" && n.name === "Wallbox");
    assert.ok(flow.filter((n) => n.group).every((n) => n.group === group.id));
    assert.ok(!flow.some((n) => n.type === "ui_group" || n.type === "ui_tab"), "reuses the existing group");
    assert.ok(flow.filter((n) => n.z).every((n) => n.z === setpoint.z));
});

test("--set overrides CFG values", () => {
    const { code, flow } = run(fixture(), "--set", "CAPACITY_KWH=77", "--set", "TZ=Europe/Vienna", "--set", "ALLOW_PAUSE=false");
    assert.equal(code, 0);
    const func = fn(flow);
    assert.equal(cfgValue(func, "CAPACITY_KWH"), "77");
    assert.equal(cfgValue(func, "TZ"), '"Europe/Vienna"');
    assert.equal(cfgValue(func, "ALLOW_PAUSE"), "false");
});

test("rejects unknown CFG keys", () => {
    const { code, stderr } = run(fixture(), "--set", "NOPE=1");
    assert.equal(code, 1);
    assert.match(stderr, /unknown CFG key "NOPE"/);
});

test("fails on an ambiguous setpoint and accepts --setpoint-ga", () => {
    const nodes = fixture();
    const second = { ...nodes.find((n) => n.name === "Set charge current"), id: "0000000000000001", topic: "1/2/99" };
    const ambiguous = run([...nodes, second]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /ambiguous/);

    const resolved = run([...nodes, second], "--setpoint-ga", "1/2/99");
    assert.equal(resolved.code, 0);
    assert.equal(resolved.flow.find((n) => n.type === "knxUltimate").topic, "1/2/99");
});

test("warns when a source does not reach global context", () => {
    const nodes = fixture().map((n) => (n.name === "Car SoC" ? { ...n, wires: [[]] , notifywrite: true } : n));
    // Without wires the node is no longer a source at all → SoC is required → error
    assert.equal(run(nodes).code, 1);

    const unstored = fixture().map((n) => (n.name === "Car SoC" ? { ...n, wires: [[nodes.find((x) => x.type === "ui_slider").id]] } : n));
    const r = run(unstored);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Car SoC .* is not wired to a function that does global\.set/);
});

test("falls back to the template group when none matches", () => {
    const nodes = fixture().filter((n) => !(n.type === "ui_group" && n.name === "Wallbox"));
    const { code, flow } = run(nodes);
    assert.equal(code, 0);
    assert.ok(flow.some((n) => n.type === "ui_group" && n.name === "Departure charging"));
});
