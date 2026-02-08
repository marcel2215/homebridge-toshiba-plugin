import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ToshibaSmartACPlatform } from './platform.js';
import type { ToshibaAcDevice } from './toshiba/device.js';
import {
  ToshibaAcAirPureIon,
  ToshibaAcFanMode,
  ToshibaAcMeritA,
  ToshibaAcMode,
  ToshibaAcSelfCleaning,
  ToshibaAcStatus,
  ToshibaAcSwingMode,
  type ToshibaPlatformDeviceOptions,
} from './toshiba/types.js';

const MIN_TARGET_TEMPERATURE = 5;
const MAX_TARGET_TEMPERATURE = 35;

const FAN_SPEED_MAP: Array<[ToshibaAcFanMode, number]> = [
  [ToshibaAcFanMode.AUTO, 0],
  [ToshibaAcFanMode.QUIET, Math.round((100 / 7) * 2)],
  [ToshibaAcFanMode.LOW, Math.round((100 / 7) * 3)],
  [ToshibaAcFanMode.MEDIUM_LOW, Math.round((100 / 7) * 4)],
  [ToshibaAcFanMode.MEDIUM, Math.round((100 / 7) * 5)],
  [ToshibaAcFanMode.MEDIUM_HIGH, Math.round((100 / 7) * 6)],
  [ToshibaAcFanMode.HIGH, Math.round((100 / 7) * 7)],
];

interface FeatureSwitch {
  label: string;
  service: Service;
  getValue: () => boolean;
  setValue: (value: boolean) => Promise<void>;
}

export class ToshibaPlatformAccessory {
  private readonly heaterCoolerService: Service;
  private fanService?: Service;
  private indoorTemperatureService?: Service;
  private outdoorTemperatureService?: Service;

  private readonly featureSwitches = new Map<string, FeatureSwitch>();

  constructor(
    private readonly platform: ToshibaSmartACPlatform,
    private readonly accessory: PlatformAccessory,
    private device: ToshibaAcDevice,
    private readonly options: ToshibaPlatformDeviceOptions,
  ) {
    this.heaterCoolerService = this.accessory.getService(this.platform.Service.HeaterCooler)
      || this.accessory.addService(this.platform.Service.HeaterCooler);

    this.device.addListener(this.handleDeviceChanged);

    this.configureAccessoryInformation();
    this.configureHeaterCoolerService();
    this.configureOptionalServices();

    this.refreshFromDevice();
  }

  setDevice(device: ToshibaAcDevice): void {
    this.device.removeListener(this.handleDeviceChanged);
    this.device = device;
    this.device.addListener(this.handleDeviceChanged);

    this.configureAccessoryInformation();
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

  private configureOptionalServices(): void {
    if (this.options.enableFanService && this.platform.Service.Fanv2) {
      this.configureFanService();
    }

    if (this.options.enableTemperatureSensors) {
      this.configureTemperatureSensors();
    }

    if (this.options.enableFeatureSwitches) {
      this.configureFeatureSwitches();
    }
  }

  private configureFanService(): void {
    this.fanService = this.accessory.getService('Fan')
      || this.accessory.addService(this.platform.Service.Fanv2, 'Fan', 'fan-v2');

    this.fanService.getCharacteristic(this.platform.Characteristic.Name)
      .updateValue(`${this.device.name} Fan`);

    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(async () => this.device.status === ToshibaAcStatus.ON && this.device.mode === ToshibaAcMode.FAN
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE)
      .onSet(async (value) => this.wrapSet(async () => {
        const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
        if (active) {
          await this.device.setMode(ToshibaAcMode.FAN);
        } else {
          await this.device.setStatus(ToshibaAcStatus.OFF);
        }
      }));

    this.fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(async () => this.device.status === ToshibaAcStatus.ON && this.device.mode === ToshibaAcMode.FAN
        ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
        : this.platform.Characteristic.CurrentFanState.INACTIVE);

    this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onGet(async () => this.platform.Characteristic.TargetFanState.MANUAL);

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(async () => this.getRotationSpeedValue())
      .onSet(async (value) => this.wrapSet(async () => this.setRotationSpeedValue(value)));

    this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(async () => this.getSwingModeValue())
      .onSet(async (value) => this.wrapSet(async () => this.setSwingModeValue(value)));
  }

  private configureTemperatureSensors(): void {
    this.indoorTemperatureService = this.accessory.getService('Indoor Temperature')
      || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Indoor Temperature', 'indoor-temp');

    this.indoorTemperatureService.getCharacteristic(this.platform.Characteristic.Name)
      .updateValue(`${this.device.name} Indoor`);

    this.outdoorTemperatureService = this.accessory.getService('Outdoor Temperature')
      || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Outdoor Temperature', 'outdoor-temp');

    this.outdoorTemperatureService.getCharacteristic(this.platform.Characteristic.Name)
      .updateValue(`${this.device.name} Outdoor`);
  }

  private configureFeatureSwitches(): void {
    this.configureMeritASwitch('Eco Mode', ToshibaAcMeritA.ECO, 'feature-eco');
    this.configureMeritASwitch('Hi Power', ToshibaAcMeritA.HIGH_POWER, 'feature-hi-power');
    this.configureMeritASwitch('8C Heating', ToshibaAcMeritA.HEATING_8C, 'feature-heating-8c');
    this.configureMeritASwitch('Floor Mode', ToshibaAcMeritA.FLOOR, 'feature-floor');
    this.configureMeritASwitch('Comfort', ToshibaAcMeritA.COMFORT, 'feature-comfort');

    if (this.device.supported.acAirPureIon.includes(ToshibaAcAirPureIon.ON)) {
      this.configureSwitch('Ionizer', 'feature-ionizer', {
        getValue: () => this.device.airPureIon === ToshibaAcAirPureIon.ON,
        setValue: async (enabled) => this.device.setAirPureIon(enabled ? ToshibaAcAirPureIon.ON : ToshibaAcAirPureIon.OFF),
      });
    }

    if (this.device.supported.acSelfCleaning.includes(ToshibaAcSelfCleaning.ON)) {
      this.configureSwitch('Self Cleaning', 'feature-self-cleaning', {
        getValue: () => this.device.selfCleaning === ToshibaAcSelfCleaning.ON,
        setValue: async (enabled) => this.device.setSelfCleaning(enabled ? ToshibaAcSelfCleaning.ON : ToshibaAcSelfCleaning.OFF),
      });
    }
  }

  private configureMeritASwitch(label: string, merit: ToshibaAcMeritA, subtype: string): void {
    if (!this.device.supported.acMeritA.includes(merit)) {
      return;
    }

    this.configureSwitch(label, subtype, {
      getValue: () => this.device.meritA === merit,
      setValue: async (enabled) => {
        if (enabled) {
          await this.device.setMeritA(merit);
          return;
        }

        if (this.device.meritA === merit) {
          await this.device.setMeritA(ToshibaAcMeritA.OFF);
        }
      },
    });
  }

  private configureSwitch(label: string, subtype: string, state: Omit<FeatureSwitch, 'service' | 'label'>): void {
    const service = this.accessory.getService(label)
      || this.accessory.addService(this.platform.Service.Switch, label, subtype);

    service.getCharacteristic(this.platform.Characteristic.Name).updateValue(`${this.device.name} ${label}`);

    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(async () => state.getValue())
      .onSet(async (value) => this.wrapSet(async () => state.setValue(Boolean(value))));

    this.featureSwitches.set(subtype, {
      label,
      service,
      getValue: state.getValue,
      setValue: state.setValue,
    });
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

    if (this.fanService) {
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.device.status === ToshibaAcStatus.ON && this.device.mode === ToshibaAcMode.FAN
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.CurrentFanState,
        this.device.status === ToshibaAcStatus.ON && this.device.mode === ToshibaAcMode.FAN
          ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
          : this.platform.Characteristic.CurrentFanState.INACTIVE,
      );
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.getRotationSpeedValue());
      this.fanService.updateCharacteristic(this.platform.Characteristic.SwingMode, this.getSwingModeValue());
    }

    if (this.indoorTemperatureService) {
      this.indoorTemperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperatureValue());
    }

    if (this.outdoorTemperatureService) {
      const outdoor = this.device.outdoorTemperature;
      this.outdoorTemperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.normalizeCurrentTemperature(typeof outdoor === 'number' ? outdoor : this.getCurrentTemperatureValue()),
      );
    }

    for (const feature of this.featureSwitches.values()) {
      feature.service.updateCharacteristic(this.platform.Characteristic.On, feature.getValue());
    }
  }

  private refreshServiceNames(): void {
    this.heaterCoolerService.updateCharacteristic(this.platform.Characteristic.Name, this.device.name);

    if (this.fanService) {
      this.fanService.updateCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Fan`);
    }

    if (this.indoorTemperatureService) {
      this.indoorTemperatureService.updateCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Indoor`);
    }

    if (this.outdoorTemperatureService) {
      this.outdoorTemperatureService.updateCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Outdoor`);
    }

    for (const feature of this.featureSwitches.values()) {
      feature.service.updateCharacteristic(this.platform.Characteristic.Name, `${this.device.name} ${feature.label}`);
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
    for (const [fanMode, speed] of FAN_SPEED_MAP) {
      if (this.device.fanMode === fanMode) {
        return speed;
      }
    }

    return 0;
  }

  private async setRotationSpeedValue(value: CharacteristicValue): Promise<void> {
    const target = Number(value);
    const selected = FAN_SPEED_MAP.reduce((best, candidate) => {
      const bestDistance = Math.abs(best[1] - target);
      const candidateDistance = Math.abs(candidate[1] - target);
      return candidateDistance < bestDistance ? candidate : best;
    }, FAN_SPEED_MAP[0]);

    await this.device.setFanMode(selected[0]);
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
