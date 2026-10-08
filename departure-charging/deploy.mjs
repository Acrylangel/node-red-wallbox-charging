#!/usr/bin/env node
// Deploys a generated departure-charging flow straight into a running Node-RED via its
// Admin HTTP API — the same call the editor's Deploy button makes.
//
//   node departure-charging/deploy.mjs login   --url http://host:1880
//   node departure-charging/deploy.mjs pull    [.local/export.local.json]
//   node departure-charging/deploy.mjs deploy  [.local/flow.local.json] [--dry-run]
//   node departure-charging/deploy.mjs restore <.local/backups/…>
//
// login    asks for the Node-RED admin user and password and stores only the access
//          token (chmod 600) in ~/.config/node-red-wallbox/<host>.json
// pull     saves the running flows as an export for configure.mjs
// deploy   backs up the complete current flows to .local/backups/, removes the nodes of a previous
//          departure-charging deploy (same IDs), adds the new ones and deploys with
//          "Node-RED-Deployment-Type: nodes", so only changed nodes restart
// restore  deploys a backup unchanged
//
// The URL is remembered with the token; NODE_RED_URL / NODE_RED_TOKEN override both.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG_DIR = join(homedir(), ".config", "node-red-wallbox");
const DEFAULT_CONFIG = join(CONFIG_DIR, "default.json");

const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        url: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});
const [command, file] = positionals;

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

if (opt.help || !["login", "pull", "deploy", "restore"].includes(command)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(opt.help ? 0 : 2);
}

// --- auth --------------------------------------------------------------------
function loadConfig() {
    const cfg = existsSync(DEFAULT_CONFIG) ? JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8")) : {};
    const url = (process.env.NODE_RED_URL || opt.url || cfg.url || "").replace(/\/+$/, "");
    const token = process.env.NODE_RED_TOKEN || cfg.token || null;
    if (!url) fail("no Node-RED URL — run login --url http://host:1880 first");
    return { url, token };
}

function ask(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
        rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer); });
    });
}

async function api(url, token, path, { method = "GET", body, headers = {} } = {}) {
    const res = await fetch(url + path, {
        method,
        headers: {
            "Node-RED-API-Version": "v2",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 401) fail(`${method} ${path}: 401 Unauthorized — run login again (tokens expire after 7 days by default)`);
    if (!res.ok) fail(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function login() {
    const url = (opt.url || process.env.NODE_RED_URL || "").replace(/\/+$/, "");
    if (!url) fail("login needs --url http://host:1880");
    const scheme = await api(url, null, "/auth/login");
    if (!scheme || !scheme.type) {
        console.log("This Node-RED has no admin login — no token needed.");
        save({ url, token: null });
        return;
    }
    if (scheme.type !== "credentials") fail(`login type "${scheme.type}" is not supported, only username/password`);
    const username = await ask("Node-RED admin user: ");
    const password = await ask("Password: ", { hidden: true });
    const res = await fetch(url + "/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "node-red-admin", grant_type: "password", scope: "*", username, password }),
    });
    if (!res.ok) fail(`login failed: ${res.status}`);
    const { access_token: token, expires_in: expires } = await res.json();
    save({ url, token });
    console.log(`Logged in. Token stored in ${DEFAULT_CONFIG}, valid for ${Math.round(expires / 86400)} days.`);
}

function save(cfg) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(DEFAULT_CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    chmodSync(DEFAULT_CONFIG, 0o600);
}

// --- deploy ------------------------------------------------------------------
async function deploy() {
    const { url, token } = loadConfig();
    const path = file || here("../.local/flow.local.json");
    if (!existsSync(path)) fail(`${path} not found — run configure.mjs first`);
    const incoming = JSON.parse(readFileSync(path, "utf8"));

    const current = await api(url, token, "/flows");
    mkdirSync(here("../.local/backups"), { recursive: true });
    const backup = here(`../.local/backups/flows-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(backup, JSON.stringify(current.flows, null, 2) + "\n");

    const incomingIds = new Set(incoming.map((n) => n.id));
    const kept = current.flows.filter((n) => !incomingIds.has(n.id));
    const replaced = current.flows.length - kept.length;
    const existing = new Set(kept.map((n) => n.id));

    // Every reference must resolve: gateway, dashboard group, flow tab, wires
    const missing = [];
    for (const n of incoming) {
        for (const key of ["z", "server", "group"]) {
            if (n[key] && !existing.has(n[key]) && !incomingIds.has(n[key])) missing.push(`${n.name || n.type}.${key} → ${n[key]}`);
        }
        for (const w of (n.wires || []).flat()) {
            if (!existing.has(w) && !incomingIds.has(w)) missing.push(`${n.name || n.type} wire → ${w}`);
        }
    }
    if (missing.length) fail(`references not found in the running flows:\n  ${missing.join("\n  ")}`);

    console.log(`Node-RED:   ${url} (rev ${current.rev})`);
    console.log(`Backup:     ${backup}`);
    console.log(`Nodes:      ${incoming.length} to deploy, ${replaced} from a previous deploy replaced, ${kept.length} untouched`);
    if (opt["dry-run"]) { console.log("Dry run — nothing deployed."); return; }

    const result = await api(url, token, "/flows", {
        method: "POST",
        body: { rev: current.rev, flows: [...kept, ...incoming] },
        headers: { "Node-RED-Deployment-Type": "nodes" },
    });
    console.log(`Deployed.   new rev ${result.rev}`);
    console.log(`Undo with:  node departure-charging/deploy.mjs restore ${backup}`);
}

async function pull() {
    const { url, token } = loadConfig();
    const path = file || here("../.local/export.local.json");
    mkdirSync(here("../.local"), { recursive: true });
    const current = await api(url, token, "/flows");
    writeFileSync(path, JSON.stringify(current.flows, null, 2) + "\n");
    console.log(`Saved ${current.flows.length} nodes (rev ${current.rev}) to ${path}`);
}

async function restore() {
    if (!file) fail("restore needs the backup file");
    const { url, token } = loadConfig();
    const flows = JSON.parse(readFileSync(file, "utf8"));
    const current = await api(url, token, "/flows");
    const result = await api(url, token, "/flows", {
        method: "POST",
        body: { rev: current.rev, flows },
        headers: { "Node-RED-Deployment-Type": "full" },
    });
    console.log(`Restored ${flows.length} nodes from ${file} — new rev ${result.rev}`);
}

await { login, pull, deploy, restore }[command]();
