# node-red-wallbox-charging

Departure-time charging for Node-RED: modulates the wallbox charge current so the car
reaches its target state of charge (SoC) exactly when you leave — instead of charging
at full power the moment it is plugged in.

- 0 A (pause) or 6–16 A, 3-phase — the IEC 61851 range a car accepts
- Starts as late as possible when even the minimum current would finish early
- Falls back to full power when time is short or data is missing
- Departure time set from the Node-RED dashboard, interpreted in a fixed time zone
  (works when Node-RED runs in UTC, e.g. in Docker)

Written for a KNX wallbox driven via [`node-red-contrib-knx-ultimate`](https://flows.nodered.org/node/node-red-contrib-knx-ultimate),
but the function itself only reads global context and emits a number, so any wallbox
integration that accepts a current setpoint in amps works.

## Contents

| File | Purpose |
|---|---|
| `departure-charging/departure-charging.js` | Function node code — source of truth |
| `departure-charging/flow.json` | Importable flow: function, 60 s tick, dashboard controls, rate limit, KNX write node |
| `departure-charging/build-flow.mjs` | Embeds the `.js` into `flow.json` |
| `departure-charging/test/simulate.mjs` | Simulated charging nights with assertions |

## How it works

Every minute the function computes:

1. **Energy needed:** `(target SoC − SoC) × capacity ÷ efficiency`
2. **Time left:** until departure, minus a buffer (default 45 min) for the slower top-off
3. **Current:** energy ÷ time ÷ (phases × 230 V), rounded up, clamped to 6–16 A

If the required current is below 6 A, it holds 0 A and starts at the latest moment
6 A still finishes in time (`ALLOW_PAUSE`; after the first start it never pauses again).
If the time is too short, it charges at 16 A.

Car SoC is usually reported in coarse steps (whole percent, every few minutes). Between
updates the function estimates the SoC from the measured wallbox current, capped at 2 %
above the last reported value. Hysteresis keeps the setpoint from toggling between
neighbouring amp values.

## Inputs

Read from **global context** — your existing flow stores the values there
(e.g. a function `global.set(msg.topic, msg.payload)` after each KNX node).
The keys are configurable in `CFG.KEYS`:

| Default key | Meaning |
|---|---|
| `car.soc` | current SoC in % |
| `car.target_soc` | target SoC in % (optional, defaults to 100) |
| `wallbox.status` | IEC 61851 state `A`–`F` (DPT 4.001) |
| `wallbox.current_power` | measured charge current per phase; set `CURRENT_SCALE` to its unit (0.1 for 0.1 A) |

Messages into the function node:

| `msg.topic` | `msg.payload` |
|---|---|
| `tick` | anything — sent every 60 s by the inject node |
| `departure` | milliseconds since midnight (dashboard time input) or `"HH:MM"` |
| `smart_charging` | `true` / `false` — `false` sends nothing, leaving the wallbox to manual control |

## Outputs

1. `msg.payload` = charge current in A, only when it changes → rate limit → wallbox setpoint
2. `msg.payload` = one-line status for the dashboard, `msg.detail` = full calculation
   (SoC estimate, energy needed, hours left, planned start, measured current)

## Setup

1. Node-RED → Menu → Import → `departure-charging/flow.json`
2. Open the node **Charge current setpoint**: select your KNX gateway and enter the
   group address of the wallbox current setpoint (DPT 14.019, amps)
3. Adjust `CFG` at the top of the function — at least `KEYS`, `CAPACITY_KWH`,
   `CURRENT_SCALE` and `TZ`
4. Deploy. The dashboard tab "Wallbox" shows departure time, the on/off switch and the
   current charge plan

Requires `node-red-dashboard` (1.x) for the dashboard nodes and
`node-red-contrib-knx-ultimate` for the write node.

## Development

```bash
node departure-charging/test/simulate.mjs   # simulate charging nights
node departure-charging/build-flow.mjs      # after editing departure-charging.js
```

## Limitations

- Pausing relies on the wallbox accepting 0 A as "pause". If yours does not, set
  `ALLOW_PAUSE: false` — it will then charge at 6 A and finish early.
- The car may stop on its own at its internal charge limit; the function then keeps
  6 A on the setpoint, which is harmless.
- Departure time and switch state live in memory; after a restart the inject nodes
  restore the defaults (07:00, on).
