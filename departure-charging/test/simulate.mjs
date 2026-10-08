// Simulates charging nights against departure-charging.js and asserts the car is
// full before the departure time. Run: node departure-charging/test/simulate.mjs
//
// Model: car.soc is updated in whole percent every 5 min, the wallbox
// reports wallbox.current_power in 0.1 A, the car draws `draw` × the setpoint.
// The function runs once per minute (tick), like the inject node in flow.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SRC = readFileSync(fileURLToPath(new URL("../departure-charging.js", import.meta.url)), "utf8");
const CAPACITY_KWH = 86;
const EFFICIENCY = 0.9;

function simulate({ startSoc, startIso, departure, draw = 1, hours = 16 }) {
    let now = Date.parse(startIso);
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { super(...(a.length ? a : [now])); }
        static now() { return now; }
    }
    const store = {};
    const globals = { "wallbox.status": "B" };
    const fn = new Function("msg", "context", "global", "node", "Date", SRC);
    const context = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
    const global = { get: (k) => globals[k], set: (k, v) => { globals[k] = v; } };
    const node = { status() {}, warn(m) { throw new Error(`node.warn: ${m}`); } };
    const send = (topic, payload) => fn({ topic, payload }, context, global, node, FakeDate);

    const log = [];
    const statuses = new Set();
    const shorts = new Set();
    let soc = startSoc;
    let fullAt = null;
    if (departure !== undefined) send("departure", departure);

    for (let i = 0; i < hours * 60; i++) {
        const setpoint = store.s?.lastSent || 0;
        const charging = setpoint > 0 && soc < 100;
        globals["wallbox.status"] = charging ? "C" : "B";
        globals["wallbox.current_power"] = charging ? Math.round(setpoint * draw * 10) : 0;
        if (charging) {
            soc = Math.min(100, soc + (setpoint * draw * 3 * 230 / 1000 / 60) * EFFICIENCY / CAPACITY_KWH * 100);
            if (soc >= 100 && fullAt === null) fullAt = now;
        }
        if (i % 5 === 2) globals["car.soc"] = Math.floor(soc);
        const out = send("tick", now);
        if (out) {
            statuses.add(out[1].detail.reason.replace(/~\d\d:\d\d/, "~HH:MM"));
            shorts.add(out[1].text.replace(/\d\d:\d\d/g, "HH:MM").replace(/^\d+ (A|%)/, "N $1"));
        }
        if (out && out[0]) log.push(`${new RealDate(now).toISOString().slice(11, 16)}Z ${out[1].text} | ${out[1].detail.summary}`);
        now += 60000;
    }
    return { fullAt, log, statuses, shorts };
}

const berlin = (iso) => new Date(iso).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

const cases = [
    { name: "30 % at 18:00, departure 07:00 (dashboard ms)", startSoc: 30, startIso: "2026-10-08T16:00:00Z", departure: 25200000, deadline: "2026-10-09T05:00:00Z" },
    { name: "70 % at 22:00, default departure", startSoc: 70, startIso: "2026-10-08T20:00:00Z", deadline: "2026-10-09T05:00:00Z", expectPause: true },
    { name: "car draws 80 % of setpoint", startSoc: 40, startIso: "2026-10-08T18:00:00Z", draw: 0.8, deadline: "2026-10-09T05:00:00Z" },
    { name: "winter time, departure 06:30", startSoc: 60, startIso: "2026-12-08T20:00:00Z", departure: "06:30", deadline: "2026-12-09T05:30:00Z" },
];

let failed = 0;
for (const c of cases) {
    const { fullAt, log, statuses, shorts } = simulate(c);
    try {
        assert.ok(fullAt !== null, "never reached 100 %");
        assert.ok(fullAt <= Date.parse(c.deadline), `full at ${berlin(fullAt)}, after departure ${berlin(c.deadline)}`);
        if (c.expectPause) assert.ok(statuses.has("waiting, start ~HH:MM"), "expected a delayed start");
        for (const t of shorts) assert.ok(t.length <= 20, `dashboard text too long: "${t}"`);
        console.log(`ok    ${c.name} — full at ${berlin(fullAt)}, ${log.length} setpoint changes · ${[...shorts].join(" | ")}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${c.name} — ${e.message}\n      ${log.join("\n      ")}`);
    }
}
process.exit(failed ? 1 : 0);
