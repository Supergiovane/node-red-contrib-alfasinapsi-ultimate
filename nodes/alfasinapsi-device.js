"use strict";

let ModbusRTU;
try {
  ModbusRTU = require("modbus-serial");
} catch (_) {
  ModbusRTU = null;
}

module.exports = function (RED) {
  function AlfaSinapsiDeviceNode(config) {
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

    const safeEmit = (event, payload) => {
      try {
        node.emit(event, payload);
      } catch (err) {
        reportError(err, `emit ${event}`);
      }
    };

    if (!ModbusRTU) {
      reportError(new Error("Dipendenza mancante: modbus-serial"), "init");
      return;
    }

    // Impostazioni fisse (per stabilita)
    node.host = config.host;
    node.port = 502;
    node.unitId = 1;
    node.timeout = 1000;
    node.reconnectInterval = 2000;
    node.queueDelayMs = 1;

    // Addressing/decoding defaults matching the Home Assistant examples in `documents/`.
    node.baseAddress = "0"; // 0-based
    node.wordOrder = "hiLo";

    try {
      node._client = new ModbusRTU();
    } catch (err) {
      reportError(err, "init client");
      return;
    }
    node._connected = false;
    node._connecting = false;
    node._connectPromise = null;
    node._queue = Promise.resolve();
    node._reconnectTimer = null;
    node._closing = false;

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function destroyClient(client) {
      if (!client) return;
      try {
        const sock = client._port && client._port._client;
        if (sock && !sock.destroyed) sock.destroy();
      } catch (_) {
        // ignore
      }
      try {
        await client.close();
      } catch (_) {
        // ignore
      }
    }

    const toZeroBased = (address) => {
      const a = Number(address);
      if (node.baseAddress === "1") return Math.max(0, a - 1);
      return a;
    };

    async function resetClient() {
      const old = node._client;
      await destroyClient(old);
      try {
        node._client = new ModbusRTU();
      } catch (err) {
        node._client = null;
        throw err;
      }
    }

    async function connectOnce() {
      if (node._closing) return;
      if (node._connected) return;
      if (node._connectPromise) return node._connectPromise;

      node._connecting = true;
      safeEmit("alfasinapsi:status", { connecting: true, connected: false });

      node._connectPromise = (async () => {
        try {
          // Ensure we reconnect from a clean state.
          await resetClient();
          if (node._closing) return;
          node._client.setTimeout(node.timeout);
          const connectPromise = node._client.connectTCP(node.host, { port: node.port });
          const connectTimeoutMs = node.timeout;
          await Promise.race([
            connectPromise,
            delay(connectTimeoutMs).then(() => {
              throw new Error("Timeout connessione");
            })
          ]);
          node._client.setID(node.unitId);
          node._connected = true;
          safeEmit("alfasinapsi:status", { connected: true });
        } catch (err) {
          node._connected = false;
          safeEmit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });

          if (!node._closing && node._reconnectTimer == null) {
            node._reconnectTimer = setTimeout(() => {
              try {
                node._reconnectTimer = null;
                connectOnce().catch(() => undefined);
              } catch (err) {
                reportError(err, "reconnect timer");
              }
            }, node.reconnectInterval);
          }
        } finally {
          node._connecting = false;
          node._connectPromise = null;
        }
      })();

      return node._connectPromise;
    }

    async function ensureConnected() {
      if (node._connected) return;
      await connectOnce();
      if (!node._connected) {
        throw new Error("Sinapsi Alfa non connesso");
      }
    }

    node._enqueue = (fn) => {
      const run = async () => {
        try {
          const res = await fn();
          if (node.queueDelayMs > 0) await delay(node.queueDelayMs);
          return res;
        } catch (err) {
          if (node.queueDelayMs > 0) await delay(node.queueDelayMs);
          throw err;
        }
      };

      // Importante: non lasciare che un errore precedente "avveleni" la coda per sempre.
      // Esegui sempre l'elemento successivo, anche se il precedente e' fallito.
      node._queue = node._queue.then(run, run);
      return node._queue;
    };

    node.readHoldingRegisters = (address, length) =>
      node._enqueue(async () => {
        await ensureConnected();
        try {
          return await node._client.readHoldingRegisters(toZeroBased(address), Number(length));
        } catch (err) {
          node._connected = false;
          await resetClient();
          safeEmit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
          throw err;
        }
      });

    node.writeCoil = (address, value) =>
      node._enqueue(async () => {
        await ensureConnected();
        try {
          return await node._client.writeCoil(toZeroBased(address), !!value);
        } catch (err) {
          node._connected = false;
          await resetClient();
          safeEmit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
          throw err;
        }
      });

    node.writeRegister = (address, value) =>
      node._enqueue(async () => {
        await ensureConnected();
        try {
          return await node._client.writeRegister(toZeroBased(address), Number(value));
        } catch (err) {
          node._connected = false;
          await resetClient();
          safeEmit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
          throw err;
        }
      });

    connectOnce().catch(() => undefined);

    node.on("close", (removed, done) => {
      (async () => {
        try {
          node._closing = true;
          if (node._reconnectTimer) clearTimeout(node._reconnectTimer);
          node._reconnectTimer = null;
          await destroyClient(node._client);
        } catch (err) {
          reportError(err, "close");
        } finally {
          node._connected = false;
        }
      })()
        .catch((err) => reportError(err, "close(unhandled)"))
        .finally(() => {
          try {
            done();
          } catch (_) {
            // ignore
          }
        });
    });
  }

  try {
    RED.nodes.registerType("alfasinapsi-device", AlfaSinapsiDeviceNode);
  } catch (err) {
    try {
      RED.log?.error?.(err?.stack || err?.message || String(err));
    } catch (_) {
      // ignore
    }
  }
};
