"use strict";

const { readTelemetry } = require("./lib/alfasinapsi-telemetry");

module.exports = function (RED) {
  const COMPATIBILITY_TELEMETRY = "telemetry";
  const COMPATIBILITY_KNX_LOAD_CONTROL_PIN = "knxLoadControlPin";
  const KNX_LOAD_CONTROL_PIN_INTERVAL_MS = 10_000;

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
    node.sendOnChange = !!config.sendOnChange;
    node.compatibility = config.compatibility || COMPATIBILITY_TELEMETRY;

    const knxLoadControlPinEnabled = node.compatibility === COMPATIBILITY_KNX_LOAD_CONTROL_PIN;
    const telemetryEnabled = node.compatibility === COMPATIBILITY_TELEMETRY;

    node.pollInterval = Math.max(500, Number(config.pollInterval || 2000));
    if (knxLoadControlPinEnabled) {
      // Keep telemetry fresh enough for the 10s PIN output cadence.
      node.pollInterval = Math.min(node.pollInterval, KNX_LOAD_CONTROL_PIN_INTERVAL_MS);
    }

    if (!node.device) {
      node.status({ fill: "red", shape: "ring", text: "dispositivo non configurato" });
      return;
    }

    let lastPayload = null;
    let timer = null;
    let knxLoadControlPinTimer = null;
    let inFlight = false;
    let lastHasCutoffWarning = null;

    const onStatus = (s) => {
      if (s.connecting) node.status({ fill: "yellow", shape: "ring", text: "in connessione" });
      else if (s.connected) node.status({ fill: "green", shape: "dot", text: "connesso" });
      else node.status({ fill: "red", shape: "ring", text: s.error ? `errore: ${s.error}` : "disconnesso" });
    };
    node.device.on("alfasinapsi:status", onStatus);

    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const telemetry = await readTelemetry(node.device, { wordOrder: node.device.wordOrder });
        lastHasCutoffWarning = !!telemetry?.cutoff?.hasWarning;

        if (!telemetryEnabled) return;

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
        const text = /timed out/i.test(message) ? "timeout" : `errore: ${message}`;
        node.status({ fill: "red", shape: "ring", text: String(text).slice(0, 32) });
        node.error(message, {
          topic: "alfasinapsi/telemetry/error",
          payload: { message }
        });
      } finally {
        inFlight = false;
      }
    }

    if (knxLoadControlPinEnabled) {
      knxLoadControlPinTimer = setInterval(() => {
        if (lastHasCutoffWarning == null) return;
        const shedding = lastHasCutoffWarning ? "shed" : "unshed";
        node.send({
          topic: "alfasinapsi/telemetry/knx-load-control-pin",
          payload: shedding,
          shedding
        });
      }, KNX_LOAD_CONTROL_PIN_INTERVAL_MS);
    }

    timer = setInterval(tick, node.pollInterval);
    tick().catch(() => undefined);

    node.on("close", (removed, done) => {
      if (timer) clearInterval(timer);
      timer = null;
      if (knxLoadControlPinTimer) clearInterval(knxLoadControlPinTimer);
      knxLoadControlPinTimer = null;
      node.device?.off?.("alfasinapsi:status", onStatus);
      done();
    });
  }

  RED.nodes.registerType("alfasinapsi-telemetry", AlfaSinapsiTelemetryNode);
};
