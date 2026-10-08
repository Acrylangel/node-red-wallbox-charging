#!/usr/bin/env node
// Builds a ready-to-import departure-charging flow from an export of your existing
// Node-RED flow: detects where the data comes from (KNX feedback nodes and their
// global-context keys) and where the current setpoint goes (KNX write node, gateway),
// then writes the parametrised function node into a new flow file.
//
//   node departure-charging/configure.mjs <export.json> [options]
//
// Options:
//   --out <file>          output file (default: .local/flow.local.json — gitignored)
//   --gateway <name|id>   KNX gateway config node, if the export has several
//   --setpoint-ga <ga>    group address of the wallbox current setpoint (DPT 14.019)
//   --group <name|id>     dashboard group for the controls
//   --set KEY=VALUE       override a CFG value, e.g. --set CAPACITY_KWH=77 --set KEYS.soc=car.soc
//   --dry-run             print the detection result, write nothing
//
// The export is read-only input. The output contains your installation's addresses and
// node IDs — keep it out of version control (.local/ is gitignored).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// --- CLI ---------------------------------------------------------------------
const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: "string", default: here("../.local/flow.local.json") },
        gateway: { type: "string" },
        "setpoint-ga": { type: "string" },
        group: { type: "string" },
        set: { type: "string", multiple: true, default: [] },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});
if (opt.help || positionals.length !== 1) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 2);
}

const exportNodes = JSON.parse(readFileSync(positionals[0], "utf8"));
if (!Array.isArray(exportNodes)) fail("export must be a JSON array of nodes (Node-RED: Menu → Export → JSON)");
const template = JSON.parse(readFileSync(here("./flow.json"), "utf8"));

const notes = [];
const warnings = [];
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

// --- helpers -----------------------------------------------------------------
const byId = new Map(exportNodes.map((n) => [n.id, n]));
const knx = exportNodes.filter((n) => n.type === "knxUltimate");
const truthy = (v) => v === true || v === "true";
const dptIs = (n, dpt) => String(n.dpt || "").startsWith(dpt);
const label = (n) => `${n.name || n.id} (${n.topic || "?"})`;
const text = (n) => `${n.name || ""} ${n.outputtopic || ""}`;
const msgTopic = (n) => n.outputtopic || n.topic; // knx-ultimate sets msg.topic to outputtopic, else the GA

// Feedback nodes: they emit telegrams from the bus into the flow
const sources = knx.filter((n) => (truthy(n.notifywrite) || truthy(n.notifyresponse)) && (n.wires || []).flat().length > 0);

// A value only reaches the function if some node stores msg.topic → global context
function storesGlobally(n) {
    return (n.wires || []).flat().some((id) => {
        const t = byId.get(id);
        return t && t.type === "function" && /global\.set\(\s*msg\.topic/.test(t.func || "");
    });
}

function pickOne(what, candidates, { required }) {
    // Several nodes on the same GA with the same topic count as one source
    const unique = [...new Map(candidates.map((n) => [`${n.topic}|${msgTopic(n)}`, n])).values()];
    if (unique.length === 1) return unique[0];
    if (unique.length === 0) {
        (required ? fail : (m) => notes.push(m))(`${what}: no matching node found`);
        return null;
    }
    fail(`${what}: ambiguous — ${unique.map(label).join(", ")}. Pass the matching option.`);
}

// --- detect: data sources ------------------------------------------------------
const detected = {};

detected.status = pickOne("wallbox status (DPT 4.001)", sources.filter((n) => dptIs(n, "4.")), { required: true });

detected.soc = pickOne("car SoC (DPT 5.001)",
    sources.filter((n) => dptIs(n, "5.001") && /soc|state.?of.?charge|ladezustand|batterie/i.test(text(n)) && !/target|ziel/i.test(text(n))),
    { required: true });

detected.targetSoc = pickOne("target SoC (DPT 5.001, optional)",
    sources.filter((n) => dptIs(n, "5.001") && /target|ziel/i.test(text(n))),
    { required: false });

detected.current = pickOne("measured charge current (DPT 14.019, optional)",
    sources.filter((n) => dptIs(n, "14.019") && !/max/i.test(text(n))),
    { required: false });

for (const [key, n] of Object.entries(detected)) {
    if (n && !storesGlobally(n)) {
        warnings.push(`${label(n)} is not wired to a function that does global.set(msg.topic, …) — the ${key} value will not reach the function`);
    }
}

// --- detect: setpoint target and gateway --------------------------------------
// Prefer write nodes on the tab that holds the wallbox feedback (the same GA may be written from several tabs)
const writes = knx.filter((n) => n.outputtype === "write" && dptIs(n, "14.019"))
    .sort((a, b) => (a.z === detected.status.z ? 0 : 1) - (b.z === detected.status.z ? 0 : 1));
const setpoint = opt["setpoint-ga"]
    ? (writes.find((n) => n.topic === opt["setpoint-ga"]) ?? { topic: opt["setpoint-ga"], server: null })
    : pickOne("current setpoint write node (DPT 14.019)", writes, { required: true });

const gateways = exportNodes.filter((n) => n.type === "knxUltimate-config");
let gateway;
if (opt.gateway) {
    gateway = gateways.find((g) => g.id === opt.gateway || g.name === opt.gateway) ?? fail(`gateway "${opt.gateway}" not found`);
} else if (setpoint.server && gateways.some((g) => g.id === setpoint.server)) {
    gateway = byId.get(setpoint.server);
} else if (gateways.length === 1) {
    gateway = gateways[0];
} else {
    fail(`KNX gateway: ${gateways.length ? `ambiguous — ${gateways.map((g) => g.name || g.id).join(", ")}` : "no knxUltimate-config node in the export"}. Pass --gateway.`);
}

// --- detect: flow tab and dashboard group -------------------------------------
const tab = detected.status.z ? detected.status : setpoint;
const groups = exportNodes.filter((n) => n.type === "ui_group");
let group = null;
if (opt.group) {
    group = groups.find((g) => g.id === opt.group || g.name === opt.group) ?? fail(`dashboard group "${opt.group}" not found`);
} else {
    const named = groups.filter((g) => /wallbox|charg|lade/i.test(g.name || ""));
    if (named.length === 1) group = named[0];
    else notes.push(`dashboard: ${named.length ? "several" : "no"} matching group — using the template's own group (or pass --group)`);
}

// --- CFG overrides --------------------------------------------------------------
const cfg = {
    "KEYS.wallbox_status": msgTopic(detected.status),
    "KEYS.soc": msgTopic(detected.soc),
};
if (detected.targetSoc) cfg["KEYS.target_soc"] = msgTopic(detected.targetSoc);
if (detected.current) cfg["KEYS.current"] = msgTopic(detected.current);

for (const s of opt.set) {
    const m = s.match(/^([A-Za-z_.]+)=(.*)$/);
    if (!m) fail(`--set expects KEY=VALUE, got "${s}"`);
    cfg[m[1]] = m[2];
}

function literal(v) {
    if (typeof v !== "string") return JSON.stringify(v);
    if (/^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false") return v;
    return JSON.stringify(v);
}

function applyCfg(func, entries) {
    const start = func.indexOf("const CFG = {");
    const end = func.indexOf("\n};", start);
    if (start < 0 || end < 0) fail("function template has no CFG block");
    let block = func.slice(start, end);
    for (const [path, value] of Object.entries(entries)) {
        const name = path.split(".").pop();
        const re = new RegExp(`^(\\s+${name}:\\s*)([^,\\n]+?)(,)`, "m");
        if (!re.test(block)) fail(`unknown CFG key "${path}"`);
        block = block.replace(re, (_, pre, _old, comma) => `${pre}${literal(value)}${comma}`);
    }
    return func.slice(0, start) + block + func.slice(end);
}

// --- adopt a previous install ----------------------------------------------------
// Node-RED gives imported nodes new IDs. Map every template node to the node that plays
// the same role in an existing install, so a deploy replaces it instead of duplicating it.
function roleMap(nodes) {
    const ids = new Map(nodes.map((n) => [n.id, n]));
    const fn = nodes.find((n) => n.type === "function" && n.name === "Departure charging");
    if (!fn) return new Map();
    const roles = new Map([["function", fn]]);
    const target = (n, i = 0) => ids.get((n?.wires?.[i] || [])[0]);
    const feeders = nodes.filter((n) => (n.wires || []).flat().includes(fn.id));
    for (const n of feeders) {
        if (n.type === "inject" && n.topic === "tick") roles.set("tick", n);
        else if (n.topic === "smart_charging" || n.type === "ui_switch") roles.set("switch", n);
        else if (n.topic === "departure" || ["ui_text_input", "ui_template"].includes(n.type)) roles.set("departure", n);
    }
    for (const [role, initRole] of [["departure", "init-departure"], ["switch", "init-switch"]]) {
        const w = roles.get(role);
        const init = w && nodes.find((n) => n.type === "inject" && (n.wires || []).flat().includes(w.id));
        if (init) roles.set(initRole, init);
    }
    if (target(fn, 0)?.type === "delay") {
        roles.set("delay", target(fn, 0));
        if (target(target(fn, 0))?.type === "knxUltimate") roles.set("knx", target(target(fn, 0)));
    }
    if (target(fn, 1)?.type === "ui_text") roles.set("status", target(fn, 1));
    return roles;
}

const templateRoles = roleMap(template);
const existingRoles = roleMap(exportNodes);
const adopt = new Map(); // template id -> existing node
for (const [role, n] of templateRoles) {
    const old = existingRoles.get(role);
    if (old) adopt.set(n.id, old);
}
if (adopt.size) notes.push(`existing install found: ${adopt.size} nodes are replaced in place (same IDs and positions)`);
const newId = (id) => adopt.get(id)?.id ?? id;

// --- build output -------------------------------------------------------------
const out = [];
for (const n of template) {
    if ((n.type === "ui_group" || n.type === "ui_tab") && group) continue;
    const node = structuredClone(n);
    const old = adopt.get(n.id);
    node.id = newId(n.id);
    if (node.wires) node.wires = node.wires.map((ws) => ws.map(newId));
    if (old) { node.x = old.x; node.y = old.y; node.z = old.z; }
    if (!["ui_group", "ui_tab"].includes(node.type) && tab?.z && !old) node.z = tab.z;
    if (node.group && group) node.group = group.id;
    if (node.type === "function" && node.name === "Departure charging") {
        node.func = applyCfg(node.func, cfg);
        new Function("msg", "context", "global", "node", node.func); // syntax check
    }
    if (node.type === "knxUltimate") {
        node.server = gateway.id;
        node.topic = setpoint.topic;
        node.name = "Charge current (departure charging)";
    }
    out.push(node);
}

// --- report -------------------------------------------------------------------
const row = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
console.log("Detected:");
row("wallbox status", `${label(detected.status)} → global "${msgTopic(detected.status)}"`);
row("car SoC", `${label(detected.soc)} → global "${msgTopic(detected.soc)}"`);
row("target SoC", detected.targetSoc ? `${label(detected.targetSoc)} → global "${msgTopic(detected.targetSoc)}"` : "– (default 100 %)");
row("measured current", detected.current ? `${label(detected.current)} → global "${msgTopic(detected.current)}"` : "– (uses the setpoint)");
row("setpoint write", `${setpoint.topic} via gateway "${gateway.name || gateway.id}"`);
row("flow tab", tab?.z ?? "– (import into the current tab)");
row("dashboard group", group ? `${group.name} (${group.id})` : "template group \"Departure charging\"");
console.log("CFG:");
for (const [k, v] of Object.entries(cfg)) row(k, literal(v));
for (const n of notes) console.log(`note: ${n}`);
for (const w of warnings) console.log(`warning: ${w}`);

if (opt["dry-run"]) process.exit(0);
mkdirSync(dirname(opt.out), { recursive: true });
writeFileSync(opt.out, JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote ${out.length} nodes to ${opt.out} — import via Node-RED Menu → Import.`);
