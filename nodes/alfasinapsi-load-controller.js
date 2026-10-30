"use strict";

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

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

module.exports = function (RED) {
  function AlfaSinapsiLoadControllerNode(config) {
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
      const loads = safeJsonParse(config.loads, []);
      node._loads = Array.isArray(loads) ? loads : [];
      // Minimo intervallo (minuti) tra l'ultimo cambio di stage e il successivo unshed. 0 = a ogni messaggio.
      node.unshedDelayMin = Math.max(0, Number(config.unshedDelayMin || 0));
      const unshedDelayMs = node.unshedDelayMin * 60 * 1000;

      let currentStatus = { connected: false, connecting: false, error: null, ts: Date.now() };

      const normaliseStatus = (s) => {
        const connected = !!s?.connected;
        const connecting = !!s?.connecting;
        const error = s?.error ? String(s.error) : null;
        return { connected, connecting, error, ts: Date.now() };
      };

      const stateByName = new Map();
      for (const load of node._loads) {
        if (!load || !load.name) continue;
        if (stateByName.has(load.name)) continue;
        // Start with "enabled" and initialize timers from startup time,
        // so Min acceso/spento are respected even right after a deploy/restart.
        stateByName.set(load.name, { enabled: true, lastChangeMs: nowMs() });
      }

      // Millisecondi mancanti prima che il carico possa commutare (0 = puo commutare subito).
      function toggleWaitMs(load, st, nextEnabled) {
        const minOnMs = Math.max(0, Number(load.minOnSec || 0)) * 1000;
        const minOffMs = Math.max(0, Number(load.minOffSec || 0)) * 1000;
        const elapsed = nowMs() - (st.lastChangeMs || 0);

        if (nextEnabled === false && st.enabled === true) {
          return Math.max(0, minOnMs - elapsed);
        }
        if (nextEnabled === true && st.enabled === false) {
          return Math.max(0, minOffMs - elapsed);
        }
        return 0;
      }

      let pendingWaitMs = null;

      function setEnabled(load, enabled) {
        const st = stateByName.get(load.name);
        if (!st) return null;
        if (st.enabled === enabled) return null;
        const waitMs = toggleWaitMs(load, st, enabled);
        if (waitMs > 0) {
          pendingWaitMs = pendingWaitMs == null ? waitMs : Math.min(pendingWaitMs, waitMs);
          return null;
        }

        st.enabled = enabled;
        st.lastChangeMs = nowMs();

        return {
          topic: String(load.name),
          payload: !!enabled
        };
      }

      let stage = 0;
      let lastStageChangeMs = nowMs();
      let reapplyTimer = null;

      function computeDesiredEnabledByName(stageValue) {
        const maxStage = node._loads.length;
        const clamped = clampInt(stageValue, 0, maxStage);
        const order = [...node._loads].filter((l) => l && l.name);
        const shedSet = new Set(order.slice(0, clamped).map((l) => l.name));
        const desiredEnabledByName = new Map();
        for (const load of node._loads) {
          if (!load || !load.name) continue;
          desiredEnabledByName.set(load.name, !shedSet.has(load.name));
        }
        return { desiredEnabledByName, stage: clamped, maxStage };
      }

      function applyStage() {
        if (reapplyTimer) clearTimeout(reapplyTimer);
        reapplyTimer = null;
        pendingWaitMs = null;

        const desired = computeDesiredEnabledByName(stage);
        stage = desired.stage;

        const outputs = Math.max(1, node._loads.length);
        const out = new Array(outputs).fill(null);

        // Per ogni carico, applica lo stato desiderato (solo se cambia e i timer lo permettono).
        node._loads.forEach((load, idx) => {
          if (!load || !load.name) return;
          const wantedEnabled = desired.desiredEnabledByName.get(load.name);
          if (typeof wantedEnabled !== "boolean") return;
          const msg = setEnabled(load, wantedEnabled);
          if (msg) {
            out[idx] = msg;
          }
        });

        if (out.some((m) => m != null)) safeSend(out);

        // Se un timer Min acceso/spento ha bloccato una commutazione, riprova appena scade
        // (senza attendere il prossimo messaggio in ingresso).
        if (pendingWaitMs != null) {
          reapplyTimer = setTimeout(() => {
            reapplyTimer = null;
            try {
              applyStage();
            } catch (err) {
              reportError(err, "reapply");
            }
          }, pendingWaitMs + 50);
        }
      }

      function updateStageFromSignal(signal) {
        const maxStage = node._loads.length;
        const prevStage = stage;
        if (signal === "shed") stage = clampInt(stage + 1, 0, maxStage);
        if (signal === "unshed" && nowMs() - lastStageChangeMs >= unshedDelayMs) {
          stage = clampInt(stage - 1, 0, maxStage);
        }
        // Il ritardo unshed parte dall'ultimo shed ricevuto (allarme ancora attivo) o dall'ultimo cambio di stage.
        if (signal === "shed" || stage !== prevStage) lastStageChangeMs = nowMs();

        const text = `stage ${stage}/${maxStage}`;
        if (currentStatus?.connecting) safeStatus({ fill: "yellow", shape: "ring", text });
        else if (currentStatus?.connected) safeStatus({ fill: stage > 0 ? "yellow" : "green", shape: "dot", text });
        else safeStatus({ fill: stage > 0 ? "yellow" : "red", shape: "ring", text });

        applyStage();
      }

      function updateStatusFromMsg(msg) {
        if (!msg || typeof msg !== "object") return;
        if (!msg.status || typeof msg.status !== "object") return;
        currentStatus = normaliseStatus(msg.status);
      }

      function normaliseSignalString(value) {
        if (typeof value !== "string") return null;
        const v = value.trim().toLowerCase();
        return v === "shed" || v === "unshed" ? v : null;
      }

      // Formati accettati:
      // - Telemetria completa: msg.payload.cutoff.hasWarning (boolean)
      // - KNX Load Control PIN: msg.payload / msg.shedding = "shed" | "unshed"
      // - PIN cutoff.hasWarning (o qualsiasi boolean): msg.payload true = shed, false = unshed
      function extractSignal(msg) {
        if (!msg || typeof msg !== "object") return null;
        if (typeof msg.payload?.cutoff?.hasWarning === "boolean") return msg.payload.cutoff.hasWarning ? "shed" : "unshed";
        const fromString = normaliseSignalString(msg.payload) || normaliseSignalString(msg.shedding);
        if (fromString) return fromString;
        if (typeof msg.payload === "boolean") return msg.payload ? "shed" : "unshed";
        return null;
      }

      node.on("input", (msg, send, done) => {
        try {
          updateStatusFromMsg(msg);

          const signal = extractSignal(msg);
          if (signal) {
            updateStageFromSignal(signal);
            return;
          }
        } catch (err) {
          reportError(err, "input");
        } finally {
          try {
            done();
          } catch (_) {
            // ignore
          }
        }
      });

      // Stato iniziale (nessun comando emesso finche non arriva un messaggio).
      safeStatus({ fill: "grey", shape: "ring", text: `stage ${stage}/${node._loads.length}` });

      node.on("close", (removed, done) => {
        if (reapplyTimer) clearTimeout(reapplyTimer);
        reapplyTimer = null;
        try {
          done();
        } catch (_) {
          // ignore
        }
      });
    } catch (err) {
      safeStatus({ fill: "red", shape: "ring", text: "errore" });
      reportError(err, "constructor");
    }
  }

  try {
    RED.nodes.registerType("alfasinapsi-load-controller", AlfaSinapsiLoadControllerNode);
  } catch (err) {
    try {
      RED.log?.error?.(err?.stack || err?.message || String(err));
    } catch (_) {
      // ignore
    }
  }
};
