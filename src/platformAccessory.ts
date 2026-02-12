import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ToshibaSmartACPlatform } from './platform.js';
import type { ToshibaAcDevice } from './toshiba/device.js';
import {
  ToshibaAcFanMode,
  ToshibaAcMeritA,
  ToshibaAcMode,
  ToshibaAcPowerSelection,
  ToshibaAcStatus,
  ToshibaAcSwingMode,
} from './toshiba/types.js';

const MIN_TARGET_TEMPERATURE = 5;
const MAX_TARGET_TEMPERATURE = 35;
const ROTATION_SPEED_AUTO = 0;
const ROTATION_SPEED_OUTDOOR_SILENT_MAX = 5;
const ROTATION_SPEED_INDOOR_SILENT_MAX = 10;
const ROTATION_SPEED_ECO_MAX = 20;
const ROTATION_SPEED_HIGH_POWER = 100;
const ROTATION_SPEED_PREFERENCE_MAX_AGE_MS = 15 * 60 * 1000;

const FAN_SPEED_MAP: Array<[ToshibaAcFanMode, number]> = [
  [ToshibaAcFanMode.AUTO, 0],
  [ToshibaAcFanMode.QUIET, Math.round((100 / 7) * 2)],
  [ToshibaAcFanMode.LOW, Math.round((100 / 7) * 3)],
  [ToshibaAcFanMode.MEDIUM_LOW, Math.round((100 / 7) * 4)],
  [ToshibaAcFanMode.MEDIUM, Math.round((100 / 7) * 5)],
  [ToshibaAcFanMode.MEDIUM_HIGH, Math.round((100 / 7) * 6)],
  [ToshibaAcFanMode.HIGH, Math.round((100 / 7) * 7)],
];

interface RotationSpeedPreference {
  speed: number;
  fanMode: ToshibaAcFanMode;
  meritA: ToshibaAcMeritA;
  powerSelection: ToshibaAcPowerSelection;
  updatedAt: number;
}

export class ToshibaPlatformAccessory {
  private readonly heaterCoolerService: Service;
  private rotationSpeedPreference?: RotationSpeedPreference;

  constructor(
    private readonly platform: ToshibaSmartACPlatform,
    private readonly accessory: PlatformAccessory,
    private device: ToshibaAcDevice,
  ) {
    this.heaterCoolerService = this.accessory.getService(this.platform.Service.HeaterCooler)
      || this.accessory.addService(this.platform.Service.HeaterCooler);

    this.device.addListener(this.handleDeviceChanged);

    this.removeLegacyAuxiliaryServices();
    this.configureAccessoryInformation();
    this.configureHeaterCoolerService();

    this.refreshFromDevice();
  }

  setDevice(device: ToshibaAcDevice): void {
    this.device.removeListener(this.handleDeviceChanged);
    this.device = device;
    this.device.addListener(this.handleDeviceChanged);
    this.clearRotationSpeedPreference();

    this.configureAccessoryInformation();
    this.removeLegacyAuxiliaryServices();
    this.refreshFromDevice();
  }

  refreshFromPlatform(): void {
    this.refreshFromDevice();
  }

  dispose(): void {
    this.device.removeListener(this.handleDeviceChanged);
    this.clearRotationSpeedPreference();
  }

  private configureAccessoryInformation(): void {
    const safeModel = this.normalizeModel(this.device.model);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, safeModel)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.serialNumber)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.firmwareVersion ?? 'unknown');
  }

  private configureHeaterCoolerService(): void {
    this.heaterCoolerService.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
    const initialTargetTemperature = this.getTargetTemperatureValue();
    this.heaterCoolerService.setCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, initialTargetTemperature);
    this.heaterCoolerService.setCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, initialTargetTemperature);

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(async () => this.readForHomeKit(() => this.getActiveValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setActiveValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(async () => this.readForHomeKit(() => this.getCurrentHeaterCoolerStateValue()));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: this.supportedTargetHeaterCoolerStateValues() })
      .onGet(async () => this.readForHomeKit(() => this.getTargetHeaterCoolerStateValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setTargetHeaterCoolerStateValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(async () => this.readForHomeKit(() => this.getCurrentTemperatureValue()));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: MIN_TARGET_TEMPERATURE, maxValue: MAX_TARGET_TEMPERATURE, minStep: 1 })
      .onGet(async () => this.readForHomeKit(() => this.getTargetTemperatureValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setTargetTemperatureValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: MIN_TARGET_TEMPERATURE, maxValue: MAX_TARGET_TEMPERATURE, minStep: 1 })
      .onGet(async () => this.readForHomeKit(() => this.getTargetTemperatureValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setTargetTemperatureValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(async () => this.readForHomeKit(() => this.getRotationSpeedValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setRotationSpeedValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(async () => this.readForHomeKit(() => this.getSwingModeValue()))
      .onSet(async (value) => this.wrapSet(async () => this.setSwingModeValue(value)));
  }

  private readonly handleDeviceChanged = () => {
    this.refreshFromDevice();
  };

  private refreshFromDevice(): void {
    this.refreshServiceNames();
    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: this.supportedTargetHeaterCoolerStateValues() });

    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Active, this.getActiveValue());
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.getCurrentHeaterCoolerStateValue());
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.getTargetHeaterCoolerStateValue());
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperatureValue());

    const targetTemperature = this.getTargetTemperatureValue();
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, targetTemperature);
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, targetTemperature);
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getRotationSpeedValue());
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.getSwingModeValue());
  }

  private refreshServiceNames(): void {
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Name, this.device.name);
  }

  private normalizeModel(model: string): string {
    const normalized = model.trim();
    if (normalized.length > 1) {
      return normalized;
    }

    if (normalized.length === 1) {
      return `Toshiba ${normalized}`;
    }

    return 'Toshiba AC';
  }

  private removeLegacyAuxiliaryServices(): void {
    const allowedServiceUuids = new Set<string>([
      this.platform.Service.AccessoryInformation.UUID,
      this.platform.Service.HeaterCooler.UUID,
    ]);

    for (const service of [...this.accessory.services]) {
      if (allowedServiceUuids.has(service.UUID)) {
        continue;
      }

      this.platform.log.info(
        `[ACCESSORY] ${this.device.name}: removing auxiliary service "${service.displayName}" to keep a single HeaterCooler accessory`,
      );
      this.accessory.removeService(service);
    }
  }

  private getActiveValue(): number {
    return this.isOperationallyActive()
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private isOperationallyActive(): boolean {
    if (this.device.status === ToshibaAcStatus.ON) {
      return true;
    }

    if (this.device.status === ToshibaAcStatus.OFF) {
      return false;
    }

    // Some cloud updates can transiently omit status while still reporting a concrete mode.
    return this.device.mode !== ToshibaAcMode.NONE;
  }

  private async setActiveValue(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.device.setStatus(active ? ToshibaAcStatus.ON : ToshibaAcStatus.OFF);
  }

  private getCurrentHeaterCoolerStateValue(): number {
    if (!this.isOperationallyActive()) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    switch (this.device.mode) {
    case ToshibaAcMode.COOL:
      return this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
    case ToshibaAcMode.HEAT:
      return this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
    default:
      return this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  }

  private getTargetHeaterCoolerStateValue(): number {
    switch (this.device.mode) {
    case ToshibaAcMode.COOL:
      if (this.isModeSupported(ToshibaAcMode.COOL)) {
        return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
      }
      break;
    case ToshibaAcMode.HEAT:
      if (this.isModeSupported(ToshibaAcMode.HEAT)) {
        return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
      }
      break;
    default:
      if (this.isModeSupported(ToshibaAcMode.AUTO)) {
        return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
      }
      break;
    }

    return this.fallbackTargetHeaterCoolerStateValue();
  }

  private async setTargetHeaterCoolerStateValue(value: CharacteristicValue): Promise<void> {
    const requested = Number(value);
    const targetMode = this.modeFromTargetHeaterCoolerState(requested);
    if (!targetMode) {
      this.platform.log.warn(
        `[ACCESSORY] ${this.device.name}: unsupported TargetHeaterCoolerState=${requested}; skipping mode change`,
      );
      return;
    }

    await this.device.setMode(targetMode);
  }

  private getCurrentTemperatureValue(): number {
    return this.normalizeCurrentTemperature(this.device.indoorTemperature ?? this.device.targetTemperature ?? 20);
  }

  private getTargetTemperatureValue(): number {
    const value = this.device.targetTemperature;
    if (typeof value !== 'number') {
      return 24;
    }

    return this.normalizeTargetTemperature(value);
  }

  private async setTargetTemperatureValue(value: CharacteristicValue): Promise<void> {
    const target = this.normalizeTargetTemperature(Number(value));
    await this.device.setTargetTemperature(target);
  }

  private getRotationSpeedValue(): number {
    const preferred = this.getPreferredRotationSpeedValue();
    if (typeof preferred === 'number') {
      return preferred;
    }

    return this.deriveRotationSpeedFromState();
  }

  private deriveRotationSpeedFromState(): number {
    if (this.device.meritA === ToshibaAcMeritA.HIGH_POWER) {
      return ROTATION_SPEED_HIGH_POWER;
    }

    if (this.device.meritA === ToshibaAcMeritA.CDU_SILENT_1 || this.device.meritA === ToshibaAcMeritA.CDU_SILENT_2) {
      return ROTATION_SPEED_OUTDOOR_SILENT_MAX;
    }

    if (this.device.fanMode === ToshibaAcFanMode.QUIET) {
      return ROTATION_SPEED_INDOOR_SILENT_MAX;
    }

    if (this.device.meritA === ToshibaAcMeritA.ECO) {
      return ROTATION_SPEED_ECO_MAX;
    }

    for (const [fanMode, speed] of FAN_SPEED_MAP) {
      if (this.device.fanMode === fanMode) {
        return speed;
      }
    }

    return ROTATION_SPEED_AUTO;
  }

  private async setRotationSpeedValue(value: CharacteristicValue): Promise<void> {
    const target = this.normalizeRotationSpeed(Number(value));
    const requestedFanMode = this.fanModeFromRotationSpeed(target);
    const requestedMeritA = this.meritAFromRotationSpeed(target);
    const requestedPowerSelection = this.powerSelectionFromRotationSpeed(target);
    const fanMode = this.resolveSupportedFanMode(requestedFanMode);
    const meritA = this.resolveSupportedMeritA(requestedMeritA);
    const powerSelection = this.resolveSupportedPowerSelection(requestedPowerSelection);

    this.rememberRotationSpeedPreference(target, fanMode, meritA, powerSelection);

    const updates: Array<Promise<void>> = [];
    if (target > ROTATION_SPEED_AUTO && this.device.status !== ToshibaAcStatus.ON) {
      updates.push(this.device.setStatus(ToshibaAcStatus.ON));
    }
    if (this.device.fanMode !== fanMode) {
      updates.push(this.device.setFanMode(fanMode));
    }
    if (this.device.meritA !== meritA) {
      updates.push(this.device.setMeritA(meritA));
    }
    if (this.device.powerSelection !== powerSelection) {
      updates.push(this.device.setPowerSelection(powerSelection));
    }

    if (updates.length === 0) {
      this.platform.log.debug(`[ACCESSORY] ${this.device.name}: rotation speed ${target}% already applied, skipping command`);
      return;
    }

    try {
      await Promise.all(updates);
    } catch (error) {
      this.clearRotationSpeedPreference();
      throw error;
    }
  }

  private getSwingModeValue(): number {
    return (
      this.device.swingMode !== ToshibaAcSwingMode.OFF &&
      this.device.swingMode !== ToshibaAcSwingMode.NONE
    )
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  private async setSwingModeValue(value: CharacteristicValue): Promise<void> {
    const enabled = Number(value) === this.platform.Characteristic.SwingMode.SWING_ENABLED;
    if (!enabled) {
      if (!this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.OFF)) {
        this.platform.log.warn(
          `[ACCESSORY] ${this.device.name}: swing disable requested but OFF mode is unsupported; skipping command`,
        );
        return;
      }

      await this.device.setSwingMode(ToshibaAcSwingMode.OFF);
      return;
    }

    const preferred = this.preferredEnabledSwingMode();
    if (!preferred) {
      this.platform.log.warn(
        `[ACCESSORY] ${this.device.name}: swing enable requested but no supported swing mode is available; skipping command`,
      );
      return;
    }

    await this.device.setSwingMode(preferred);
  }

  private preferredEnabledSwingMode(): ToshibaAcSwingMode | undefined {
    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL)) {
      return ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL;
    }

    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_VERTICAL)) {
      return ToshibaAcSwingMode.SWING_VERTICAL;
    }

    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_HORIZONTAL)) {
      return ToshibaAcSwingMode.SWING_HORIZONTAL;
    }

    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.FIXED_1)) {
      return ToshibaAcSwingMode.FIXED_1;
    }

    return undefined;
  }

  private normalizeCurrentTemperature(value: number): number {
    if (!Number.isFinite(value)) {
      return 20;
    }

    const rounded = Math.round(value * 10) / 10;
    return Math.min(100, Math.max(-270, rounded));
  }

  private normalizeTargetTemperature(value: number): number {
    if (!Number.isFinite(value)) {
      return 24;
    }

    const rounded = Math.round(value);
    return Math.min(MAX_TARGET_TEMPERATURE, Math.max(MIN_TARGET_TEMPERATURE, rounded));
  }

  private normalizeRotationSpeed(value: number): number {
    if (!Number.isFinite(value)) {
      return ROTATION_SPEED_AUTO;
    }

    return Math.min(100, Math.max(0, Math.round(value)));
  }

  private fanModeFromRotationSpeed(speed: number): ToshibaAcFanMode {
    if (speed === ROTATION_SPEED_AUTO) {
      return ToshibaAcFanMode.AUTO;
    }

    if (speed <= ROTATION_SPEED_INDOOR_SILENT_MAX) {
      return ToshibaAcFanMode.QUIET;
    }

    const candidates = FAN_SPEED_MAP.filter(([fanMode]) => (
      fanMode !== ToshibaAcFanMode.AUTO && fanMode !== ToshibaAcFanMode.QUIET
    ));
    if (candidates.length === 0) {
      return ToshibaAcFanMode.AUTO;
    }

    const selected = candidates.reduce((best, candidate) => {
      const bestDistance = Math.abs(best[1] - speed);
      const candidateDistance = Math.abs(candidate[1] - speed);
      return candidateDistance < bestDistance ? candidate : best;
    }, candidates[0]);

    return selected[0];
  }

  private meritAFromRotationSpeed(speed: number): ToshibaAcMeritA {
    if (speed === ROTATION_SPEED_HIGH_POWER) {
      return ToshibaAcMeritA.HIGH_POWER;
    }

    if (speed > ROTATION_SPEED_AUTO && speed <= ROTATION_SPEED_OUTDOOR_SILENT_MAX) {
      return ToshibaAcMeritA.CDU_SILENT_1;
    }

    if (speed > ROTATION_SPEED_AUTO && speed <= ROTATION_SPEED_ECO_MAX) {
      return ToshibaAcMeritA.ECO;
    }

    return ToshibaAcMeritA.OFF;
  }

  private powerSelectionFromRotationSpeed(speed: number): ToshibaAcPowerSelection {
    if (speed === ROTATION_SPEED_AUTO) {
      return ToshibaAcPowerSelection.POWER_75;
    }

    if (speed <= 33) {
      return ToshibaAcPowerSelection.POWER_50;
    }

    if (speed <= 66) {
      return ToshibaAcPowerSelection.POWER_75;
    }

    return ToshibaAcPowerSelection.POWER_100;
  }

  private resolveSupportedFanMode(requested: ToshibaAcFanMode): ToshibaAcFanMode {
    const supported: ToshibaAcFanMode[] = this.device.supported.acFanMode
      .filter(value => value !== ToshibaAcFanMode.NONE);
    if (supported.includes(requested)) {
      return requested;
    }

    if (supported.includes(this.device.fanMode)) {
      return this.device.fanMode;
    }

    return supported[0] ?? ToshibaAcFanMode.AUTO;
  }

  private resolveSupportedMeritA(requested: ToshibaAcMeritA): ToshibaAcMeritA {
    const supported: ToshibaAcMeritA[] = this.device.supported.acMeritA
      .filter(value => value !== ToshibaAcMeritA.NONE);
    if (supported.includes(requested)) {
      return requested;
    }

    if (
      requested === ToshibaAcMeritA.CDU_SILENT_1 ||
      requested === ToshibaAcMeritA.CDU_SILENT_2
    ) {
      if (
        (this.device.meritA === ToshibaAcMeritA.CDU_SILENT_1 || this.device.meritA === ToshibaAcMeritA.CDU_SILENT_2) &&
        supported.includes(this.device.meritA)
      ) {
        return this.device.meritA;
      }
      if (supported.includes(ToshibaAcMeritA.CDU_SILENT_1)) {
        return ToshibaAcMeritA.CDU_SILENT_1;
      }
      if (supported.includes(ToshibaAcMeritA.CDU_SILENT_2)) {
        return ToshibaAcMeritA.CDU_SILENT_2;
      }
    }

    if (supported.includes(ToshibaAcMeritA.OFF)) {
      return ToshibaAcMeritA.OFF;
    }

    if (supported.includes(this.device.meritA)) {
      return this.device.meritA;
    }

    return supported[0] ?? ToshibaAcMeritA.OFF;
  }

  private resolveSupportedPowerSelection(requested: ToshibaAcPowerSelection): ToshibaAcPowerSelection {
    const supported: ToshibaAcPowerSelection[] = this.device.supported.acPowerSelection
      .filter(value => value !== ToshibaAcPowerSelection.NONE);
    if (supported.includes(requested)) {
      return requested;
    }

    if (supported.length > 0) {
      const requestedValue = this.powerSelectionNumericValue(requested);
      if (typeof requestedValue === 'number') {
        const nearest = supported.reduce((best, candidate) => {
          const bestValue = this.powerSelectionNumericValue(best) ?? Number.POSITIVE_INFINITY;
          const candidateValue = this.powerSelectionNumericValue(candidate) ?? Number.POSITIVE_INFINITY;
          const bestDistance = Math.abs(bestValue - requestedValue);
          const candidateDistance = Math.abs(candidateValue - requestedValue);
          return candidateDistance < bestDistance ? candidate : best;
        }, supported[0]);
        return nearest;
      }
    }

    if (supported.includes(this.device.powerSelection)) {
      return this.device.powerSelection;
    }

    return supported[0] ?? ToshibaAcPowerSelection.POWER_75;
  }

  private powerSelectionNumericValue(value: ToshibaAcPowerSelection): number | undefined {
    switch (value) {
    case ToshibaAcPowerSelection.POWER_50:
      return 50;
    case ToshibaAcPowerSelection.POWER_75:
      return 75;
    case ToshibaAcPowerSelection.POWER_100:
      return 100;
    default:
      return undefined;
    }
  }

  private supportedTargetHeaterCoolerStateValues(): number[] {
    const values: number[] = [];

    if (this.isModeSupported(ToshibaAcMode.AUTO)) {
      values.push(this.platform.Characteristic.TargetHeaterCoolerState.AUTO);
    }
    if (this.isModeSupported(ToshibaAcMode.HEAT)) {
      values.push(this.platform.Characteristic.TargetHeaterCoolerState.HEAT);
    }
    if (this.isModeSupported(ToshibaAcMode.COOL)) {
      values.push(this.platform.Characteristic.TargetHeaterCoolerState.COOL);
    }

    if (values.length > 0) {
      return values;
    }

    // Defensive fallback for malformed capability payloads: keep UI stable with one safe value.
    return [this.platform.Characteristic.TargetHeaterCoolerState.AUTO];
  }

  private fallbackTargetHeaterCoolerStateValue(): number {
    if (this.isModeSupported(ToshibaAcMode.AUTO)) {
      return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    }

    if (this.isModeSupported(ToshibaAcMode.COOL)) {
      return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    }

    if (this.isModeSupported(ToshibaAcMode.HEAT)) {
      return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
    }

    return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
  }

  private modeFromTargetHeaterCoolerState(value: number): ToshibaAcMode | undefined {
    if (value === this.platform.Characteristic.TargetHeaterCoolerState.COOL) {
      return this.isModeSupported(ToshibaAcMode.COOL) ? ToshibaAcMode.COOL : undefined;
    }

    if (value === this.platform.Characteristic.TargetHeaterCoolerState.HEAT) {
      return this.isModeSupported(ToshibaAcMode.HEAT) ? ToshibaAcMode.HEAT : undefined;
    }

    if (value === this.platform.Characteristic.TargetHeaterCoolerState.AUTO) {
      if (this.isModeSupported(ToshibaAcMode.AUTO)) {
        return ToshibaAcMode.AUTO;
      }
      // If AUTO is unsupported, preserve the currently active controllable mode first.
      if (this.device.mode === ToshibaAcMode.COOL && this.isModeSupported(ToshibaAcMode.COOL)) {
        return ToshibaAcMode.COOL;
      }
      if (this.device.mode === ToshibaAcMode.HEAT && this.isModeSupported(ToshibaAcMode.HEAT)) {
        return ToshibaAcMode.HEAT;
      }
      if (this.isModeSupported(ToshibaAcMode.COOL)) {
        return ToshibaAcMode.COOL;
      }
      if (this.isModeSupported(ToshibaAcMode.HEAT)) {
        return ToshibaAcMode.HEAT;
      }
      return undefined;
    }

    return undefined;
  }

  private isModeSupported(mode: ToshibaAcMode): boolean {
    return this.device.supported.acMode.includes(mode);
  }

  private getPreferredRotationSpeedValue(): number | undefined {
    const preference = this.rotationSpeedPreference;
    if (!preference) {
      return undefined;
    }

    // Keep the user-selected slider value stable while Toshiba cloud state still maps to the same tuple.
    if ((Date.now() - preference.updatedAt) > ROTATION_SPEED_PREFERENCE_MAX_AGE_MS) {
      this.clearRotationSpeedPreference();
      return undefined;
    }

    if (!this.isRotationSpeedPreferenceApplicable(preference)) {
      this.clearRotationSpeedPreference();
      return undefined;
    }

    return preference.speed;
  }

  private isRotationSpeedPreferenceApplicable(preference: RotationSpeedPreference): boolean {
    if (this.device.fanMode !== preference.fanMode) {
      return false;
    }

    const supportedForMode = this.device.supported.forMode(this.device.mode);
    const meritRelevant = supportedForMode.acMeritA.includes(preference.meritA);
    if (meritRelevant && !this.isMeritAEquivalent(preference.meritA, this.device.meritA)) {
      return false;
    }

    const powerSelectionRelevant = supportedForMode.acPowerSelection.includes(preference.powerSelection);
    if (powerSelectionRelevant && this.device.powerSelection !== preference.powerSelection) {
      return false;
    }

    return true;
  }

  private isMeritAEquivalent(expected: ToshibaAcMeritA, actual: ToshibaAcMeritA): boolean {
    if (
      expected === ToshibaAcMeritA.CDU_SILENT_1 ||
      expected === ToshibaAcMeritA.CDU_SILENT_2
    ) {
      return actual === ToshibaAcMeritA.CDU_SILENT_1 || actual === ToshibaAcMeritA.CDU_SILENT_2;
    }

    return expected === actual;
  }

  private rememberRotationSpeedPreference(
    speed: number,
    fanMode: ToshibaAcFanMode,
    meritA: ToshibaAcMeritA,
    powerSelection: ToshibaAcPowerSelection,
  ): void {
    this.rotationSpeedPreference = {
      speed,
      fanMode,
      meritA,
      powerSelection,
      updatedAt: Date.now(),
    };
  }

  private clearRotationSpeedPreference(): void {
    this.rotationSpeedPreference = undefined;
  }

  private async wrapSet(setter: () => Promise<void>): Promise<void> {
    try {
      if (this.isDeviceCloudOffline()) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }

      await setter();
    } catch (error) {
      if (error instanceof this.platform.api.hap.HapStatusError) {
        throw error;
      }

      this.platform.log.error(`[ACCESSORY] ${this.device.name}: ${this.errorToString(error)}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private readForHomeKit<T extends CharacteristicValue>(read: () => T): T {
    if (this.isDeviceCloudOffline()) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    return read();
  }

  private isDeviceCloudOffline(): boolean {
    return this.platform.getDeviceCloudConnectionState(this.device.uniqueId) === 'offline';
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
