"use strict";

const { readTelemetry } = require("./lib/alfasinapsi-telemetry");

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function nowMs() {
  return Date.now();
}

module.exports = function (RED) {
  function AlfaSinapsiLoadControllerNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.device = RED.nodes.getNode(config.device);

    node.pollInterval = Math.max(500, Number(config.pollInterval || 2000));
    node.mode = config.mode || "both"; // surplus | limit | both
    node.surplusReserveW = Math.max(0, Number(config.surplusReserveW || 200));
    node.surplusHysteresisW = Math.max(0, Number(config.surplusHysteresisW || 100));
    node.maxImportW = Math.max(0, Number(config.maxImportW || 3000));
    node.importHysteresisW = Math.max(0, Number(config.importHysteresisW || 150));
    node.forceOffOnCutoff = (config.forceOffOnCutoff ?? config.forceOffOnDistacco) !== false;

    const loads = safeJsonParse(config.loads, []);
    node._loads = Array.isArray(loads) ? loads : [];

    if (!node.device) {
      node.status({ fill: "red", shape: "ring", text: "device not configured" });
      return;
    }

    const stateByName = new Map();
    for (const load of node._loads) {
      stateByName.set(load.name, {
        desired: false,
        lastChangeMs: 0
      });
    }

    const onStatus = (s) => {
      if (s.connecting) node.status({ fill: "yellow", shape: "ring", text: "connecting" });
      else if (s.connected) node.status({ fill: "green", shape: "dot", text: "connected" });
      else node.status({ fill: "red", shape: "ring", text: s.error ? `error: ${s.error}` : "disconnected" });
    };
    node.device.on("alfasinapsi:status", onStatus);

    function canToggle(load, st, desired) {
      const minOnMs = Math.max(0, Number(load.minOnSec || 0)) * 1000;
      const minOffMs = Math.max(0, Number(load.minOffSec || 0)) * 1000;
      const elapsed = nowMs() - (st.lastChangeMs || 0);

      if (desired === false && st.desired === true) {
        // turning off
        if (elapsed < minOnMs) return false;
      }
      if (desired === true && st.desired === false) {
        // turning on
        if (elapsed < minOffMs) return false;
      }
      return true;
    }

    function setDesired(load, desired, reason, telemetry) {
      const st = stateByName.get(load.name);
      if (!st) return null;
      if (st.desired === desired) return null;
      if (!canToggle(load, st, desired)) return null;

      st.desired = desired;
      st.lastChangeMs = nowMs();

      const msg = {
        topic: `load/${load.name}`,
        payload: desired,
        load: load.name,
        reason,
        telemetry
      };
      return msg;
    }

    function sortForShedding(a, b) {
      const pa = Number(a.priority ?? 100);
      const pb = Number(b.priority ?? 100);
      if (pa !== pb) return pb - pa; // lower priority first
      return Number(b.powerW ?? 0) - Number(a.powerW ?? 0);
    }

    function sortForEnabling(a, b) {
      const pa = Number(a.priority ?? 100);
      const pb = Number(b.priority ?? 100);
      if (pa !== pb) return pa - pb; // higher priority first
      return Number(a.powerW ?? 0) - Number(b.powerW ?? 0);
    }

    function computeActions(telemetry) {
      const actions = [];
      const importW = Number(telemetry?.power?.importW || 0);
      const exportW = Number(telemetry?.power?.exportW || 0);

      const hasCutoff = !!telemetry?.cutoff?.hasWarning;
      if (hasCutoff && node.forceOffOnCutoff) {
        for (const load of node._loads) {
          const msg = setDesired(load, false, "cutoff_notice", telemetry);
          if (msg) actions.push({ output: 1 + node._loads.indexOf(load), msg });
        }
        return actions;
      }

      if (node.mode === "limit" || node.mode === "both") {
        const limit = node.maxImportW;
        const stopAt = Math.max(0, limit - node.importHysteresisW);

        let estimatedImportW = importW;
        const onLoads = node._loads.filter((l) => stateByName.get(l.name)?.desired);
        const shedList = [...onLoads].sort(sortForShedding);

        while (estimatedImportW > stopAt && shedList.length) {
          const load = shedList.shift();
          const msg = setDesired(load, false, "import_limit", telemetry);
          if (msg) {
            actions.push({ output: 1 + node._loads.indexOf(load), msg });
            estimatedImportW -= Number(load.powerW || 0);
          } else {
            // non toggleabile ora: salta
          }
        }
      }

      if (node.mode === "surplus" || node.mode === "both") {
        const enableList = [...node._loads].sort(sortForEnabling);

        // exportW ~ surplus to the grid, so it can be used for loads
        let availableW = Math.max(0, exportW - node.surplusReserveW);
        const targetW = Math.max(0, availableW + node.surplusHysteresisW);

        for (const load of enableList) {
          const st = stateByName.get(load.name);
          if (!st) continue;
          if (st.desired) continue;
          const p = Number(load.powerW || 0);
          if (p <= 0) continue;

          const usedW = enableList
            .filter((l) => stateByName.get(l.name)?.desired)
            .reduce((sum, l) => sum + Number(l.powerW || 0), 0);

          if (usedW + p <= targetW) {
            const msg = setDesired(load, true, "surplus", telemetry);
            if (msg) actions.push({ output: 1 + node._loads.indexOf(load), msg });
          }
        }

        // se surplus sparisce, spegni i meno prioritari
        const totalOnW = enableList
          .filter((l) => stateByName.get(l.name)?.desired)
          .reduce((sum, l) => sum + Number(l.powerW || 0), 0);

        if (totalOnW > availableW) {
          const shedList = enableList.filter((l) => stateByName.get(l.name)?.desired).sort(sortForShedding);
          let targetOnW = Math.max(0, availableW);
          let runningOnW = totalOnW;

          while (runningOnW > targetOnW && shedList.length) {
            const load = shedList.shift();
            const msg = setDesired(load, false, "surplus_drop", telemetry);
            if (msg) {
              actions.push({ output: 1 + node._loads.indexOf(load), msg });
              runningOnW -= Number(load.powerW || 0);
            }
          }
        }
      }

      return actions;
    }

    let timer = null;
    let inFlight = false;
    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const telemetry = await readTelemetry(node.device, { wordOrder: node.device.wordOrder });

        const summary = {
          ts: telemetry.ts,
          power: telemetry.power,
          cutoff: telemetry.cutoff,
          mode: node.mode,
          loads: node._loads.map((l) => ({
            name: l.name,
            desired: !!stateByName.get(l.name)?.desired,
            powerW: Number(l.powerW || 0),
            priority: Number(l.priority ?? 100)
          }))
        };

        const out = new Array(1 + node._loads.length).fill(null);
        out[0] = { topic: "alfasinapsi/controller", payload: summary };

        const actions = computeActions(telemetry);
        for (const action of actions) {
          out[action.output] = action.msg;
        }

        node.send(out);
      } catch (err) {
        const message = err?.message || String(err);
        const text = /timed out/i.test(message) ? "timeout" : `error: ${message}`;
        node.status({ fill: "red", shape: "ring", text: String(text).slice(0, 32) });
        node.error(message, {
          topic: "alfasinapsi/controller/error",
          payload: { message }
        });
      } finally {
        inFlight = false;
      }
    }

    node.on("input", (msg, send, done) => {
      // Quick override: msg.topic = "load/<name>" and boolean payload => set desired
      try {
        if (typeof msg?.topic === "string" && msg.topic.startsWith("load/")) {
          const name = msg.topic.slice("load/".length);
          const st = stateByName.get(name);
          const load = node._loads.find((l) => l.name === name);
          if (st && load && typeof msg.payload === "boolean") {
            if (canToggle(load, st, msg.payload)) {
              st.desired = msg.payload;
              st.lastChangeMs = nowMs();
            }
          }
        }
      } catch (_) {
        // ignore
      } finally {
        done();
      }
    });

    timer = setInterval(tick, node.pollInterval);
    tick().catch(() => undefined);

    node.on("close", (removed, done) => {
      if (timer) clearInterval(timer);
      timer = null;
      node.device?.off?.("alfasinapsi:status", onStatus);
      done();
    });
  }

  RED.nodes.registerType("alfasinapsi-load-controller", AlfaSinapsiLoadControllerNode);
};
