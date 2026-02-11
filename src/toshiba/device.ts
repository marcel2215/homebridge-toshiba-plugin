import type { Logging } from 'homebridge';

import { COMMAND_COALESCE_DELAY_MS } from './constants.js';
import { ToshibaAcFeatures } from './features.js';
import { ToshibaFcuState } from './state.js';
import type { ToshibaAdditionalInfo, ToshibaDiscoveredDevice } from './types.js';
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
import type { ToshibaAmqpClient } from './amqpClient.js';

export type ToshibaDeviceChangeListener = (device: ToshibaAcDevice) => void;

export class ToshibaAcDevice {
  readonly id: string;
  readonly uniqueId: string;

  readonly groupId: string;
  readonly groupName: string;
  readonly acModelId: string;
  readonly meritFeature: string;
  readonly opeMode?: string;
  readonly systemConfig?: string;
  readonly adapterType?: string;
  readonly firmwareVersion?: string;

  private readonly listeners = new Set<ToshibaDeviceChangeListener>();
  private commandQueue: Promise<void> = Promise.resolve();
  private pendingPatch?: ToshibaFcuState;
  private pendingDescriptions = new Set<string>();
  private pendingWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private commandFlushTimer?: NodeJS.Timeout;
  private isDisposed = false;

  private readonly state: ToshibaFcuState;
  readonly supported: ToshibaAcFeatures;

  private cduModelName?: string;
  private cduSerialNumber?: string;
  private fcuModelName?: string;
  private fcuSerialNumber?: string;

  constructor(
    private readonly log: Logging,
    private readonly amqp: ToshibaAmqpClient,
    discovered: ToshibaDiscoveredDevice,
    additionalInfo?: ToshibaAdditionalInfo,
    private readonly ensureDeviceOnline?: (uniqueId: string, name: string) => Promise<void>,
  ) {
    this.id = discovered.acId;
    this.uniqueId = discovered.uniqueId;
    this.name = discovered.name;
    this.groupId = discovered.groupId;
    this.groupName = discovered.groupName;
    this.acModelId = discovered.acModelId;
    this.meritFeature = discovered.meritFeature;
    this.opeMode = discovered.opeMode;
    this.systemConfig = discovered.systemConfig;
    this.adapterType = discovered.adapterType;
    this.firmwareVersion = discovered.firmwareVersion;

    this.state = ToshibaFcuState.fromHexState(discovered.stateHex);
    this.supported = ToshibaAcFeatures.fromMeritStringAndModel(this.meritFeature, this.acModelId, this.opeMode);

    this.updateAdditionalInfo(additionalInfo);

    this.log.debug(`[DEVICE] ${this.name} (${this.uniqueId}) initialized with state: ${this.state.toString()}`);
  }

  name: string;

  get manufacturer(): string {
    return 'Toshiba';
  }

  get model(): string {
    return this.cduModelName || this.fcuModelName || this.acModelId || 'Toshiba AC';
  }

  get serialNumber(): string {
    return this.cduSerialNumber || this.fcuSerialNumber || this.uniqueId;
  }

  get status(): ToshibaAcStatus {
    return this.state.acStatus;
  }

  get mode(): ToshibaAcMode {
    return this.state.acMode;
  }

  get targetTemperature(): number | null {
    const value = this.state.acTemperature;
    if (typeof value === 'number' && this.mode === ToshibaAcMode.HEAT && this.meritA === ToshibaAcMeritA.HEATING_8C) {
      return value - 16;
    }

    return value;
  }

  get indoorTemperature(): number | null {
    return this.state.acIndoorTemperature;
  }

  get outdoorTemperature(): number | null {
    return this.state.acOutdoorTemperature;
  }

  get fanMode(): ToshibaAcFanMode {
    return this.state.acFanMode;
  }

  get powerSelection(): ToshibaAcPowerSelection {
    return this.state.acPowerSelection;
  }

  get swingMode(): ToshibaAcSwingMode {
    return this.state.acSwingMode;
  }

  get meritA(): ToshibaAcMeritA {
    return this.state.acMeritA;
  }

  get meritB(): ToshibaAcMeritB {
    return this.state.acMeritB;
  }

  get airPureIon(): ToshibaAcAirPureIon {
    return this.state.acAirPureIon;
  }

  get selfCleaning(): ToshibaAcSelfCleaning {
    return this.state.acSelfCleaning;
  }

  get cduModel(): string | undefined {
    return this.cduModelName;
  }

  get fcuModel(): string | undefined {
    return this.fcuModelName;
  }

  get hasAdditionalInfo(): boolean {
    return Boolean(this.cduModelName || this.cduSerialNumber || this.fcuModelName || this.fcuSerialNumber);
  }

  updateIdentity(name: string): void {
    this.name = name;
  }

  updateAdditionalInfo(info?: ToshibaAdditionalInfo): void {
    if (!info) {
      return;
    }

    this.cduModelName = info.cduModelName;
    this.cduSerialNumber = info.cduSerialNumber;
    this.fcuModelName = info.fcuModelName;
    this.fcuSerialNumber = info.fcuSerialNumber;
  }

  addListener(listener: ToshibaDeviceChangeListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: ToshibaDeviceChangeListener): void {
    this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.listeners.clear();

    if (this.commandFlushTimer) {
      clearTimeout(this.commandFlushTimer);
      this.commandFlushTimer = undefined;
    }

    const error = new Error(`[${this.name}] Device instance disposed`);
    for (const waiter of this.pendingWaiters) {
      waiter.reject(error);
    }

    this.pendingWaiters = [];
    this.pendingPatch = undefined;
    this.pendingDescriptions.clear();
  }

  applyCloudState(hexState: string): boolean {
    const changed = this.state.update(hexState);
    if (changed) {
      this.notifyChanged();
    }

    return changed;
  }

  applyHeartbeat(payload: Record<string, unknown>): boolean {
    const heartbeat: Record<string, number> = {};

    const iTemp = this.parseSignedHexByte(payload.iTemp);
    if (typeof iTemp === 'number') {
      heartbeat.iTemp = iTemp;
    }

    const oTemp = this.parseSignedHexByte(payload.oTemp);
    if (typeof oTemp === 'number') {
      heartbeat.oTemp = oTemp;
    }

    const changed = this.state.updateFromHeartbeat(heartbeat);
    if (changed) {
      this.notifyChanged();
    }

    return changed;
  }

  async setStatus(status: ToshibaAcStatus): Promise<void> {
    return this.queueStatePatch('set status', patch => {
      patch.acStatus = status;
    });
  }

  async setMode(mode: ToshibaAcMode): Promise<void> {
    return this.queueStatePatch('set mode', patch => {
      patch.acMode = mode;
      patch.acStatus = ToshibaAcStatus.ON;
    });
  }

  async setTargetTemperature(temperature: number): Promise<void> {
    return this.queueStatePatch('set target temperature', patch => {
      patch.acTemperature = Math.round(temperature);
      patch.acStatus = ToshibaAcStatus.ON;
    });
  }

  async setFanMode(mode: ToshibaAcFanMode): Promise<void> {
    return this.queueStatePatch('set fan mode', patch => {
      patch.acFanMode = mode;
      patch.acStatus = ToshibaAcStatus.ON;
    });
  }

  async setPowerSelection(value: ToshibaAcPowerSelection): Promise<void> {
    return this.queueStatePatch('set power selection', patch => {
      patch.acPowerSelection = value;
    });
  }

  async setSwingMode(mode: ToshibaAcSwingMode): Promise<void> {
    return this.queueStatePatch('set swing mode', patch => {
      patch.acSwingMode = mode;
      patch.acStatus = ToshibaAcStatus.ON;
    });
  }

  async setMeritA(value: ToshibaAcMeritA): Promise<void> {
    return this.queueStatePatch('set merit A', patch => {
      patch.acMeritA = value;
    });
  }

  async setAirPureIon(value: ToshibaAcAirPureIon): Promise<void> {
    return this.queueStatePatch('set air pure ion', patch => {
      patch.acAirPureIon = value;
    });
  }

  async setSelfCleaning(value: ToshibaAcSelfCleaning): Promise<void> {
    return this.queueStatePatch('set self cleaning', patch => {
      patch.acSelfCleaning = value;
    });
  }

  private queueStatePatch(description: string, mutatePatch: (patch: ToshibaFcuState) => void): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error(`[${this.name}] Cannot queue command after device disposal`));
    }

    const patch = new ToshibaFcuState();
    mutatePatch(patch);

    if (!this.pendingPatch) {
      this.pendingPatch = patch;
    } else {
      this.pendingPatch.mergeFrom(patch);
    }

    this.pendingDescriptions.add(description);

    if (this.commandFlushTimer) {
      clearTimeout(this.commandFlushTimer);
      this.commandFlushTimer = undefined;
    }

    this.commandFlushTimer = setTimeout(() => {
      this.commandFlushTimer = undefined;
      this.flushPendingPatch().catch(error => {
        this.log.error(`[DEVICE] ${this.name}: failed to flush queued command: ${this.errorToString(error)}`);
      });
    }, COMMAND_COALESCE_DELAY_MS);
    this.commandFlushTimer.unref?.();

    return new Promise((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
    });
  }

  private async flushPendingPatch(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const patch = this.pendingPatch;
    if (!patch) {
      return;
    }

    const waiters = this.pendingWaiters;
    const descriptions = [...this.pendingDescriptions];

    this.pendingPatch = undefined;
    this.pendingWaiters = [];
    this.pendingDescriptions.clear();

    const description = descriptions.length > 1
      ? `coalesced updates (${descriptions.length} changes)`
      : descriptions[0] ?? 'command';

    const execute = async (): Promise<void> => {
      await this.sendStatePatch(description, patch);
    };

    const pending = this.commandQueue.then(execute, execute);
    this.commandQueue = pending.catch(() => undefined);

    try {
      await pending;
      waiters.forEach(waiter => waiter.resolve());
    } catch (error) {
      waiters.forEach(waiter => waiter.reject(error));
      throw error;
    }
  }

  private async sendStatePatch(description: string, patch: ToshibaFcuState): Promise<void> {
    if (this.isDisposed) {
      throw new Error(`[${this.name}] Cannot send command after device disposal`);
    }

    const currentEncodedState = this.state.encode();
    const futureState = this.state.clone();
    futureState.mergeFrom(patch);

    if (!this.supported.acStatus.includes(futureState.acStatus)) {
      throw new Error(`[${this.name}] Unsupported status ${futureState.acStatus}`);
    }

    if (!this.supported.acMode.includes(futureState.acMode)) {
      throw new Error(`[${this.name}] Unsupported mode ${futureState.acMode}`);
    }

    const supportedForMode = this.supported.forMode(futureState.acMode);

    if (!supportedForMode.acFanMode.includes(futureState.acFanMode)) {
      this.warnUnsupported(`fan mode ${futureState.acFanMode}`, futureState.acMode);
      patch.acFanMode = ToshibaAcFanMode.NONE;
    }

    if (!supportedForMode.acSwingMode.includes(futureState.acSwingMode)) {
      this.warnUnsupported(`swing mode ${futureState.acSwingMode}`, futureState.acMode);
      patch.acSwingMode = ToshibaAcSwingMode.NONE;
    }

    if (!supportedForMode.acPowerSelection.includes(futureState.acPowerSelection)) {
      this.warnUnsupported(`power selection ${futureState.acPowerSelection}`, futureState.acMode);
      patch.acPowerSelection = ToshibaAcPowerSelection.NONE;
    }

    if (!supportedForMode.acMeritB.includes(futureState.acMeritB)) {
      this.warnUnsupported(`merit B ${futureState.acMeritB}`, futureState.acMode);
      patch.acMeritB = ToshibaAcMeritB.OFF;
    }

    if (!supportedForMode.acMeritA.includes(futureState.acMeritA)) {
      this.warnUnsupported(`merit A ${futureState.acMeritA}`, futureState.acMode);
      patch.acMeritA = ToshibaAcMeritA.OFF;
    }

    if (!supportedForMode.acAirPureIon.includes(futureState.acAirPureIon)) {
      this.warnUnsupported(`air pure ion ${futureState.acAirPureIon}`, futureState.acMode);
      patch.acAirPureIon = ToshibaAcAirPureIon.NONE;
    }

    if (!supportedForMode.acSelfCleaning.includes(futureState.acSelfCleaning)) {
      this.warnUnsupported(`self cleaning ${futureState.acSelfCleaning}`, futureState.acMode);
      patch.acSelfCleaning = ToshibaAcSelfCleaning.NONE;
    }

    if (patch.hasPatchedStatus && patch.acStatus === ToshibaAcStatus.ON && this.selfCleaning === ToshibaAcSelfCleaning.ON) {
      patch.acSelfCleaning = ToshibaAcSelfCleaning.OFF;
    }

    const requestedTemperature = patch.acTemperature;
    if (
      patch.hasPatchedTemperature &&
      typeof requestedTemperature === 'number' &&
      futureState.acMode === ToshibaAcMode.HEAT &&
      futureState.acMeritA === ToshibaAcMeritA.HEATING_8C
    ) {
      patch.acTemperature = requestedTemperature + 16;
    }

    const adjustedFutureState = this.state.clone();
    adjustedFutureState.mergeFrom(patch);
    if (adjustedFutureState.encode() === currentEncodedState) {
      this.log.debug(`[DEVICE] ${this.name}: skipped ${description}; no effective state change`);
      return;
    }

    const encodedPatch = patch.encode();
    this.log.debug(`[DEVICE] ${this.name}: ${description} -> ${encodedPatch}`);
    if (this.ensureDeviceOnline) {
      await this.ensureDeviceOnline(this.uniqueId, this.name);
    }

    if (this.isDisposed) {
      throw new Error(`[${this.name}] Command aborted because device was disposed`);
    }

    await this.amqp.sendState(this.uniqueId, encodedPatch);

    if (this.state.mergeFrom(patch)) {
      this.notifyChanged();
    }
  }

  private warnUnsupported(featureName: string, mode: ToshibaAcMode): void {
    this.log.warn(`[DEVICE] ${this.name}: unsupported ${featureName} while mode=${mode}; command will be adjusted`);
  }

  private notifyChanged(): void {
    if (this.isDisposed) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (error) {
        this.log.error(`[DEVICE] Listener failure for ${this.name}: ${this.errorToString(error)}`);
      }
    }
  }

  private parseSignedHexByte(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const rounded = Math.trunc(value);
      if (rounded >= -128 && rounded <= 127) {
        return rounded;
      }

      if (rounded >= 0 && rounded <= 255) {
        return rounded > 127 ? rounded - 256 : rounded;
      }

      return undefined;
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    if (!/^[0-9a-fA-F]{2}$/.test(normalized)) {
      return undefined;
    }

    const unsigned = Number.parseInt(normalized, 16);
    return unsigned > 127 ? unsigned - 256 : unsigned;
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
