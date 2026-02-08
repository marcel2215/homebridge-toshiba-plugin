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

  static fromMeritStringAndModel(meritFeatureHexString: string, acModelId: string): ToshibaAcFeatures {
    const status = Object.values(ToshibaAcStatus);
    const mode = [ToshibaAcMode.NONE];
    const fanMode = Object.values(ToshibaAcFanMode);
    const swingMode = [ToshibaAcSwingMode.NONE, ToshibaAcSwingMode.OFF, ToshibaAcSwingMode.SWING_VERTICAL];
    const powerSelection = Object.values(ToshibaAcPowerSelection);
    const meritB = [ToshibaAcMeritB.NONE, ToshibaAcMeritB.OFF];
    const meritA = [ToshibaAcMeritA.NONE, ToshibaAcMeritA.OFF, ToshibaAcMeritA.SLEEP_CARE, ToshibaAcMeritA.COMFORT];
    const airPureIon = [ToshibaAcAirPureIon.NONE, ToshibaAcAirPureIon.OFF];
    const selfCleaning = Object.values(ToshibaAcSelfCleaning);
    let energyReport = false;

    const meritAsNumber = Number.parseInt(meritFeatureHexString.trim(), 16);
    const bits = Number.isFinite(meritAsNumber)
      ? meritAsNumber.toString(2).padStart(16, '0').split('').map(bit => bit === '1')
      : new Array<boolean>(16).fill(false);

    const modeComboKey = `${bits[6]}:${bits[7]}`;
    switch (modeComboKey) {
    case 'false:false':
      mode.push(ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN, ToshibaAcMode.HEAT);
      break;
    case 'false:true':
      mode.push(ToshibaAcMode.HEAT);
      break;
    case 'true:false':
      mode.push(ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN);
      break;
    case 'true:true':
      mode.push(ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.DRY, ToshibaAcMode.FAN, ToshibaAcMode.HEAT);
      break;
    default:
      mode.push(ToshibaAcMode.AUTO, ToshibaAcMode.COOL, ToshibaAcMode.HEAT);
      break;
    }

    if (acModelId === '2' || acModelId === '3') {
      meritA.push(ToshibaAcMeritA.HIGH_POWER, ToshibaAcMeritA.ECO);

      if (bits[0]) {
        meritA.push(ToshibaAcMeritA.FLOOR);
      }

      if (bits[1]) {
        swingMode.push(ToshibaAcSwingMode.SWING_HORIZONTAL, ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL);
      }

      if (bits[2]) {
        meritA.push(ToshibaAcMeritA.CDU_SILENT_1, ToshibaAcMeritA.CDU_SILENT_2);
      }

      if (bits[3]) {
        airPureIon.push(ToshibaAcAirPureIon.ON);
      }

      if (bits[4]) {
        meritB.push(ToshibaAcMeritB.FIREPLACE_1, ToshibaAcMeritB.FIREPLACE_2);
      }

      if (bits[5]) {
        meritA.push(ToshibaAcMeritA.HEATING_8C);
      }
    }

    if (acModelId === '3') {
      if (bits[14]) {
        swingMode.push(
          ToshibaAcSwingMode.FIXED_1,
          ToshibaAcSwingMode.FIXED_2,
          ToshibaAcSwingMode.FIXED_3,
          ToshibaAcSwingMode.FIXED_4,
          ToshibaAcSwingMode.FIXED_5,
        );
      }

      if (bits[15]) {
        energyReport = true;
      }
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
