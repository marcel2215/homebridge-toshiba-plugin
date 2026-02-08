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

export class ToshibaFcuState {
  static readonly NONE_VAL = 0xFF;
  static readonly NONE_VAL_HALF = 0x0F;
  static readonly NONE_VAL_SIGNED = -1;

  private acStatusRaw = ToshibaFcuState.NONE_VAL;
  private acModeRaw = ToshibaFcuState.NONE_VAL;
  private acTemperatureRaw = ToshibaFcuState.NONE_VAL_SIGNED;
  private acFanModeRaw = ToshibaFcuState.NONE_VAL;
  private acSwingModeRaw = ToshibaFcuState.NONE_VAL;
  private acPowerSelectionRaw = ToshibaFcuState.NONE_VAL;
  private acMeritBRaw = ToshibaFcuState.NONE_VAL;
  private acMeritARaw = ToshibaFcuState.NONE_VAL;
  private acAirPureIonRaw = ToshibaFcuState.NONE_VAL;
  private acIndoorTemperatureRaw = ToshibaFcuState.NONE_VAL_SIGNED;
  private acOutdoorTemperatureRaw = ToshibaFcuState.NONE_VAL_SIGNED;
  private acSelfCleaningRaw = ToshibaFcuState.NONE_VAL;

  static fromHexState(hexState: string): ToshibaFcuState {
    const state = new ToshibaFcuState();
    state.decode(hexState);
    return state;
  }

  clone(): ToshibaFcuState {
    return ToshibaFcuState.fromHexState(this.encode());
  }

  encode(): string {
    const bytes = Buffer.alloc(20, ToshibaFcuState.NONE_VAL);
    bytes[0] = this.acStatusRaw & 0xFF;
    bytes[1] = this.acModeRaw & 0xFF;
    bytes.writeInt8(this.acTemperatureRaw, 2);
    bytes[3] = this.acFanModeRaw & 0xFF;
    bytes[4] = this.acSwingModeRaw & 0xFF;
    bytes[5] = this.acPowerSelectionRaw & 0xFF;
    bytes[6] = this.acMeritBRaw & 0xFF;
    bytes[7] = this.acMeritARaw & 0xFF;
    bytes[8] = this.acAirPureIonRaw & 0xFF;
    bytes.writeInt8(this.acIndoorTemperatureRaw, 9);
    bytes.writeInt8(this.acOutdoorTemperatureRaw, 10);
    bytes[15] = this.acSelfCleaningRaw & 0xFF;

    const encoded = bytes.toString('hex');
    // Toshiba cloud compresses two half-byte fields by removing the high nibble.
    return encoded.slice(0, 12) + encoded[13] + encoded[15] + encoded.slice(16);
  }

  decode(hexState: string): void {
    const normalized = this.normalizeCompressedState(hexState);
    // Restore the missing high nibble for the compressed merit fields before unpacking.
    const extendedHex = normalized.slice(0, 12) + '0' + normalized[12] + '0' + normalized.slice(13);
    const packed = Buffer.from(extendedHex, 'hex');

    if (packed.length < 20) {
      throw new Error(`Malformed Toshiba FCU state payload length=${packed.length}, expected >=20`);
    }

    this.acStatusRaw = packed[0];
    this.acModeRaw = packed[1];
    this.acTemperatureRaw = packed.readInt8(2);
    this.acFanModeRaw = packed[3];
    this.acSwingModeRaw = packed[4];
    this.acPowerSelectionRaw = packed[5];
    this.acMeritBRaw = packed[6];
    this.acMeritARaw = packed[7];
    this.acAirPureIonRaw = packed[8];
    this.acIndoorTemperatureRaw = packed.readInt8(9);
    this.acOutdoorTemperatureRaw = packed.readInt8(10);
    this.acSelfCleaningRaw = packed[15];
  }

  update(hexState: string): boolean {
    const updateState = ToshibaFcuState.fromHexState(hexState);
    return this.mergeFrom(updateState);
  }

  mergeFrom(updateState: ToshibaFcuState): boolean {
    let changed = false;

    changed = this.mergeEnumRawField(this.acStatusRaw, updateState.acStatusRaw, value => {
      this.acStatusRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acModeRaw, updateState.acModeRaw, value => {
      this.acModeRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acFanModeRaw, updateState.acFanModeRaw, value => {
      this.acFanModeRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acSwingModeRaw, updateState.acSwingModeRaw, value => {
      this.acSwingModeRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acPowerSelectionRaw, updateState.acPowerSelectionRaw, value => {
      this.acPowerSelectionRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acMeritBRaw, updateState.acMeritBRaw, value => {
      this.acMeritBRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acMeritARaw, updateState.acMeritARaw, value => {
      this.acMeritARaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acAirPureIonRaw, updateState.acAirPureIonRaw, value => {
      this.acAirPureIonRaw = value;
    }) || changed;
    changed = this.mergeEnumRawField(this.acSelfCleaningRaw, updateState.acSelfCleaningRaw, value => {
      this.acSelfCleaningRaw = value;
    }) || changed;

    changed = this.mergeTemperatureRawField(this.acTemperatureRaw, updateState.acTemperatureRaw, value => {
      this.acTemperatureRaw = value;
    }) || changed;
    changed = this.mergeTemperatureRawField(this.acIndoorTemperatureRaw, updateState.acIndoorTemperatureRaw, value => {
      this.acIndoorTemperatureRaw = value;
    }) || changed;
    changed = this.mergeTemperatureRawField(this.acOutdoorTemperatureRaw, updateState.acOutdoorTemperatureRaw, value => {
      this.acOutdoorTemperatureRaw = value;
    }) || changed;

    return changed;
  }

  updateFromHeartbeat(hbData: Record<string, number>): boolean {
    let changed = false;

    if (typeof hbData.iTemp === 'number' && hbData.iTemp !== this.acIndoorTemperatureRaw) {
      this.acIndoorTemperatureRaw = hbData.iTemp;
      changed = true;
    }

    if (typeof hbData.oTemp === 'number' && hbData.oTemp !== this.acOutdoorTemperatureRaw) {
      this.acOutdoorTemperatureRaw = hbData.oTemp;
      changed = true;
    }

    return changed;
  }

  get hasPatchedTemperature(): boolean {
    return this.acTemperatureRaw !== ToshibaFcuState.NONE_VAL_SIGNED;
  }

  get hasPatchedStatus(): boolean {
    return this.acStatusRaw !== ToshibaFcuState.NONE_VAL && this.acStatusRaw !== ToshibaFcuState.NONE_VAL_HALF;
  }

  get hasPatchedMode(): boolean {
    return this.acModeRaw !== ToshibaFcuState.NONE_VAL && this.acModeRaw !== ToshibaFcuState.NONE_VAL_HALF;
  }

  get acStatus(): ToshibaAcStatus {
    return ToshibaFcuState.statusFromRaw(this.acStatusRaw);
  }

  set acStatus(value: ToshibaAcStatus) {
    this.acStatusRaw = ToshibaFcuState.statusToRaw(value);
  }

  get acMode(): ToshibaAcMode {
    return ToshibaFcuState.modeFromRaw(this.acModeRaw);
  }

  set acMode(value: ToshibaAcMode) {
    this.acModeRaw = ToshibaFcuState.modeToRaw(value);
  }

  get acTemperature(): number | null {
    return ToshibaFcuState.temperatureFromRaw(this.acTemperatureRaw);
  }

  set acTemperature(value: number | null) {
    this.acTemperatureRaw = ToshibaFcuState.temperatureToRaw(value);
  }

  get acFanMode(): ToshibaAcFanMode {
    return ToshibaFcuState.fanModeFromRaw(this.acFanModeRaw);
  }

  set acFanMode(value: ToshibaAcFanMode) {
    this.acFanModeRaw = ToshibaFcuState.fanModeToRaw(value);
  }

  get acSwingMode(): ToshibaAcSwingMode {
    return ToshibaFcuState.swingModeFromRaw(this.acSwingModeRaw);
  }

  set acSwingMode(value: ToshibaAcSwingMode) {
    this.acSwingModeRaw = ToshibaFcuState.swingModeToRaw(value);
  }

  get acPowerSelection(): ToshibaAcPowerSelection {
    return ToshibaFcuState.powerSelectionFromRaw(this.acPowerSelectionRaw);
  }

  set acPowerSelection(value: ToshibaAcPowerSelection) {
    this.acPowerSelectionRaw = ToshibaFcuState.powerSelectionToRaw(value);
  }

  get acMeritB(): ToshibaAcMeritB {
    return ToshibaFcuState.meritBFromRaw(this.acMeritBRaw);
  }

  set acMeritB(value: ToshibaAcMeritB) {
    this.acMeritBRaw = ToshibaFcuState.meritBToRaw(value);
  }

  get acMeritA(): ToshibaAcMeritA {
    return ToshibaFcuState.meritAFromRaw(this.acMeritARaw);
  }

  set acMeritA(value: ToshibaAcMeritA) {
    this.acMeritARaw = ToshibaFcuState.meritAToRaw(value);
  }

  get acAirPureIon(): ToshibaAcAirPureIon {
    return ToshibaFcuState.airPureIonFromRaw(this.acAirPureIonRaw);
  }

  set acAirPureIon(value: ToshibaAcAirPureIon) {
    this.acAirPureIonRaw = ToshibaFcuState.airPureIonToRaw(value);
  }

  get acIndoorTemperature(): number | null {
    return ToshibaFcuState.temperatureFromRaw(this.acIndoorTemperatureRaw);
  }

  set acIndoorTemperature(value: number | null) {
    this.acIndoorTemperatureRaw = ToshibaFcuState.temperatureToRaw(value);
  }

  get acOutdoorTemperature(): number | null {
    return ToshibaFcuState.temperatureFromRaw(this.acOutdoorTemperatureRaw);
  }

  set acOutdoorTemperature(value: number | null) {
    this.acOutdoorTemperatureRaw = ToshibaFcuState.temperatureToRaw(value);
  }

  get acSelfCleaning(): ToshibaAcSelfCleaning {
    return ToshibaFcuState.selfCleaningFromRaw(this.acSelfCleaningRaw);
  }

  set acSelfCleaning(value: ToshibaAcSelfCleaning) {
    this.acSelfCleaningRaw = ToshibaFcuState.selfCleaningToRaw(value);
  }

  toString(): string {
    return [
      `status=${this.acStatus}`,
      `mode=${this.acMode}`,
      `targetTemperature=${this.acTemperature}`,
      `fanMode=${this.acFanMode}`,
      `swingMode=${this.acSwingMode}`,
      `powerSelection=${this.acPowerSelection}`,
      `meritB=${this.acMeritB}`,
      `meritA=${this.acMeritA}`,
      `airPureIon=${this.acAirPureIon}`,
      `indoorTemperature=${this.acIndoorTemperature}`,
      `outdoorTemperature=${this.acOutdoorTemperature}`,
      `selfCleaning=${this.acSelfCleaning}`,
    ].join(', ');
  }

  private normalizeCompressedState(hexState: string): string {
    const clean = hexState.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    const compact = clean.slice(0, 38).padEnd(38, 'f');

    if (compact.length < 14) {
      throw new Error(`Malformed Toshiba FCU state payload: ${hexState}`);
    }

    return compact;
  }

  private mergeEnumRawField(current: number, incoming: number, apply: (value: number) => void): boolean {
    if (
      incoming === ToshibaFcuState.NONE_VAL ||
      incoming === ToshibaFcuState.NONE_VAL_HALF ||
      incoming === current
    ) {
      return false;
    }

    apply(incoming);
    return true;
  }

  private mergeTemperatureRawField(current: number, incoming: number, apply: (value: number) => void): boolean {
    if (incoming === ToshibaFcuState.NONE_VAL_SIGNED || incoming === current) {
      return false;
    }

    apply(incoming);
    return true;
  }

  private static temperatureFromRaw(raw: number): number | null {
    if (raw === 127 || raw === -128 || raw === ToshibaFcuState.NONE_VAL_SIGNED) {
      return null;
    }

    if (raw === 126) {
      return -1;
    }

    return raw;
  }

  private static temperatureToRaw(temperature: number | null): number {
    if (temperature === null || typeof temperature !== 'number') {
      return ToshibaFcuState.NONE_VAL_SIGNED;
    }

    if (temperature === -1) {
      return 126;
    }

    return Math.max(-128, Math.min(127, Math.round(temperature)));
  }

  private static statusFromRaw(raw: number): ToshibaAcStatus {
    switch (raw) {
    case 0x30:
      return ToshibaAcStatus.ON;
    case 0x31:
      return ToshibaAcStatus.OFF;
    default:
      return ToshibaAcStatus.NONE;
    }
  }

  private static statusToRaw(status: ToshibaAcStatus): number {
    switch (status) {
    case ToshibaAcStatus.ON:
      return 0x30;
    case ToshibaAcStatus.OFF:
      return 0x31;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static modeFromRaw(raw: number): ToshibaAcMode {
    switch (raw) {
    case 0x41:
      return ToshibaAcMode.AUTO;
    case 0x42:
      return ToshibaAcMode.COOL;
    case 0x43:
      return ToshibaAcMode.HEAT;
    case 0x44:
      return ToshibaAcMode.DRY;
    case 0x45:
      return ToshibaAcMode.FAN;
    default:
      return ToshibaAcMode.NONE;
    }
  }

  private static modeToRaw(mode: ToshibaAcMode): number {
    switch (mode) {
    case ToshibaAcMode.AUTO:
      return 0x41;
    case ToshibaAcMode.COOL:
      return 0x42;
    case ToshibaAcMode.HEAT:
      return 0x43;
    case ToshibaAcMode.DRY:
      return 0x44;
    case ToshibaAcMode.FAN:
      return 0x45;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static fanModeFromRaw(raw: number): ToshibaAcFanMode {
    switch (raw) {
    case 0x41:
      return ToshibaAcFanMode.AUTO;
    case 0x31:
      return ToshibaAcFanMode.QUIET;
    case 0x32:
      return ToshibaAcFanMode.LOW;
    case 0x33:
      return ToshibaAcFanMode.MEDIUM_LOW;
    case 0x34:
      return ToshibaAcFanMode.MEDIUM;
    case 0x35:
      return ToshibaAcFanMode.MEDIUM_HIGH;
    case 0x36:
      return ToshibaAcFanMode.HIGH;
    default:
      return ToshibaAcFanMode.NONE;
    }
  }

  private static fanModeToRaw(mode: ToshibaAcFanMode): number {
    switch (mode) {
    case ToshibaAcFanMode.AUTO:
      return 0x41;
    case ToshibaAcFanMode.QUIET:
      return 0x31;
    case ToshibaAcFanMode.LOW:
      return 0x32;
    case ToshibaAcFanMode.MEDIUM_LOW:
      return 0x33;
    case ToshibaAcFanMode.MEDIUM:
      return 0x34;
    case ToshibaAcFanMode.MEDIUM_HIGH:
      return 0x35;
    case ToshibaAcFanMode.HIGH:
      return 0x36;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static swingModeFromRaw(raw: number): ToshibaAcSwingMode {
    switch (raw) {
    case 0x31:
      return ToshibaAcSwingMode.OFF;
    case 0x41:
      return ToshibaAcSwingMode.SWING_VERTICAL;
    case 0x42:
      return ToshibaAcSwingMode.SWING_HORIZONTAL;
    case 0x43:
      return ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL;
    case 0x50:
      return ToshibaAcSwingMode.FIXED_1;
    case 0x51:
      return ToshibaAcSwingMode.FIXED_2;
    case 0x52:
      return ToshibaAcSwingMode.FIXED_3;
    case 0x53:
      return ToshibaAcSwingMode.FIXED_4;
    case 0x54:
      return ToshibaAcSwingMode.FIXED_5;
    default:
      return ToshibaAcSwingMode.NONE;
    }
  }

  private static swingModeToRaw(mode: ToshibaAcSwingMode): number {
    switch (mode) {
    case ToshibaAcSwingMode.OFF:
      return 0x31;
    case ToshibaAcSwingMode.SWING_VERTICAL:
      return 0x41;
    case ToshibaAcSwingMode.SWING_HORIZONTAL:
      return 0x42;
    case ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL:
      return 0x43;
    case ToshibaAcSwingMode.FIXED_1:
      return 0x50;
    case ToshibaAcSwingMode.FIXED_2:
      return 0x51;
    case ToshibaAcSwingMode.FIXED_3:
      return 0x52;
    case ToshibaAcSwingMode.FIXED_4:
      return 0x53;
    case ToshibaAcSwingMode.FIXED_5:
      return 0x54;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static powerSelectionFromRaw(raw: number): ToshibaAcPowerSelection {
    switch (raw) {
    case 0x32:
      return ToshibaAcPowerSelection.POWER_50;
    case 0x4B:
      return ToshibaAcPowerSelection.POWER_75;
    case 0x64:
      return ToshibaAcPowerSelection.POWER_100;
    default:
      return ToshibaAcPowerSelection.NONE;
    }
  }

  private static powerSelectionToRaw(value: ToshibaAcPowerSelection): number {
    switch (value) {
    case ToshibaAcPowerSelection.POWER_50:
      return 0x32;
    case ToshibaAcPowerSelection.POWER_75:
      return 0x4B;
    case ToshibaAcPowerSelection.POWER_100:
      return 0x64;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static meritBFromRaw(raw: number): ToshibaAcMeritB {
    switch (raw) {
    case 0x02:
      return ToshibaAcMeritB.FIREPLACE_1;
    case 0x03:
      return ToshibaAcMeritB.FIREPLACE_2;
    case 0x01:
    case 0x00:
      return ToshibaAcMeritB.OFF;
    default:
      return ToshibaAcMeritB.NONE;
    }
  }

  private static meritBToRaw(value: ToshibaAcMeritB): number {
    switch (value) {
    case ToshibaAcMeritB.FIREPLACE_1:
      return 0x02;
    case ToshibaAcMeritB.FIREPLACE_2:
      return 0x03;
    case ToshibaAcMeritB.OFF:
      return 0x00;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static meritAFromRaw(raw: number): ToshibaAcMeritA {
    switch (raw) {
    case 0x01:
      return ToshibaAcMeritA.HIGH_POWER;
    case 0x02:
      return ToshibaAcMeritA.CDU_SILENT_1;
    case 0x03:
      return ToshibaAcMeritA.ECO;
    case 0x04:
      return ToshibaAcMeritA.HEATING_8C;
    case 0x05:
      return ToshibaAcMeritA.SLEEP_CARE;
    case 0x06:
      return ToshibaAcMeritA.FLOOR;
    case 0x07:
      return ToshibaAcMeritA.COMFORT;
    case 0x0A:
      return ToshibaAcMeritA.CDU_SILENT_2;
    case 0x00:
      return ToshibaAcMeritA.OFF;
    default:
      return ToshibaAcMeritA.NONE;
    }
  }

  private static meritAToRaw(value: ToshibaAcMeritA): number {
    switch (value) {
    case ToshibaAcMeritA.HIGH_POWER:
      return 0x01;
    case ToshibaAcMeritA.CDU_SILENT_1:
      return 0x02;
    case ToshibaAcMeritA.ECO:
      return 0x03;
    case ToshibaAcMeritA.HEATING_8C:
      return 0x04;
    case ToshibaAcMeritA.SLEEP_CARE:
      return 0x05;
    case ToshibaAcMeritA.FLOOR:
      return 0x06;
    case ToshibaAcMeritA.COMFORT:
      return 0x07;
    case ToshibaAcMeritA.CDU_SILENT_2:
      return 0x0A;
    case ToshibaAcMeritA.OFF:
      return 0x00;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static airPureIonFromRaw(raw: number): ToshibaAcAirPureIon {
    switch (raw) {
    case 0x18:
      return ToshibaAcAirPureIon.ON;
    case 0x10:
      return ToshibaAcAirPureIon.OFF;
    default:
      return ToshibaAcAirPureIon.NONE;
    }
  }

  private static airPureIonToRaw(value: ToshibaAcAirPureIon): number {
    switch (value) {
    case ToshibaAcAirPureIon.ON:
      return 0x18;
    case ToshibaAcAirPureIon.OFF:
      return 0x10;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }

  private static selfCleaningFromRaw(raw: number): ToshibaAcSelfCleaning {
    switch (raw) {
    case 0x18:
      return ToshibaAcSelfCleaning.ON;
    case 0x10:
      return ToshibaAcSelfCleaning.OFF;
    default:
      return ToshibaAcSelfCleaning.NONE;
    }
  }

  private static selfCleaningToRaw(value: ToshibaAcSelfCleaning): number {
    switch (value) {
    case ToshibaAcSelfCleaning.ON:
      return 0x18;
    case ToshibaAcSelfCleaning.OFF:
      return 0x10;
    default:
      return ToshibaFcuState.NONE_VAL;
    }
  }
}
