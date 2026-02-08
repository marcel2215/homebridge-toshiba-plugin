import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { ToshibaPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { ToshibaAmqpClient } from './toshiba/amqpClient.js';
import {
  CMD_FCU_FROM_AC,
  CMD_HEARTBEAT,
  DEFAULT_DISCOVERY_REFRESH_MINUTES,
  DEFAULT_ENABLE_FAN_SERVICE,
  DEFAULT_ENABLE_FEATURE_SWITCHES,
  DEFAULT_ENABLE_TEMPERATURE_SENSORS,
  DEFAULT_HTTP_RETRIES,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_STATE_POLL_INTERVAL_SECONDS,
  TOKEN_REFRESH_RETRY_DELAY_MS,
  TOKEN_REFRESH_ADVANCE_SECONDS,
} from './toshiba/constants.js';
import { ToshibaAcDevice } from './toshiba/device.js';
import { ToshibaApiError, ToshibaAuthError, ToshibaHttpApi } from './toshiba/httpApi.js';
import type { ToshibaDeviceConnectionState, ToshibaDiscoveredDevice, ToshibaPlatformDeviceOptions } from './toshiba/types.js';

interface ToshibaPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  pollIntervalSeconds?: number;
  discoveryRefreshMinutes?: number;
  requestTimeoutSeconds?: number;
  httpRetries?: number;
  enableFanService?: boolean;
  enableFeatureSwitches?: boolean;
  enableTemperatureSensors?: boolean;
}

const MOBILE_DEVICE_ID_STORAGE_DIR = 'toshiba-smart-ac';
const MOBILE_DEVICE_ID_STORAGE_FILE = 'mobile-device-id.txt';

export class ToshibaSmartACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();

  private readonly accessoryHandlers = new Map<string, ToshibaPlatformAccessory>();
  private readonly devicesByUniqueId = new Map<string, ToshibaAcDevice>();

  private readonly sessionId: string;

  private readonly deviceOptions: ToshibaPlatformDeviceOptions;

  private httpApi?: ToshibaHttpApi;
  private amqpClient?: ToshibaAmqpClient;

  private statePollTimer?: NodeJS.Timeout;
  private discoveryRefreshTimer?: NodeJS.Timeout;
  private tokenRefreshTimer?: NodeJS.Timeout;

  private operationQueue: Promise<void> = Promise.resolve();
  private isShuttingDown = false;
  private amqpRecoveryInProgress = false;

  constructor(
    public readonly log: Logging,
    public readonly config: ToshibaPlatformConfig,
    public readonly api: API,
  ) {
    this.sessionId = this.loadOrCreateMobileDeviceId();
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.deviceOptions = {
      enableFanService: config.enableFanService ?? DEFAULT_ENABLE_FAN_SERVICE,
      enableFeatureSwitches: config.enableFeatureSwitches ?? DEFAULT_ENABLE_FEATURE_SWITCHES,
      enableTemperatureSensors: config.enableTemperatureSensors ?? DEFAULT_ENABLE_TEMPERATURE_SENSORS,
    };

    this.log.info(`Finished initializing ${this.config.platform} platform`);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.start().catch(error => {
        this.log.error(`[PLATFORM] Failed to start Toshiba platform: ${this.errorToString(error)}`);
      });
    });

    this.api.on('shutdown', () => {
      this.shutdown().catch(error => {
        this.log.error(`[PLATFORM] Error during shutdown: ${this.errorToString(error)}`);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      this.log.error('[PLATFORM] Missing required config fields: username and password');
      return;
    }

    this.httpApi = new ToshibaHttpApi(this.log, {
      username: this.config.username,
      password: this.config.password,
      timeoutMs: Math.max(1_000, (this.config.requestTimeoutSeconds ?? (DEFAULT_HTTP_TIMEOUT_MS / 1000)) * 1_000),
      retries: this.config.httpRetries ?? DEFAULT_HTTP_RETRIES,
    });

    this.amqpClient = new ToshibaAmqpClient(this.log, this.sessionId);
    this.amqpClient.registerCommandHandler(CMD_FCU_FROM_AC, async payload => {
      this.handleCloudStateUpdate(payload.sourceId, payload.payload);
    });
    this.amqpClient.registerCommandHandler(CMD_HEARTBEAT, async payload => {
      this.handleCloudHeartbeat(payload.sourceId, payload.payload);
    });
    this.amqpClient.setConnectionLossHandler(error => {
      this.handleAmqpConnectionLoss(error).catch(recoveryError => {
        this.log.error(`[PLATFORM] Unexpected AMQP recovery error: ${this.errorToString(recoveryError)}`);
      });
    });

    await this.queueOperation(async () => {
      await this.connectCloud();
      await this.discoverDevices();
    });

    this.startStatePolling();
    this.startDiscoveryRefresh();
  }

  private async connectCloud(): Promise<void> {
    if (!this.httpApi || !this.amqpClient) {
      throw new Error('Platform not initialized');
    }

    this.log.info('[PLATFORM] Connecting to Toshiba cloud API');

    await this.httpApi.login();
    const registration = await this.httpApi.registerMobileClient(this.sessionId);

    await this.amqpClient.connect(registration);

    this.scheduleTokenRefresh(registration.SasToken);
  }

  private async refreshSasToken(): Promise<void> {
    if (this.isShuttingDown || !this.httpApi || !this.amqpClient) {
      return;
    }

    await this.queueOperation(async () => {
      try {
        const registration = await this.httpApi!.registerMobileClient(this.sessionId);
        await this.amqpClient!.connect(registration);
        this.scheduleTokenRefresh(registration.SasToken);
        this.log.info('[PLATFORM] Refreshed Toshiba cloud registration');
      } catch (error) {
        this.log.error(`[PLATFORM] Failed to refresh cloud registration: ${this.errorToString(error)}`);
        this.log.warn(`[PLATFORM] Retrying cloud registration refresh in ${Math.round(TOKEN_REFRESH_RETRY_DELAY_MS / 1000)} seconds`);
        this.scheduleTokenRefreshRetry();
      }
    });
  }

  private async handleAmqpConnectionLoss(error?: Error): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    if (this.amqpRecoveryInProgress) {
      this.log.debug('[PLATFORM] AMQP recovery already in progress');
      return;
    }

    this.amqpRecoveryInProgress = true;
    let attempt = 0;

    try {
      this.log.warn(`[PLATFORM] AMQP connection lost; starting recovery: ${error?.message ?? 'unknown reason'}`);

      while (!this.isShuttingDown) {
        attempt += 1;
        const delay = Math.min(60_000, Math.pow(2, Math.min(attempt, 6)) * 1_000);

        try {
          await this.queueOperation(async () => {
            await this.connectCloud();
          });
          this.log.info('[PLATFORM] AMQP connection recovered');
          return;
        } catch (recoveryError) {
          this.log.error(`[PLATFORM] AMQP recovery attempt ${attempt} failed: ${this.errorToString(recoveryError)}`);
          await this.sleep(delay);
        }
      }
    } finally {
      this.amqpRecoveryInProgress = false;
    }
  }

  private scheduleTokenRefresh(sasToken?: string): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    if (!sasToken) {
      this.log.debug('[PLATFORM] Toshiba registration did not include SAS token; periodic token refresh disabled');
      return;
    }

    const delay = this.calculateTokenRefreshDelayMs(sasToken);

    this.log.debug(`[PLATFORM] Scheduling SAS token refresh in ${(delay / 1000).toFixed(0)} seconds`);

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshSasToken().catch(error => {
        this.log.error(`[PLATFORM] Unexpected error while refreshing token: ${this.errorToString(error)}`);
      });
    }, delay);
  }

  private scheduleTokenRefreshRetry(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshSasToken().catch(error => {
        this.log.error(`[PLATFORM] Unexpected error while refreshing token: ${this.errorToString(error)}`);
      });
    }, TOKEN_REFRESH_RETRY_DELAY_MS);
  }

  private calculateTokenRefreshDelayMs(sasToken: string): number {
    const tokenParts = sasToken.split('&');
    const expirationPart = tokenParts.find(part => part.startsWith('se='));
    const expiration = expirationPart ? Number.parseInt(expirationPart.split('=')[1] ?? '', 10) : NaN;

    if (!Number.isFinite(expiration)) {
      return 6 * 60 * 60 * 1000;
    }

    const refreshAt = (expiration - TOKEN_REFRESH_ADVANCE_SECONDS) * 1000;
    return Math.max(60_000, refreshAt - Date.now());
  }

  private async discoverDevices(): Promise<void> {
    if (this.isShuttingDown || !this.httpApi || !this.amqpClient) {
      return;
    }

    this.log.info('[PLATFORM] Discovering Toshiba devices from cloud account');

    let discoveredDevices: ToshibaDiscoveredDevice[];
    try {
      discoveredDevices = await this.httpApi.getDevices();
    } catch (error) {
      if (!(error instanceof ToshibaAuthError)) {
        throw error;
      }

      this.log.error('[PLATFORM] Toshiba authentication failed during discovery; reconnecting cloud session');
      await this.connectCloud();
      discoveredDevices = await this.httpApi.getDevices();
    }
    const discoveredAccessoryUuids = new Set<string>();

    for (const discovered of discoveredDevices) {
      let additionalInfo;

      try {
        additionalInfo = await this.httpApi.getDeviceAdditionalInfo(discovered.acId, discovered.uniqueId);
      } catch (error) {
        if (error instanceof ToshibaAuthError) {
          this.log.error(`[PLATFORM] Authentication failed while fetching details for ${discovered.name}; reconnecting cloud session`);
          try {
            await this.connectCloud();
            additionalInfo = await this.httpApi.getDeviceAdditionalInfo(discovered.acId, discovered.uniqueId);
          } catch (retryError) {
            this.log.warn(`[PLATFORM] Failed to fetch additional info for ${discovered.name}: ${this.errorToString(retryError)}`);
          }
        } else {
          this.log.warn(`[PLATFORM] Failed to fetch additional info for ${discovered.name}: ${this.errorToString(error)}`);
        }
      }

      let device = this.devicesByUniqueId.get(discovered.uniqueId);
      if (!device) {
        device = new ToshibaAcDevice(
          this.log,
          this.amqpClient,
          discovered,
          additionalInfo,
          async (uniqueId, name) => this.ensureDeviceOnline(uniqueId, name),
        );
        this.devicesByUniqueId.set(discovered.uniqueId, device);
      } else {
        device.updateIdentity(discovered.name);
        device.updateAdditionalInfo(additionalInfo);
        device.applyCloudState(discovered.stateHex);
      }

      const uuid = this.api.hap.uuid.generate(`toshiba-smart-ac:${discovered.uniqueId}`);
      discoveredAccessoryUuids.add(uuid);

      const existingAccessory = this.accessories.get(uuid);
      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        existingAccessory.context.uniqueId = discovered.uniqueId;
        existingAccessory.context.acId = discovered.acId;

        const handler = this.accessoryHandlers.get(uuid);
        if (handler) {
          handler.setDevice(device);
        } else {
          this.accessoryHandlers.set(uuid, new ToshibaPlatformAccessory(this, existingAccessory, device, this.deviceOptions));
        }

        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info('Adding new accessory:', discovered.name);

        const accessory = new this.api.platformAccessory(discovered.name, uuid);
        accessory.context.uniqueId = discovered.uniqueId;
        accessory.context.acId = discovered.acId;

        this.accessories.set(uuid, accessory);
        this.accessoryHandlers.set(uuid, new ToshibaPlatformAccessory(this, accessory, device, this.deviceOptions));

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    this.removeStaleAccessories(discoveredAccessoryUuids);
  }

  private removeStaleAccessories(validAccessoryUuids: Set<string>): void {
    for (const [uuid, accessory] of this.accessories) {
      if (validAccessoryUuids.has(uuid)) {
        continue;
      }

      this.log.info('Removing stale accessory from cache:', accessory.displayName);

      const handler = this.accessoryHandlers.get(uuid);
      if (handler) {
        handler.dispose?.();
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.accessoryHandlers.delete(uuid);

      const uniqueId = accessory.context.uniqueId;
      if (typeof uniqueId === 'string') {
        this.devicesByUniqueId.delete(uniqueId);
      }
    }
  }

  private startStatePolling(): void {
    if (this.statePollTimer) {
      clearInterval(this.statePollTimer);
      this.statePollTimer = undefined;
    }

    const pollIntervalMs = Math.max(30, this.config.pollIntervalSeconds ?? DEFAULT_STATE_POLL_INTERVAL_SECONDS) * 1000;

    this.log.info(`[PLATFORM] Enabled state polling every ${Math.round(pollIntervalMs / 1000)} seconds`);

    this.statePollTimer = setInterval(() => {
      this.refreshStates().catch(error => {
        this.log.error(`[PLATFORM] State refresh failed: ${this.errorToString(error)}`);
      });
    }, pollIntervalMs);
  }

  private startDiscoveryRefresh(): void {
    if (this.discoveryRefreshTimer) {
      clearInterval(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = undefined;
    }

    const intervalMinutes = Math.max(5, this.config.discoveryRefreshMinutes ?? DEFAULT_DISCOVERY_REFRESH_MINUTES);
    const intervalMs = intervalMinutes * 60 * 1000;

    this.discoveryRefreshTimer = setInterval(() => {
      this.queueOperation(async () => {
        try {
          await this.discoverDevices();
        } catch (error) {
          this.log.error(`[PLATFORM] Periodic discovery failed: ${this.errorToString(error)}`);
        }
      }).catch(error => {
        this.log.error(`[PLATFORM] Discovery queue failure: ${this.errorToString(error)}`);
      });
    }, intervalMs);

    this.log.info(`[PLATFORM] Enabled periodic rediscovery every ${intervalMinutes} minutes`);
  }

  private async refreshStates(): Promise<void> {
    if (this.isShuttingDown || !this.httpApi) {
      return;
    }

    await this.queueOperation(async () => {
      for (const device of this.devicesByUniqueId.values()) {
        try {
          let latestState: string;
          try {
            latestState = await this.httpApi!.getDeviceStateByUniqueId(device.uniqueId);
          } catch (error) {
            if (error instanceof ToshibaAuthError) {
              throw error;
            }

            if (error instanceof ToshibaApiError) {
              this.log.debug(
                `[PLATFORM] Unique-id state fetch failed for ${device.name} (${device.uniqueId}), falling back to ACId: ${this.errorToString(error)}`,
              );
            }

            latestState = await this.httpApi!.getDeviceState(device.id);
          }

          device.applyCloudState(latestState);
        } catch (error) {
          if (error instanceof ToshibaAuthError) {
            this.log.error('[PLATFORM] Toshiba authentication failed while refreshing state; reconnecting cloud session');
            await this.connectCloud();
            return;
          }

          this.log.warn(`[PLATFORM] Failed to refresh state for ${device.name}: ${this.errorToString(error)}`);
        }
      }
    });
  }

  private handleCloudStateUpdate(sourceId: string, payload: Record<string, unknown>): void {
    const device = this.devicesByUniqueId.get(sourceId);
    if (!device) {
      this.log.debug(`[AMQP API] Ignoring cloud state update for unknown device: ${sourceId}`);
      return;
    }

    const state = payload.data;
    if (typeof state !== 'string') {
      this.log.warn(`[AMQP API] Received malformed state update for ${device.name}`);
      return;
    }

    device.applyCloudState(state);
  }

  private handleCloudHeartbeat(sourceId: string, payload: Record<string, unknown>): void {
    const device = this.devicesByUniqueId.get(sourceId);
    if (!device) {
      this.log.debug(`[AMQP API] Ignoring heartbeat for unknown device: ${sourceId}`);
      return;
    }

    device.applyHeartbeat(payload);
  }

  private async queueOperation(operation: () => Promise<void>): Promise<void> {
    // Serialize cloud operations so login/discovery/polling never race each other.
    const queued = this.operationQueue.then(operation, operation);
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureDeviceOnline(uniqueId: string, deviceName: string): Promise<void> {
    if (!this.httpApi) {
      return;
    }

    let states: ToshibaDeviceConnectionState[];
    try {
      states = await this.httpApi.getDeviceConnectionStates([uniqueId]);
    } catch (error) {
      if (!(error instanceof ToshibaAuthError)) {
        throw error;
      }

      this.log.warn(`[PLATFORM] Auth expired before command precheck for ${deviceName}; reconnecting cloud session`);
      await this.connectCloud();
      states = await this.httpApi.getDeviceConnectionStates([uniqueId]);
    }
    const state = states.find(item => item.DeviceId === uniqueId);

    if (!state || state.ConnectionState === 'Connected') {
      return;
    }

    throw new Error(`[${deviceName}] Toshiba cloud reports device offline (${state.ConnectionState})`);
  }

  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    if (this.statePollTimer) {
      clearInterval(this.statePollTimer);
      this.statePollTimer = undefined;
    }

    if (this.discoveryRefreshTimer) {
      clearInterval(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = undefined;
    }

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    for (const handler of this.accessoryHandlers.values()) {
      handler.dispose?.();
    }

    this.accessoryHandlers.clear();

    if (this.amqpClient) {
      await this.amqpClient.disconnect();
      this.amqpClient = undefined;
    }

    if (this.httpApi) {
      await this.httpApi.close();
      this.httpApi = undefined;
    }
  }

  private loadOrCreateMobileDeviceId(): string {
    const generated = randomUUID();

    try {
      const storageDir = join(this.api.user.storagePath(), MOBILE_DEVICE_ID_STORAGE_DIR);
      const storageFile = join(storageDir, MOBILE_DEVICE_ID_STORAGE_FILE);

      try {
        const persisted = readFileSync(storageFile, 'utf8').trim();
        if (persisted) {
          return persisted;
        }
      } catch {
        // Continue and create a new persisted id.
      }

      mkdirSync(storageDir, { recursive: true });
      writeFileSync(storageFile, generated, 'utf8');
      return generated;
    } catch (error) {
      this.log.warn(`[PLATFORM] Failed to persist mobile device id; using ephemeral id: ${this.errorToString(error)}`);
      return generated;
    }
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
