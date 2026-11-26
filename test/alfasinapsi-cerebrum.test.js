"use strict";

// Esecuzione: node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { CEREBRUM_REGISTRY_KEY, getCerebrumRegistry } = require("../nodes/lib/cerebrumIntegration");
const { createAlfaSinapsiCerebrumIntegration } = require("../nodes/lib/alfasinapsi-cerebrum");

const reading = (overrides = {}) => ({
  power: { importkW: 1.2345, exportkW: 0, productionkW: 2.5, consumptionKW: 3.7345, surplusKW: 0 },
  energy: { importTotalkWh: 12345.67, exportTotalkWh: 890.12, productionTotalkWh: 4567.89 },
  tariffBand: 2,
  cutoff: { hasWarning: false, remainingSeconds: null, atIso: null },
  ...overrides
});

test("publishes meter readings read-only and reports cutoff warnings immediately", async () => {
  delete globalThis[CEREBRUM_REGISTRY_KEY];
  const integration = createAlfaSinapsiCerebrumIntegration({ nodeId: "tel1", title: "Contatore" });
  const provider = getCerebrumRegistry().providers.get("alfasinapsi:tel1");
  assert.equal(provider.adapterId, "alfasinapsi");
  assert.equal(provider.callService, undefined);
  assert.equal(provider.isReady(), false);

  const events = [];
  provider.subscribe((event) => events.push(event));
  integration.setConnected(true);
  integration.update(reading());
  assert.equal(provider.isReady(), true);
  const byId = Object.fromEntries((await provider.listEntities()).map((entity) => [entity.id, entity]));
  assert.equal(byId["tel1/power_import"].state, 1.235);
  assert.equal(byId["tel1/power_import"].unit, "kW");
  assert.equal(byId["tel1/energy_production"].state, 4567.9);
  assert.equal(byId["tel1/tariff_band"].state, "F2");
  assert.equal(byId["tel1/cutoff_warning"].state, "ok");
  assert.equal(events.length, 9);

  // A new power value within the minute is held back; the cutoff warning is not.
  integration.update(reading({ power: { importkW: 3.5, exportkW: 0, productionkW: 2.5, consumptionKW: 6, surplusKW: 0 }, cutoff: { hasWarning: true, remainingSeconds: 120, atIso: "2026-11-26T12:00:00Z" } }));
  const later = events.slice(9).map((event) => [event.entityId, event.state]);
  assert.deepEqual(later, [["tel1/cutoff_warning", "warning"]]);
  assert.equal((await provider.getEntity("tel1/cutoff_warning")).remainingSeconds, 120);

  integration.dispose();
  assert.equal(getCerebrumRegistry().providers.has("alfasinapsi:tel1"), false);
});
