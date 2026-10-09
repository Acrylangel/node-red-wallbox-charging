// ============================================================================
// Departure charging — modulate wallbox current (6–16 A) so the car reaches
// its target SoC at the departure time.
//
// Reads from global context (keys configurable in CFG.KEYS):
//   car.soc                SoC % (whole percent is fine)
//   car.target_soc         target SoC % (optional, default 100)
//   away period            { start, end } as wall time "YYYY-MM-DDTHH:mm" in CFG.TZ (optional,
//                          e.g. vacation settings; {} = none) — see "Away period" below
//   wallbox.status         IEC 61851 state A–F
//   wallbox.current_power  measured charge current per phase (unit: CURRENT_SCALE)
//
// Inputs (msg.topic):
//   tick                any — inject every 60 s
//   departure           ms since midnight (dashboard time input) | "07:30"
//   smart_charging      true/false  false = manual control, function stays silent
//
// Output 1: msg.payload = charge current in A (0 = pause, else MIN_A..MAX_A)
//           -> rate limit -> wallbox current setpoint (e.g. knx-ultimate, DPT 14.019)
// Output 2: msg.payload = short status with Font Awesome icon (HTML, for a ui_text row),
//           msg.text = the same without icon, msg.detail = full calculation
// Output 3: msg.topic "departure", msg.payload "HH:MM" = the departure in effect, sent on every
//           run so the dashboard input shows it (also after a restart of either node)
//
// Away period (CFG.KEYS.away): once the last regular departure before the start has passed
// (and the car was unplugged or GRACE_MIN is over), the car is charged for the start of the
// period instead; the dashboard input shows that time meanwhile. From the start until
// AWAY_RESUME_MIN before its end the function stays silent like with smart charging off, so
// the setpoint is kept until the car is unplugged (switching the wallbox off on unplug is
// left to the flow); then the regular schedule resumes.
// ============================================================================

const CFG = {
    KEYS: {                    // global context keys
        soc: "car.soc",
        target_soc: "car.target_soc",    // optional
        current: "wallbox.current_power", // measured current per phase
        wallbox_status: "wallbox.status",
        away: null,                      // optional, e.g. "vacation_settings"
    },
    TZ: "Europe/Berlin",       // Node-RED in Docker often runs in UTC — departure is always local time
    CAPACITY_KWH: 86,          // net battery capacity (e.g. VW ID.7 Pro: 77, Pro S / GTX: 86)
    PHASES: 3,                 // 3-phase AC (11 kW at 16 A)
    VOLTAGE: 230,
    EFFICIENCY: 0.90,          // grid -> battery (AC charging losses)
    MIN_A: 6,                  // IEC 61851 minimum — car will not charge below 6 A
    MAX_A: 16,
    BUFFER_MIN: 45,            // finish this many minutes before departure (top-off/balancing reserve)
    ALLOW_PAUSE: true,         // true: hold at 0 A and start late (only before the first start per plug-in)
                               // false: charge at MIN_A right away and finish early
    AMP_HYST_DOWN_A: 1.5,      // keep the setpoint while the requirement is up to this much below it
    AMP_HYST_UP_A: 0.5,        // ...or up to this much above it (the buffer absorbs the difference)
    GRACE_MIN: 120,            // still plugged in after departure: keep full speed this long before planning for the next day
    DEFAULT_TARGET: 100,       // used when no target SoC is available
    DEFAULT_DEPARTURE: "07:00",// used until a departure is set (also after a Node-RED restart)
    CURRENT_SCALE: 0.1,        // factor to amps for the measured current (0.1 = value in 0.1 A, 1 = value in A)
    SOC_EST_MAX_AHEAD: 2,      // the estimate may run at most this many % ahead of the last reported SoC
    SOC_WAIT_MIN: 10,          // after plug-in: hold at 0 A this long for a first SoC, then fall back to full speed
    AWAY_RESUME_MIN: 60,       // away period: smart charging resumes this long before its end
};

const PLUGGED = ["B", "C", "D"];

// Dashboard summary: icon classes work with Font Awesome 4 (dashboard default) and 6.
// The dashboard strips style attributes from ui_text HTML, so colours come from the
// dc-state-* classes defined in dashboard/departure-input.html.
const LOOK = {
    wait: "fa fa-clock fa-clock-o dc-state-wait",
    charge: "fa fa-bolt dc-state-ok",
    done: "fa fa-check dc-state-ok",
    late: "fa fa-exclamation-triangle dc-state-bad",
    manual: "fa fa-hand fa-hand-paper-o dc-state-off",
    unplugged: "fa fa-plug dc-state-off",
    away: "fa fa-suitcase dc-state-off",
};

// --- time zone helpers ------------------------------------------------------
const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CFG.TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function wallParts(ts) {
    const p = {};
    for (const x of fmt.formatToParts(new Date(ts))) p[x.type] = +x.value;
    return p;
}
function tzOffsetMs(ts) {
    const p = wallParts(ts);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
function wallToTs(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo, d, h, mi);
    return guess - tzOffsetMs(guess - tzOffsetMs(guess));
}
const hhmm = (ts) => new Date(ts).toLocaleTimeString("de-DE", { timeZone: CFG.TZ, hour: "2-digit", minute: "2-digit" });
const ddmm = (ts) => new Date(ts).toLocaleDateString("de-DE", { timeZone: CFG.TZ, day: "2-digit", month: "2-digit" });
function parseWallTime(v) {
    const m = typeof v === "string" && v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? wallToTs(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

// ---------------------------------------------------------------------------
const s = context.get("s") || {
    soc: null, energyKwh: 0, lastIntegrateTs: null,
    target: null, wallbox: null, measuredA: null,
    departure: null, enabled: true, lastSent: null, started: false, pluggedTs: null,
};
const now = Date.now();

// Integrate energy delivered since the last SoC reading (bridge SoC lags up to 5 min)
function integrate() {
    if (s.lastIntegrateTs !== null && s.soc !== null && (s.wallbox === "C" || s.wallbox === "D")) {
        const h = (now - s.lastIntegrateTs) / 3600000;
        const a = s.measuredA !== null ? s.measuredA : (s.lastSent || 0);
        const kw = a * CFG.PHASES * CFG.VOLTAGE / 1000;
        s.energyKwh += kw * h;
    }
    s.lastIntegrateTs = now;
}

function parseDeparture(v) {
    if (typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v);
    if (typeof v === "number" && v >= 0 && v < 86400000) {
        return { h: Math.floor(v / 3600000), m: Math.floor(v / 60000) % 60 };
    }
    if (v instanceof Date) {
        const p = wallParts(v.getTime());
        return { h: p.hour, m: p.minute };
    }
    if (typeof v === "string") {
        const hm = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
        if (hm) return { h: +hm[1], m: +hm[2] };
    }
    return null;
}

function nextDepartureTs() {
    const d = s.departure || parseDeparture(CFG.DEFAULT_DEPARTURE);
    const p = wallParts(now);
    const today = wallToTs(p.year, p.month - 1, p.day, d.h, d.m);
    const tomorrow = wallToTs(p.year, p.month - 1, p.day + 1, d.h, d.m);
    const inGrace = today <= now && today > now - CFG.GRACE_MIN * 60000;
    // An away period that starts before the next regular departure replaces it — after the
    // grace period of a departure that has just passed, or once the car is unplugged
    if (away && away.start > now && away.start <= (today > now ? today : tomorrow)
        && !(inGrace && PLUGGED.includes(s.wallbox))) return away.start;
    return inGrace || today > now ? today : tomorrow;
}

const ampsToKw = (a) => a * CFG.PHASES * CFG.VOLTAGE / 1000;

// --- ingest -----------------------------------------------------------------
// Car and wallbox values come from global context, written by the flow that receives them
integrate();

const g = (key) => {
    const v = global.get(key);
    return v === undefined || v === null ? null : v;
};

const socG = g(CFG.KEYS.soc);
if (socG !== null && Number(socG) !== s.soc) {
    // The bridge reports whole percent: keep the estimate if it is still inside the reported step
    const v = Number(socG);
    const est = s.soc === null ? null : s.soc + s.energyKwh * CFG.EFFICIENCY / CFG.CAPACITY_KWH * 100;
    s.energyKwh = est !== null && est >= v && est < v + 1 ? (est - v) / 100 * CFG.CAPACITY_KWH / CFG.EFFICIENCY : 0;
    s.soc = v;
}

const targetG = g(CFG.KEYS.target_soc);
s.target = targetG === null ? null : Number(targetG);

const currentG = g(CFG.KEYS.current);
if (currentG !== null) {
    s.measuredA = Number(currentG) * CFG.CURRENT_SCALE;
}

const wbG = g(CFG.KEYS.wallbox_status);
const st = wbG === null ? null : String(wbG).trim().toUpperCase().charAt(0);
if (st !== s.wallbox) {
    if (!PLUGGED.includes(st)) { s.lastSent = null; s.started = false; s.pluggedTs = null; }
    else if (s.pluggedTs === null) s.pluggedTs = now;
    s.wallbox = st;
}

// Away period: { start, end } in wall time; invalid or empty = none
const awayG = CFG.KEYS.away ? g(CFG.KEYS.away) : null;
const awayStart = awayG ? parseWallTime(awayG.start) : null;
const awayEnd = awayG ? parseWallTime(awayG.end) : null;
const away = awayStart !== null && awayEnd !== null && awayEnd > awayStart
    ? { start: awayStart, resume: Math.max(awayStart, awayEnd - CFG.AWAY_RESUME_MIN * 60000) }
    : null;
const isAway = away !== null && now >= away.start && now < away.resume;

const p = msg.payload;
if (msg.topic === "departure") {
    const d = parseDeparture(p);
    if (d) { s.departure = d; s.started = false; }
    else node.warn(`invalid departure: ${JSON.stringify(p)}`);
} else if (msg.topic === "smart_charging") {
    const on = p === true || p === 1 || p === "1" || p === "true" || p === "on";
    if (on !== s.enabled) { s.lastSent = null; s.started = false; }
    s.enabled = on;
}

// --- decide -----------------------------------------------------------------
const target = s.target ?? CFG.DEFAULT_TARGET;
const socEst = s.soc === null ? null
    : Math.min(100, s.soc + CFG.SOC_EST_MAX_AHEAD, s.soc + s.energyKwh * CFG.EFFICIENCY / CFG.CAPACITY_KWH * 100);
const depTs = nextDepartureTs();
const awayDeparture = away !== null && depTs === away.start;
const detail = { wallbox: s.wallbox, enabled: s.enabled, soc: s.soc, target, departure: new Date(depTs).toISOString(), awayDeparture };
let amps = null;
let reason;
let look;
let short;

if (isAway) {
    reason = `away, smart charging off until ${ddmm(away.resume)} ${hhmm(away.resume)}`;
    look = LOOK.away; short = `Away until ${ddmm(away.resume)}`;
} else if (!s.enabled) {
    reason = "smart charging off (manual)";
    look = LOOK.manual; short = "Manual";
} else if (!PLUGGED.includes(s.wallbox)) {
    reason = s.wallbox === null ? "waiting for wallbox status" : "not plugged in";
    look = LOOK.unplugged; short = s.wallbox === null ? "No wallbox data" : "Unplugged";
} else if (socEst === null && now - s.pluggedTs < CFG.SOC_WAIT_MIN * 60000) {
    amps = 0; reason = "waiting for SoC";
    look = LOOK.wait; short = "Waiting for SoC";
} else if (socEst === null) {
    amps = CFG.MAX_A; reason = "SoC unknown, full speed";
    look = LOOK.charge; short = `${amps} A · no SoC`;
} else if (socEst >= target) {
    amps = CFG.MIN_A; reason = "target reached";
    look = LOOK.done; short = "Full";
} else {
    const needKwh = (target - socEst) / 100 * CFG.CAPACITY_KWH / CFG.EFFICIENCY;
    const hoursLeft = (depTs - now - CFG.BUFFER_MIN * 60000) / 3600000;
    const hoursAtMin = needKwh / ampsToKw(CFG.MIN_A);
    const hoursAtMax = needKwh / ampsToKw(CFG.MAX_A);
    Object.assign(detail, {
        needKwh: +needKwh.toFixed(2), hoursLeft: +hoursLeft.toFixed(2),
        hoursAtMin: +hoursAtMin.toFixed(2), hoursAtMax: +hoursAtMax.toFixed(2),
    });

    if (hoursLeft <= hoursAtMax) {
        amps = CFG.MAX_A;
        detail.late = needKwh - Math.max(0, hoursLeft) * ampsToKw(CFG.MAX_A) > 0.1;
        reason = detail.late ? "full speed, will be late" : "full speed, tight";
        if (detail.late) {
            const hoursToDeparture = Math.max(0, (depTs - now) / 3600000);
            detail.socAtDeparture = Math.floor(Math.min(100,
                socEst + hoursToDeparture * ampsToKw(CFG.MAX_A) * CFG.EFFICIENCY / CFG.CAPACITY_KWH * 100));
            look = LOOK.late; short = `${detail.socAtDeparture} % at ${hhmm(depTs)}`;
        }
    } else {
        const reqA = needKwh / hoursLeft * 1000 / (CFG.PHASES * CFG.VOLTAGE);
        const last = s.lastSent || 0;
        if (last >= CFG.MIN_A && reqA <= last + CFG.AMP_HYST_UP_A && reqA > last - CFG.AMP_HYST_DOWN_A) {
            amps = last; reason = `holding (${reqA.toFixed(1)} A needed)`;
        } else if (reqA >= CFG.MIN_A) {
            amps = Math.min(CFG.MAX_A, Math.ceil(reqA)); reason = `modulating (${reqA.toFixed(1)} A needed)`;
        } else if (CFG.ALLOW_PAUSE && !s.started) {
            if (hoursLeft > hoursAtMin) {
                amps = 0;
                detail.plannedStart = hhmm(depTs - (CFG.BUFFER_MIN / 60 + hoursAtMin) * 3600000);
                reason = `waiting, start ~${detail.plannedStart}`;
                look = LOOK.wait; short = `Start ${detail.plannedStart}`;
            } else {
                amps = CFG.MIN_A; reason = "starting at minimum current";
            }
        } else {
            amps = CFG.MIN_A; reason = "minimum current";
        }
    }
    if (amps > 0) s.started = true;
    if (amps > 0 && !look) {
        detail.fullAt = hhmm(now + needKwh / ampsToKw(amps) * 3600000);
        look = LOOK.charge; short = `${amps} A · full ${detail.fullAt}`;
    }
}

detail.measuredA = s.measuredA;
detail.socEst = socEst === null ? null : +socEst.toFixed(1);
detail.amps = amps;
detail.reason = reason;
detail.summary = `${amps ?? "–"} A · ${reason} · SoC ${detail.socEst ?? "?"} % → ${target} % by ${hhmm(depTs)}${awayDeparture ? " (away)" : ""}`;
node.status({ fill: amps === 0 ? "yellow" : amps ? "green" : "grey", shape: "dot", text: detail.summary });
const html = `<i class="${look}" aria-hidden="true"></i> ${short}`;

let out1 = null;
if (amps !== null && amps !== s.lastSent) {
    out1 = { topic: "wallbox.set_current", payload: amps };
    s.lastSent = amps;
}
const d = s.departure || parseDeparture(CFG.DEFAULT_DEPARTURE);
const out3 = { topic: "departure", payload: awayDeparture ? hhmm(depTs) : `${String(d.h).padStart(2, "0")}:${String(d.m).padStart(2, "0")}` };
context.set("s", s);
return [out1, { topic: "departure_charging.status", payload: html, text: short, detail }, out3];
