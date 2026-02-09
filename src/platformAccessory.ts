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

const FAN_SPEED_MAP: Array<[ToshibaAcFanMode, number]> = [
  [ToshibaAcFanMode.AUTO, 0],
  [ToshibaAcFanMode.QUIET, Math.round((100 / 7) * 2)],
  [ToshibaAcFanMode.LOW, Math.round((100 / 7) * 3)],
  [ToshibaAcFanMode.MEDIUM_LOW, Math.round((100 / 7) * 4)],
  [ToshibaAcFanMode.MEDIUM, Math.round((100 / 7) * 5)],
  [ToshibaAcFanMode.MEDIUM_HIGH, Math.round((100 / 7) * 6)],
  [ToshibaAcFanMode.HIGH, Math.round((100 / 7) * 7)],
];

export class ToshibaPlatformAccessory {
  private readonly heaterCoolerService: Service;

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

    this.configureAccessoryInformation();
    this.removeLegacyAuxiliaryServices();
    this.refreshFromDevice();
  }

  dispose(): void {
    this.device.removeListener(this.handleDeviceChanged);
  }

  private configureAccessoryInformation(): void {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, this.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.serialNumber)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.firmwareVersion ?? 'unknown');
  }

  private configureHeaterCoolerService(): void {
    this.heaterCoolerService.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(async () => this.getActiveValue())
      .onSet(async (value) => this.wrapSet(async () => this.setActiveValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(async () => this.getCurrentHeaterCoolerStateValue());

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(async () => this.getTargetHeaterCoolerStateValue())
      .onSet(async (value) => this.wrapSet(async () => this.setTargetHeaterCoolerStateValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(async () => this.getCurrentTemperatureValue());

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: MIN_TARGET_TEMPERATURE, maxValue: MAX_TARGET_TEMPERATURE, minStep: 1 })
      .onGet(async () => this.getTargetTemperatureValue())
      .onSet(async (value) => this.wrapSet(async () => this.setTargetTemperatureValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: MIN_TARGET_TEMPERATURE, maxValue: MAX_TARGET_TEMPERATURE, minStep: 1 })
      .onGet(async () => this.getTargetTemperatureValue())
      .onSet(async (value) => this.wrapSet(async () => this.setTargetTemperatureValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(async () => this.getRotationSpeedValue())
      .onSet(async (value) => this.wrapSet(async () => this.setRotationSpeedValue(value)));

    this.heaterCoolerService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(async () => this.getSwingModeValue())
      .onSet(async (value) => this.wrapSet(async () => this.setSwingModeValue(value)));
  }

  private readonly handleDeviceChanged = () => {
    this.refreshFromDevice();
  };

  private refreshFromDevice(): void {
    this.refreshServiceNames();

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
    return this.device.status === ToshibaAcStatus.ON
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private async setActiveValue(value: CharacteristicValue): Promise<void> {
    const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    await this.device.setStatus(active ? ToshibaAcStatus.ON : ToshibaAcStatus.OFF);
  }

  private getCurrentHeaterCoolerStateValue(): number {
    if (this.device.status !== ToshibaAcStatus.ON) {
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
      return this.platform.Characteristic.TargetHeaterCoolerState.COOL;
    case ToshibaAcMode.HEAT:
      return this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
    default:
      return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    }
  }

  private async setTargetHeaterCoolerStateValue(value: CharacteristicValue): Promise<void> {
    switch (Number(value)) {
    case this.platform.Characteristic.TargetHeaterCoolerState.COOL:
      await this.device.setMode(ToshibaAcMode.COOL);
      return;
    case this.platform.Characteristic.TargetHeaterCoolerState.HEAT:
      await this.device.setMode(ToshibaAcMode.HEAT);
      return;
    default:
      await this.device.setMode(ToshibaAcMode.AUTO);
      return;
    }
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
    const fanMode = this.fanModeFromRotationSpeed(target);
    const meritA = this.meritAFromRotationSpeed(target);
    const powerSelection = this.powerSelectionFromRotationSpeed(target);

    await Promise.all([
      this.device.setFanMode(fanMode),
      this.device.setMeritA(meritA),
      this.device.setPowerSelection(powerSelection),
    ]);
  }

  private getSwingModeValue(): number {
    return this.device.swingMode !== ToshibaAcSwingMode.OFF
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  private async setSwingModeValue(value: CharacteristicValue): Promise<void> {
    const enabled = Number(value) === this.platform.Characteristic.SwingMode.SWING_ENABLED;
    await this.device.setSwingMode(enabled ? this.preferredEnabledSwingMode() : ToshibaAcSwingMode.OFF);
  }

  private preferredEnabledSwingMode(): ToshibaAcSwingMode {
    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL)) {
      return ToshibaAcSwingMode.SWING_VERTICAL_AND_HORIZONTAL;
    }

    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_VERTICAL)) {
      return ToshibaAcSwingMode.SWING_VERTICAL;
    }

    if (this.device.supported.acSwingMode.includes(ToshibaAcSwingMode.SWING_HORIZONTAL)) {
      return ToshibaAcSwingMode.SWING_HORIZONTAL;
    }

    return ToshibaAcSwingMode.FIXED_1;
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

  private async wrapSet(setter: () => Promise<void>): Promise<void> {
    try {
      await setter();
    } catch (error) {
      this.platform.log.error(`[ACCESSORY] ${this.device.name}: ${this.errorToString(error)}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
