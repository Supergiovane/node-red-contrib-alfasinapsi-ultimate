"use strict";

// Registers taken from the Home Assistant reference files in `documents/`.
// Note: addresses are Modbus holding registers (FC3) as used in Home Assistant.

const DEFAULT_REGISTERS = Object.freeze({
  powerImportW: { address: 2, type: "uint16" },
  energyImportTotalWh: { address: 5, type: "uint32" },
  powerImportQuarterAvgW: { address: 9, type: "uint16" },

  powerExportW: { address: 12, type: "uint16" },
  energyExportTotalWh: { address: 15, type: "uint32" },
  powerExportQuarterAvgW: { address: 19, type: "uint16" },

  energyImportYesterdayF1Wh: { address: 30, type: "uint32" },
  energyImportYesterdayF2Wh: { address: 32, type: "uint32" },
  energyImportYesterdayF3Wh: { address: 34, type: "uint32" },
  energyImportYesterdayF4Wh: { address: 36, type: "uint32" },
  energyImportYesterdayF5Wh: { address: 38, type: "uint32" },
  energyImportYesterdayF6Wh: { address: 40, type: "uint32" },

  energyExportYesterdayF1Wh: { address: 54, type: "uint32" },
  energyExportYesterdayF2Wh: { address: 56, type: "uint32" },
  energyExportYesterdayF3Wh: { address: 58, type: "uint32" },
  energyExportYesterdayF4Wh: { address: 60, type: "uint32" },
  energyExportYesterdayF5Wh: { address: 62, type: "uint32" },
  energyExportYesterdayF6Wh: { address: 64, type: "uint32" },

  currentTariffBand: { address: 203, type: "uint16" },

  // Cutoff notice (HA template in `documents/distacco.yaml.txt`)
  cutoffEventEpoch: { address: 780, type: "uint32" },
  cutoffRemainingSeconds: { address: 782, type: "uint16" },

  powerProductionW: { address: 921, type: "uint16" },
  energyProductionTotalWh: { address: 924, type: "uint32" }
});

// Read groups (start + count) to minimize Modbus requests.
// Each group must include the addresses for the registers above.
const DEFAULT_READ_GROUPS = Object.freeze([
  { start: 2, count: 18 }, // 2..19
  { start: 30, count: 35 }, // 30..64
  { start: 203, count: 1 }, // 203
  { start: 780, count: 3 }, // 780..782
  { start: 921, count: 6 } // 921..926 (covers 924..925 for uint32)
]);

module.exports = {
  DEFAULT_REGISTERS,
  DEFAULT_READ_GROUPS
};
