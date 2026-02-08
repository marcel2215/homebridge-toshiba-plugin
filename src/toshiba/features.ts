import {
  ToshibaAcAirPureIon,
  ToshibaAcFanMode,
  ToshibaAcMeritA,
  ToshibaAcMeritB,
  ToshibaAcMode,
  ToshibaAcPowerSelection,
  ToshibaAcSelfCleaning,
  ToshibaAcStatus,
  ToshibaAcSwingMode,
} from './types.js';

const RAC_MODE_MAP: Record<string, ToshibaAcMode[]> = {
  '00': [ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN, ToshibaAcMode.HEAT],
  '01': [ToshibaAcMode.HEAT],
  '10': [ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN],
  '11': [ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN, ToshibaAcMode.HEAT],
};

const MODEL_MIRAI = '1';
const MODEL_DSK9 = '2';
const MODEL_DESIGN_TIER = '3';
const LC_VRF_IMS_MODELS = new Set(['5', '6', '7']);

const DISABLED_AC_MERIT_B_FOR_MODE: Record<ToshibaAcMode, ToshibaAcMeritB[]> = {
  [ToshibaAcMode.AUTO]: [ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2],
  [ToshibaAcMode.COOL]: [ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2],
  [ToshibaAcMode.HEAT]: [],
  [ToshibaAcMode.DRY]: [ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2],
  [ToshibaAcMode.FAN]: [ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2],
  [ToshibaAcMode.NONE]: [],
};

const DISABLED_AC_MERIT_A_FOR_MODE: Record<ToshibaAcMode, ToshibaAcMeritA[]> = {
  [ToshibaAcMode.AUTO]: [ToshibaAcMeritA.HEATING_8C, ToshibaAcMeritA.SLEEP_CARE, ToshibaAcMeritA.FLOOR],
  [ToshibaAcMode.COOL]: [ToshibaAcMeritA.HEATING_8C, ToshibaAcMeritA.SLEEP_CARE, ToshibaAcMeritA.FLOOR],
  [ToshibaAcMode.HEAT]: [],
  [ToshibaAcMode.DRY]: [
    ToshibaAcMeritA.HIGH_POWER,
    ToshibaAcMeritA.ECO,
    ToshibaAcMeritA.CDU_SILENT_1,
    ToshibaAcMeritA.CDU_SILENT_2,
    ToshibaAcMeritA.HEATING_8C,
    ToshibaAcMeritA.SLEEP_CARE,
    ToshibaAcMeritA.FLOOR,
  ],
  [ToshibaAcMode.FAN]: [
    ToshibaAcMeritA.HIGH_POWER,
    ToshibaAcMeritA.ECO,
    ToshibaAcMeritA.CDU_SILENT_1,
    ToshibaAcMeritA.CDU_SILENT_2,
    ToshibaAcMeritA.HEATING_8C,
    ToshibaAcMeritA.SLEEP_CARE,
    ToshibaAcMeritA.FLOOR,
  ],
  [ToshibaAcMode.NONE]: [],
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const isBitSet = (value: number, bit: number): boolean => ((value >> bit) & 0x01) === 1;
const parseHexByte = (hex: string, byteIndex: number): number => {
  const start = byteIndex * 2;
  const byteText = hex.slice(start, start + 2);
  if (!/^[0-9a-f]{2}$/i.test(byteText)) {
    return 0;
  }
  return Number.parseInt(byteText, 16);
};

export class ToshibaAcFeatures {
  constructor(
    public readonly acStatus: ToshibaAcStatus[],
    public readonly acMode: ToshibaAcMode[],
    public readonly acFanMode: ToshibaAcFanMode[],
    public readonly acSwingMode: ToshibaAcSwingMode[],
    public readonly acPowerSelection: ToshibaAcPowerSelection[],
    public readonly acMeritB: ToshibaAcMeritB[],
    public readonly acMeritA: ToshibaAcMeritA[],
    public readonly acAirPureIon: ToshibaAcAirPureIon[],
    public readonly acSelfCleaning: ToshibaAcSelfCleaning[],
    public readonly acEnergyReport: boolean,
  ) {}

  static fromMeritStringAndModel(
    meritFeatureHexString: string,
    acModelId: string,
    opeMode?: string,
  ): ToshibaAcFeatures {
    const meritHex = meritFeatureHexString.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    const modeHex = (opeMode ?? meritHex.slice(0, 2)).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    const meritByte0 = parseHexByte(meritHex, 0);
    const meritByte1 = parseHexByte(meritHex, 1);
    const modeByte = parseHexByte(modeHex, 0);

    const status = Object.values(ToshibaAcStatus);
    const mode = [ToshibaAcMode.NONE];
    const fanMode = Object.values(ToshibaAcFanMode);
    const swingMode = [ToshibaAcSwingMode.NONE, ToshibaAcSwingMode.OFF, ToshibaAcSwingMode.SWING_VERTICAL];
    const powerSelection = [ToshibaAcPowerSelection.NONE];
    const meritB = [ToshibaAcMeritB.NONE, ToshibaAcMeritB.OFF];
    const meritA = [ToshibaAcMeritA.NONE, ToshibaAcMeritA.OFF, ToshibaAcMeritA.SLEEP_CARE, ToshibaAcMeritA.COMFORT];
    const airPureIon = [ToshibaAcAirPureIon.NONE, ToshibaAcAirPureIon.OFF];
    const selfCleaning = Object.values(ToshibaAcSelfCleaning);
    let energyReport = false;

    let supportsPowerSelection = false;
    let supportsEco = false;
    let supportsHighPower = false;
    let supports8CHeating = false;
    let supportsFireplace = false;
    let supportsAirPure = false;
    let supportsCduSilent = false;
    let supportsFloor = false;
    let supportsLrLouver = false;
    let supportsFixedLouverPositions = false;

    if (acModelId === MODEL_MIRAI || acModelId === MODEL_DSK9 || acModelId === MODEL_DESIGN_TIER) {
      const modeKey = `${isBitSet(modeByte, 1) ? '1' : '0'}${isBitSet(modeByte, 0) ? '1' : '0'}`;
      mode.push(...(RAC_MODE_MAP[modeKey] ?? RAC_MODE_MAP['11']));
    } else if (LC_VRF_IMS_MODELS.has(acModelId)) {
      if (isBitSet(modeByte, 5)) {
        mode.push(ToshibaAcMode.AUTO);
      }
      if (isBitSet(modeByte, 1)) {
        mode.push(ToshibaAcMode.COOL);
      }
      if (isBitSet(modeByte, 2)) {
        mode.push(ToshibaAcMode.DRY);
      }
      if (isBitSet(modeByte, 0)) {
        mode.push(ToshibaAcMode.FAN);
      }
      if (isBitSet(modeByte, 3)) {
        mode.push(ToshibaAcMode.HEAT);
      }
    } else {
      mode.push(ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.HEAT);
    }

    if (acModelId === MODEL_MIRAI) {
      supportsPowerSelection = true;
    }

    if (acModelId === MODEL_DSK9 || acModelId === MODEL_DESIGN_TIER) {
      supportsPowerSelection = true;
      supportsEco = true;
      supportsHighPower = true;
      supports8CHeating = isBitSet(meritByte0, 2);
      supportsFireplace = isBitSet(meritByte0, 3);
      supportsAirPure = isBitSet(meritByte0, 4);
      supportsCduSilent = isBitSet(meritByte0, 5);
      supportsFloor = isBitSet(meritByte0, 7);
    }

    if (acModelId === MODEL_DESIGN_TIER) {
      supportsLrLouver = isBitSet(meritByte0, 6);
      energyReport = isBitSet(meritByte1, 0);
      supportsFixedLouverPositions = isBitSet(meritByte1, 1);
    }

    if (LC_VRF_IMS_MODELS.has(acModelId)) {
      supportsPowerSelection = isBitSet(meritByte1, 1);
      supportsAirPure = isBitSet(meritByte1, 7);
      supports8CHeating = isBitSet(meritByte0, 0);
      energyReport = isBitSet(meritByte1, 5);
    }

    if (supportsPowerSelection) {
      powerSelection.push(ToshibaAcPowerSelection.POWER_50, ToshibaAcPowerSelection.POWER_75, ToshibaAcPowerSelection.POWER_100);
    }

    if (supportsEco) {
      meritA.push(ToshibaAcMeritA.ECO);
    }

    if (supportsHighPower) {
      meritA.push(ToshibaAcMeritA.HIGH_POWER);
    }

    if (supports8CHeating) {
      meritA.push(ToshibaAcMeritA.HEATING_8C);
    }

    if (supportsCduSilent) {
      meritA.push(ToshibaAcMeritA.CDU_SILENT_1, ToshibaAcMeritA.CDU_SILENT_2);
    }

    if (supportsFloor) {
      meritA.push(ToshibaAcMeritA.FLOOR);
    }

    if (supportsFireplace) {
      meritB.push(ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2);
    }

    if (supportsAirPure) {
      airPureIon.push(ToshibaAcAirPureIon.ON);
    }

    if (supportsLrLouver) {
      swingMode.push(ToshibaAcSwingMode.SWING_HORIZONTAL, ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL);
    }

    if (supportsFixedLouverPositions) {
      swingMode.push(
        ToshibaAcSwingMode.FIXED_1,
        ToshibaAcSwingMode.FIXED_2,
        ToshibaAcSwingMode.FIXED_3,
        ToshibaAcSwingMode.FIXED_4,
        ToshibaAcSwingMode.FIXED_5,
      );
    }

    return new ToshibaAcFeatures(
      unique(status),
      unique(mode),
      unique(fanMode),
      unique(swingMode),
      unique(powerSelection),
      unique(meritB),
      unique(meritA),
      unique(airPureIon),
      unique(selfCleaning),
      energyReport,
    );
  }

  forMode(mode: ToshibaAcMode): ToshibaAcFeatures {
    const unsupportedMeritA = DISABLED_AC_MERIT_A_FOR_MODE[mode] ?? [];
    const unsupportedMeritB = DISABLED_AC_MERIT_B_FOR_MODE[mode] ?? [];

    return new ToshibaAcFeatures(
      this.acStatus,
      this.acMode,
      this.acFanMode,
      this.acSwingMode,
      this.acPowerSelection,
      this.acMeritB.filter(value => !unsupportedMeritB.includes(value)),
      this.acMeritA.filter(value => !unsupportedMeritA.includes(value)),
      this.acAirPureIon,
      this.acSelfCleaning,
      this.acEnergyReport,
    );
  }
}
