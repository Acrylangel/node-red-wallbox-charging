// Tests the away period (CFG.KEYS.away) of departure-charging.js. Run: node --test departure-charging/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../departure-charging.js", import.meta.url)), "utf8");
const WITH_AWAY = SRC.replace(/^(\s+away:\s*)null,/m, '$1"away",');
const AWAY = { start: "2027-03-20T03:00", end: "2027-03-30T15:00" }; // ends after the switch to summer time

function harness({ src = WITH_AWAY, away = AWAY, departure = "06:30", status = "B", soc = 50 } = {}) {
    let now = 0;
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { super(...(a.length ? a : [now])); }
        static now() { return now; }
    }
    const store = {};
    const globals = { "wallbox.status": status, "car.soc": soc, away };
    const fn = new Function("msg", "context", "global", "node", "Date", src);
    const context = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
    const global = { get: (k) => globals[k], set: (k, v) => { globals[k] = v; } };
    const node = { status() {}, warn(m) { throw new Error(`node.warn: ${m}`); } };
    const send = (iso, topic = "tick", payload = "") => {
        now = Date.parse(iso);
        const [out1, out2, out3] = fn({ topic, payload }, context, global, node, FakeDate);
        return { amps: out1?.payload, text: out2.text, detail: out2.detail, departure: out3.payload };
    };
    if (departure) send("2027-03-01T12:00:00Z", "departure", departure);
    return { send, globals, store };
}

test("keeps the regular departure until it has passed on the day before", () => {
    const { send } = harness();
    const r = send("2027-03-19T05:00:00Z"); // 06:00 Berlin
    assert.equal(r.departure, "06:30");
    assert.equal(r.detail.departure, "2027-03-19T05:30:00.000Z");
    assert.equal(r.detail.awayDeparture, false);
});

test("switches to the start of the away period once the car is unplugged after the regular departure", () => {
    const { send, globals } = harness();
    const plugged = send("2027-03-19T05:31:00Z"); // 06:31 Berlin, still plugged in: grace period
    assert.equal(plugged.departure, "06:30");
    assert.equal(plugged.amps, 16, "full speed while still plugged in after the departure");

    globals["wallbox.status"] = "A";
    const r = send("2027-03-19T05:40:00Z");
    assert.equal(r.departure, "03:00");
    assert.equal(r.detail.departure, "2027-03-20T02:00:00.000Z");
    assert.equal(r.detail.awayDeparture, true);
});

test("switches to the start of the away period after the grace period while plugged in", () => {
    const { send } = harness();
    assert.equal(send("2027-03-19T07:29:00Z").departure, "06:30"); // 08:29 Berlin
    assert.equal(send("2027-03-19T07:31:00Z").departure, "03:00");
});

test("ignores an away period that starts after the next regular departure", () => {
    const { send } = harness();
    const r = send("2027-03-18T05:31:00Z"); // two days before: today's departure, within GRACE_MIN
    assert.equal(r.departure, "06:30");
    assert.equal(r.detail.departure, "2027-03-18T05:30:00.000Z");
    assert.equal(send("2027-03-18T07:31:00Z").detail.departure, "2027-03-19T05:30:00.000Z");
});

test("an away start later on the same day replaces the regular departure once it has passed", () => {
    const { send } = harness({ away: { start: "2027-03-19T10:00", end: "2027-03-23T18:00" }, status: "A" });
    assert.equal(send("2027-03-19T05:00:00Z").departure, "06:30");
    assert.equal(send("2027-03-19T05:31:00Z").departure, "10:00");
});

test("stays silent during the away period, so the setpoint holds until the car is unplugged", () => {
    const { send, store, globals } = harness();
    send("2027-03-19T20:00:00Z");
    const before = store.s.lastSent;
    assert.ok(before > 0, "charging before the away period");

    const r = send("2027-03-20T02:00:00Z"); // 03:00 Berlin, still plugged in
    assert.equal(r.amps, undefined, "no write at the away start");
    assert.equal(r.text, "Away until 30.03.");
    assert.match(r.detail.reason, /smart charging off until 30\.03\. 14:00/);

    globals["wallbox.status"] = "A";
    assert.equal(send("2027-03-20T02:10:00Z").amps, undefined, "unplug: switching off is left to the flow");
    globals["wallbox.status"] = "B";
    assert.equal(send("2027-03-23T10:00:00Z").amps, undefined, "plugged in during the period: still silent");
});

test("resumes the regular schedule one hour before the end (summer time)", () => {
    const { send } = harness({ soc: 20 });
    assert.match(send("2027-03-30T11:59:00Z").detail.reason, /^away/); // 13:59 CEST
    const r = send("2027-03-30T12:00:00Z");                             // 14:00 CEST
    assert.equal(r.detail.reason.startsWith("away"), false);
    assert.ok(r.detail.amps > 0, "charges again");
    assert.equal(r.departure, "06:30");
    assert.equal(r.detail.departure, "2027-03-31T04:30:00.000Z");
});

test("without KEYS.away the away settings are ignored", () => {
    const { send } = harness({ src: SRC });
    const r = send("2027-03-21T10:00:00Z");
    assert.equal(r.detail.awayDeparture, false);
    assert.notEqual(r.amps, 0);
    assert.equal(r.departure, "06:30");
});

test("ignores empty and invalid away settings", () => {
    for (const away of [{}, { start: "2027-03-20T03:00", end: "2027-03-19T03:00" }, { start: "x", end: "y" }]) {
        const { send } = harness({ away, status: "A" });
        assert.equal(send("2027-03-19T05:31:00Z").departure, "06:30");
    }
});

test("the car is full before an early away start", () => {
    const { send, globals, store } = harness({ soc: 30 });
    let soc = 30;
    let fullAt = null;
    for (let t = Date.parse("2027-03-19T17:00:00Z"); t < Date.parse("2027-03-20T02:00:00Z"); t += 60000) {
        const setpoint = store.s?.lastSent || 0;
        const charging = setpoint > 0 && soc < 100;
        globals["wallbox.status"] = charging ? "C" : "B";
        globals["wallbox.current_power"] = charging ? setpoint * 10 : 0;
        if (charging) soc = Math.min(100, soc + setpoint * 3 * 230 / 1000 / 60 * 0.9 / 86 * 100);
        if (soc >= 100 && fullAt === null) fullAt = t;
        if ((t / 60000) % 5 === 2) globals["car.soc"] = Math.floor(soc);
        send(new Date(t).toISOString());
    }
    assert.ok(fullAt !== null && fullAt <= Date.parse("2027-03-20T02:00:00Z"), `full at ${fullAt && new Date(fullAt).toISOString()}`);
    assert.match(send("2027-03-20T02:00:00Z").detail.reason, /^away/, "smart charging off at the away start");
});
