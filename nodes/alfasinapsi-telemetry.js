"use strict";

const { readTelemetry } = require("./lib/alfasinapsi-telemetry");

module.exports = function (RED) {
  function wToKw(valueW) {
    return Number(valueW ?? 0) / 1000;
  }

  function whToKwh(valueWh) {
    return Number(valueWh ?? 0) / 1000;
  }

  function simplifyTelemetry(telemetry) {
    return {
      power: {
        importkW: wToKw(telemetry?.power?.importW),
        exportkW: wToKw(telemetry?.power?.exportW),
        productionkW: wToKw(telemetry?.power?.productionW)
      },
      energy: {
        importTotalkWh: whToKwh(telemetry?.energy?.importTotalWh),
        exportTotalkWh: whToKwh(telemetry?.energy?.exportTotalWh),
        productionTotalkWh: whToKwh(telemetry?.energy?.productionTotalWh)
      },
      tariffBand: Number(telemetry?.tariffBand ?? 0),
      cutoff: {
        hasWarning: !!telemetry?.cutoff?.hasWarning,
        atIso: telemetry?.cutoff?.atIso ?? null
      }
    };
  }

  function AlfaSinapsiTelemetryNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;
    node.device = RED.nodes.getNode(config.device);
    node.pollInterval = Math.max(500, Number(config.pollInterval || 2000));
    node.sendOnChange = !!config.sendOnChange;

    if (!node.device) {
      node.status({ fill: "red", shape: "ring", text: "device not configured" });
      return;
    }

    let lastPayload = null;
    let timer = null;
    let inFlight = false;

    const onStatus = (s) => {
      if (s.connecting) node.status({ fill: "yellow", shape: "ring", text: "connecting" });
      else if (s.connected) node.status({ fill: "green", shape: "dot", text: "connected" });
      else node.status({ fill: "red", shape: "ring", text: s.error ? `error: ${s.error}` : "disconnected" });
    };
    node.device.on("alfasinapsi:status", onStatus);

    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const telemetry = await readTelemetry(node.device, { wordOrder: node.device.wordOrder });
        const payload = simplifyTelemetry(telemetry);
        const insight = {
          telemetry,
          meta: {
            ts: telemetry?.ts ?? Date.now(),
            functionCode: 3,
            readMode: node.device?._alfasinapsiTelemetryMode || "group"
          },
          device: {
            host: node.device?.host,
            port: 502,
            unitId: 1,
            timeoutMs: 1000,
            reconnectTimeoutMs: 2000,
            queueDelayMs: 1
          }
        };

        if (node.sendOnChange && lastPayload) {
          const same = JSON.stringify(payload) === JSON.stringify(lastPayload);
          if (same) return;
        }

        lastPayload = payload;
        node.send({ topic: "alfasinapsi/telemetry", payload, insight });
      } catch (err) {
        const message = err?.message || String(err);
        const text = /timed out/i.test(message) ? "timeout" : `error: ${message}`;
        node.status({ fill: "red", shape: "ring", text: String(text).slice(0, 32) });
        node.error(message, {
          topic: "alfasinapsi/telemetry/error",
          payload: { message }
        });
      } finally {
        inFlight = false;
      }
    }

    timer = setInterval(tick, node.pollInterval);
    tick().catch(() => undefined);

    node.on("close", (removed, done) => {
      if (timer) clearInterval(timer);
      timer = null;
      node.device?.off?.("alfasinapsi:status", onStatus);
      done();
    });
  }

  RED.nodes.registerType("alfasinapsi-telemetry", AlfaSinapsiTelemetryNode);
};
