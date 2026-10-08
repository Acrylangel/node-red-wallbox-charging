// Embeds departure-charging.js into flow.json (the function node's "func").
// departure-charging.js is the source of truth — edit it, then run:
//   node departure-charging/build-flow.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const func = readFileSync(here("./departure-charging.js"), "utf8");
new Function("msg", "context", "global", "node", func); // syntax check

const flow = JSON.parse(readFileSync(here("./flow.json"), "utf8"));
const nodes = flow.filter((n) => n.type === "function" && n.name === "Departure charging");
if (nodes.length !== 1) throw new Error(`expected 1 "Departure charging" function node, found ${nodes.length}`);
nodes[0].func = func;
writeFileSync(here("./flow.json"), JSON.stringify(flow, null, 2) + "\n");
console.log("flow.json updated");
