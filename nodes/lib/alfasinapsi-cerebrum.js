"use strict";

// Publica le letture di un nodo telemetria AlfaSinapsi su Cerebrum Ultimate,
// in sola lettura: potenze, energie, fascia oraria e preavviso di distacco.
// Publishes AlfaSinapsi telemetry to Cerebrum Ultimate (read-only).

const { registerCerebrumIntegration } = require("./cerebrumIntegration");

const round = (value, decimals) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
};

// simplified: result of simplifyTelemetry() in the telemetry node.
function buildAlfaSinapsiEntities(baseId, simplified) {
  const s = simplified || {};
  const power = s.power || {};
  const energy = s.energy || {};
  const cutoff = s.cutoff || {};
  const measure = (key, name, kind, unit, value, decimals) => ({ id: `${baseId}/${key}`, name, kind, capability: "measurement", unit, state: round(value, decimals) });
  return [
    measure("power_import", "Potenza prelevata dalla rete", "power", "kW", power.importkW, 3),
    measure("power_export", "Potenza immessa in rete", "power", "kW", power.exportkW, 3),
    measure("power_production", "Potenza prodotta", "power", "kW", power.productionkW, 3),
    measure("power_consumption", "Potenza consumata in casa", "power", "kW", power.consumptionKW, 3),
    measure("energy_import", "Energia prelevata totale", "energy", "kWh", energy.importTotalkWh, 1),
    measure("energy_export", "Energia immessa totale", "energy", "kWh", energy.exportTotalkWh, 1),
    measure("energy_production", "Energia prodotta totale", "energy", "kWh", energy.productionTotalkWh, 1),
    { id: `${baseId}/tariff_band`, name: "Fascia oraria", kind: "tariff", capability: "status", state: s.tariffBand ? `F${s.tariffBand}` : "unknown" },
    {
      id: `${baseId}/cutoff_warning`,
      name: "Preavviso distacco contatore",
      kind: "power_cutoff",
      capability: "alarm",
      state: cutoff.hasWarning ? "warning" : "ok",
      remainingSeconds: cutoff.hasWarning ? cutoff.remainingSeconds : null,
      atIso: cutoff.atIso || null
    }
  ];
}

function createAlfaSinapsiCerebrumIntegration({ nodeId, title, packageName = "node-red-contrib-alfasinapsi-ultimate" }) {
  let entities = [];
  let connected = false;
  const integration = registerCerebrumIntegration({
    adapter: {
      id: "alfasinapsi",
      title: "AlfaSinapsi energy meter",
      packageName,
      kind: "energy",
      capabilities: ["power", "energy", "tariff-band", "cutoff-warning"],
      access: "observe",
      operations: [
        { id: "list-entities", description: "Electricity meter (Sinapsi Alfa): power drawn from the grid, fed into the grid, produced and consumed (kW); total energy drawn, fed in and produced (kWh); tariff band (F1/F2/F3); meter cutoff warning (ok/warning, with remaining seconds before the supply is cut). Read-only." },
        { id: "read-entity", description: "Current value of one AlfaSinapsi measurement by its exact id." }
      ]
    },
    provider: {
      id: `alfasinapsi:${nodeId}`,
      title: title || "AlfaSinapsi",
      ownerNodeId: nodeId,
      isReady: () => connected && entities.length > 0,
      listEntities: async () => entities.map((entity) => ({ ...entity })),
      getEntity: async (id) => {
        const entity = entities.find((candidate) => candidate.id === String(id || ""));
        return entity ? { ...entity } : null;
      }
    },
    // The meter is polled every few seconds: one update per minute per value.
    minIntervalMs: 60 * 1000
  });

  function update(simplified) {
    connected = true;
    entities = buildAlfaSinapsiEntities(nodeId, simplified);
    entities.forEach((entity) => {
      const details = { ...entity };
      ["id", "name", "kind", "capability", "state", "unit"].forEach((key) => delete details[key]);
      integration.emit({
        entityId: entity.id,
        state: entity.state,
        resourceName: entity.name,
        resourceType: "alfasinapsi",
        kind: entity.kind,
        capability: entity.capability,
        unit: entity.unit,
        details
      });
    });
  }

  return {
    update,
    setConnected: (value) => { connected = !!value; },
    entities: () => entities,
    provider: integration.provider,
    dispose: integration.dispose
  };
}

module.exports = { buildAlfaSinapsiEntities, createAlfaSinapsiCerebrumIntegration };
