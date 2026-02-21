"use strict";

let readTelemetry;
try {
  ({ readTelemetry } = require("./lib/alfasinapsi-telemetry"));
} catch (_) {
  readTelemetry = null;
}

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
    try {
      RED.nodes.createNode(this, config);
    } catch (err) {
      try {
        RED.log?.error?.(err?.stack || err?.message || String(err));
      } catch (_) {
        // ignore
      }
      return;
    }

    const node = this;

    const reportError = (err, context) => {
      const text = err?.stack || err?.message || String(err);
      const msg = context ? `${context}: ${text}` : text;
      try {
        node.error(msg);
      } catch (_) {
        try {
          RED.log?.error?.(msg);
        } catch (_) {
          // ignore
        }
      }
    };

    const safeStatus = (status) => {
      try {
        node.status(status);
      } catch (_) {
        // ignore
      }
    };

    const safeSend = (msg) => {
      try {
        node.send(msg);
      } catch (err) {
        reportError(err, "send");
      }
    };

    try {
      if (typeof readTelemetry !== "function") {
        safeStatus({ fill: "red", shape: "ring", text: "errore inizializzazione" });
        reportError(new Error("readTelemetry non disponibile"), "init");
        return;
      }

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
        safeStatus({ fill: "red", shape: "ring", text: "dispositivo non configurato" });
        return;
      }

      let lastPayload = null;
      let timer = null;
      let knxLoadControlPinTimer = null;
      let inFlight = false;
      let lastHasCutoffWarning = null;

      const onStatus = (s) => {
        try {
          if (s.connecting) safeStatus({ fill: "yellow", shape: "ring", text: "in connessione" });
          else if (s.connected) safeStatus({ fill: "green", shape: "dot", text: "connesso" });
          else safeStatus({ fill: "red", shape: "ring", text: s.error ? `errore: ${s.error}` : "disconnesso" });
        } catch (err) {
          reportError(err, "onStatus");
        }
      };
      try {
        node.device.on("alfasinapsi:status", onStatus);
      } catch (err) {
        reportError(err, "device.on");
      }

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
          safeSend({ topic: "alfasinapsi/telemetry", payload, insight });
        } catch (err) {
          const message = err?.message || String(err);
          const text = /timed out/i.test(message) ? "timeout" : `errore: ${message}`;
          safeStatus({ fill: "red", shape: "ring", text: String(text).slice(0, 32) });
          try {
            node.error(message, {
              topic: "alfasinapsi/telemetry/error",
              payload: { message }
            });
          } catch (err2) {
            reportError(err2, "node.error");
          }
        } finally {
          inFlight = false;
        }
      }

      if (knxLoadControlPinEnabled) {
        knxLoadControlPinTimer = setInterval(() => {
          try {
            if (lastHasCutoffWarning == null) return;
            const shedding = lastHasCutoffWarning ? "shed" : "unshed";
            safeSend({
              topic: "alfasinapsi/telemetry/knx-load-control-pin",
              payload: shedding,
              shedding
            });
          } catch (err) {
            reportError(err, "knx interval");
          }
        }, KNX_LOAD_CONTROL_PIN_INTERVAL_MS);
      }

      timer = setInterval(() => {
        tick().catch((err) => reportError(err, "tick(unhandled)"));
      }, node.pollInterval);
      tick().catch((err) => reportError(err, "tick(first)"));

      node.on("close", (removed, done) => {
        try {
          if (timer) clearInterval(timer);
          timer = null;
          if (knxLoadControlPinTimer) clearInterval(knxLoadControlPinTimer);
          knxLoadControlPinTimer = null;
          try {
            node.device?.off?.("alfasinapsi:status", onStatus);
          } catch (err) {
            reportError(err, "device.off");
          }
        } catch (err) {
          reportError(err, "close");
        } finally {
          try {
            done();
          } catch (_) {
            // ignore
          }
        }
      });
    } catch (err) {
      safeStatus({ fill: "red", shape: "ring", text: "errore" });
      reportError(err, "constructor");
    }
  }

  try {
    RED.nodes.registerType("alfasinapsi-telemetry", AlfaSinapsiTelemetryNode);
  } catch (err) {
    try {
      RED.log?.error?.(err?.stack || err?.message || String(err));
    } catch (_) {
      // ignore
    }
  }
};
