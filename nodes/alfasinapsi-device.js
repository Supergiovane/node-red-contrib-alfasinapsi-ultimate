"use strict";

const ModbusRTU = require("modbus-serial");

module.exports = function (RED) {
  function AlfaSinapsiDeviceNode(config) {
    RED.nodes.createNode(this, config);

    const node = this;

    // Fixed settings (to match the stable Modbus client configuration)
    node.host = config.host;
    node.port = 502;
    node.unitId = 1;
    node.timeout = 1000;
    node.reconnectInterval = 2000;
    node.queueDelayMs = 1;

    // Addressing/decoding defaults matching the Home Assistant examples in `documents/`.
    node.baseAddress = "0"; // 0-based
    node.wordOrder = "hiLo";

    node._client = new ModbusRTU();
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
      node._client = new ModbusRTU();
    }

    async function connectOnce() {
      if (node._closing) return;
      if (node._connected) return;
      if (node._connectPromise) return node._connectPromise;

      node._connecting = true;
      node.emit("alfasinapsi:status", { connecting: true, connected: false });

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
              throw new Error("Connect timed out");
            })
          ]);
          node._client.setID(node.unitId);
          node._connected = true;
          node.emit("alfasinapsi:status", { connected: true });
        } catch (err) {
          node._connected = false;
          node.emit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });

          if (!node._closing && node._reconnectTimer == null) {
            node._reconnectTimer = setTimeout(() => {
              node._reconnectTimer = null;
              connectOnce().catch(() => undefined);
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
        throw new Error("Sinapsi Alfa not connected");
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

      // Important: do NOT let a previous rejection "poison" the queue forever.
      // Always run the next item, regardless of whether the previous one failed.
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
          node.emit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
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
          node.emit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
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
          node.emit("alfasinapsi:status", { connected: false, error: err?.message || String(err) });
          throw err;
        }
      });

    connectOnce().catch(() => undefined);

    node.on("close", async (removed, done) => {
      node._closing = true;
      if (node._reconnectTimer) clearTimeout(node._reconnectTimer);
      node._reconnectTimer = null;

      try {
        await destroyClient(node._client);
      } catch (_) {
        // ignore
      } finally {
        node._connected = false;
        done();
      }
    });
  }

  RED.nodes.registerType("alfasinapsi-device", AlfaSinapsiDeviceNode);
};
