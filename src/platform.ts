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
  DEFAULT_HTTP_RETRIES,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_STATE_POLL_INTERVAL_SECONDS,
  TOKEN_REFRESH_RETRY_DELAY_MS,
  TOKEN_REFRESH_ADVANCE_SECONDS,
} from './toshiba/constants.js';
import { ToshibaAcDevice } from './toshiba/device.js';
import { ToshibaApiError, ToshibaAuthError, ToshibaHttpApi } from './toshiba/httpApi.js';
import type { ToshibaDeviceConnectionState, ToshibaDiscoveredDevice } from './toshiba/types.js';

interface ToshibaPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  pollIntervalSeconds?: number;
  discoveryRefreshMinutes?: number;
  requestTimeoutSeconds?: number;
  httpRetries?: number;
}

const MOBILE_DEVICE_ID_STORAGE_DIR = 'toshiba-smart-ac';
const MOBILE_DEVICE_ID_STORAGE_FILE = 'mobile-device-id.txt';
const STARTUP_RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
const DEVICE_CONNECTION_STATE_CACHE_TTL_MS = 5_000;
const MISSING_DEVICE_CONNECTION_STATE = 'MissingFromResponse';
const MALFORMED_DEVICE_CONNECTION_STATE = 'MalformedConnectionState';
const STATE_ENDPOINT_BOTH_FORBIDDEN_LOG_INTERVAL_MS = 30 * 60 * 1000;
const STATE_ENDPOINT_FORBIDDEN_PROBE_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_POLL_INTERVAL_SECONDS = 3600;
const MIN_DISCOVERY_REFRESH_MINUTES = 5;
const MAX_DISCOVERY_REFRESH_MINUTES = 1440;
const MIN_REQUEST_TIMEOUT_SECONDS = 5;
const MAX_REQUEST_TIMEOUT_SECONDS = 120;
const MIN_HTTP_RETRIES = 0;
const MAX_HTTP_RETRIES = 10;

type ToshibaStateEndpoint = 'unique' | 'acid';
type ToshibaCloudConnectionState = 'online' | 'offline' | 'unknown';

interface ToshibaStateEndpointStatus {
  preferred: ToshibaStateEndpoint;
  uniqueForbidden: boolean;
  acIdForbidden: boolean;
  nextForbiddenWarningAt?: number;
  nextForbiddenProbeAt?: number;
}

export class ToshibaSmartACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<string, PlatformAccessory>();

  private readonly accessoryHandlers = new Map<string, ToshibaPlatformAccessory>();
  private readonly devicesByUniqueId = new Map<string, ToshibaAcDevice>();
  private readonly connectionStateCache = new Map<string, { state: string; updatedAt: number }>();
  private readonly stateEndpointByDevice = new Map<string, ToshibaStateEndpointStatus>();

  private readonly sessionId: string;

  private httpApi?: ToshibaHttpApi;
  private amqpClient?: ToshibaAmqpClient;

  private statePollTimer?: NodeJS.Timeout;
  private discoveryRefreshTimer?: NodeJS.Timeout;
  private tokenRefreshTimer?: NodeJS.Timeout;
  private startupRetryTimer?: NodeJS.Timeout;

  private operationQueue: Promise<void> = Promise.resolve();
  private isShuttingDown = false;
  private amqpRecoveryInProgress = false;
  private startupRetryAttempt = 0;
  private stateRefreshInProgress = false;
  private discoveryRefreshInProgress = false;
  private additionalInfoEndpointForbidden = false;

  constructor(
    public readonly log: Logging,
    public readonly config: ToshibaPlatformConfig,
    public readonly api: API,
  ) {
    this.sessionId = this.loadOrCreateMobileDeviceId();
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

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

  public getDeviceCloudConnectionState(uniqueId: string): ToshibaCloudConnectionState {
    const normalizedUniqueId = this.normalizeCloudIdentifier(uniqueId);
    if (!normalizedUniqueId) {
      return 'unknown';
    }

    const cached = this.connectionStateCache.get(normalizedUniqueId) ?? this.connectionStateCache.get(uniqueId);
    if (!cached) {
      return 'unknown';
    }

    return this.isConnectedState(cached.state) ? 'online' : 'offline';
  }

  private async start(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    const username = typeof this.config.username === 'string' ? this.config.username.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    if (!username || !password) {
      this.log.error('[PLATFORM] Missing required config fields: username and password');
      return;
    }

    if (!this.httpApi) {
      const requestTimeoutSeconds = this.normalizeIntegerConfig(
        this.config.requestTimeoutSeconds,
        DEFAULT_HTTP_TIMEOUT_MS / 1000,
        MIN_REQUEST_TIMEOUT_SECONDS,
        MAX_REQUEST_TIMEOUT_SECONDS,
        'requestTimeoutSeconds',
      );
      const httpRetries = this.normalizeIntegerConfig(
        this.config.httpRetries,
        DEFAULT_HTTP_RETRIES,
        MIN_HTTP_RETRIES,
        MAX_HTTP_RETRIES,
        'httpRetries',
      );

      this.httpApi = new ToshibaHttpApi(this.log, {
        username,
        password,
        timeoutMs: requestTimeoutSeconds * 1_000,
        retries: httpRetries,
      });
    }

    if (!this.amqpClient) {
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
    }

    try {
      await this.queueOperation(async () => {
        await this.connectCloud();
        await this.discoverDevices();
      });

      if (this.isShuttingDown) {
        return;
      }

      this.startupRetryAttempt = 0;
      this.startStatePolling();
      this.startDiscoveryRefresh();
    } catch (error) {
      if (this.isShuttingDown) {
        return;
      }

      if (error instanceof ToshibaAuthError) {
        this.log.error('[PLATFORM] Toshiba authentication failed. Verify username/password in config.');
        return;
      }

      const delay = Math.min(STARTUP_RETRY_MAX_DELAY_MS, Math.pow(2, Math.min(this.startupRetryAttempt, 8)) * 1_000);
      this.startupRetryAttempt += 1;
      this.log.error(`[PLATFORM] Failed to start Toshiba platform: ${this.errorToString(error)}`);
      this.log.warn(`[PLATFORM] Retrying platform startup in ${Math.round(delay / 1000)} seconds`);
      this.scheduleStartupRetry(delay);
    }
  }

  private async connectCloud(): Promise<void> {
    const httpApi = this.httpApi;
    const amqpClient = this.amqpClient;
    if (!httpApi || !amqpClient) {
      throw new Error('Platform not initialized');
    }

    this.log.info('[PLATFORM] Connecting to Toshiba cloud API');

    await httpApi.login();
    if (this.isShuttingDown) {
      return;
    }

    const registration = await httpApi.registerMobileClient(this.sessionId);
    if (this.isShuttingDown) {
      return;
    }

    await amqpClient.connect(registration);
    if (this.isShuttingDown) {
      return;
    }

    this.connectionStateCache.clear();
    this.stateEndpointByDevice.clear();
    this.additionalInfoEndpointForbidden = false;

    this.scheduleTokenRefresh(registration.SasToken);
  }

  private async refreshSasToken(): Promise<void> {
    if (this.isShuttingDown || !this.httpApi || !this.amqpClient) {
      return;
    }

    await this.queueOperation(async () => {
      try {
        const httpApi = this.httpApi;
        if (!httpApi || this.isShuttingDown) {
          return;
        }

        const registration = await httpApi.registerMobileClient(this.sessionId);

        const amqpClient = this.amqpClient;
        if (!amqpClient || this.isShuttingDown) {
          this.log.debug('[PLATFORM] Skipping cloud registration refresh apply: platform is shutting down');
          return;
        }

        await amqpClient.connect(registration);

        if (this.isShuttingDown) {
          return;
        }

        this.scheduleTokenRefresh(registration.SasToken);
        this.log.info('[PLATFORM] Refreshed Toshiba cloud registration');
      } catch (error) {
        if (this.isShuttingDown) {
          return;
        }

        if (error instanceof ToshibaAuthError) {
          this.log.warn('[PLATFORM] Token refresh rejected by cloud auth; reconnecting full session');
          try {
            await this.connectCloud();
            return;
          } catch (reconnectError) {
            this.log.error(`[PLATFORM] Full reconnect after token refresh auth failure failed: ${this.errorToString(reconnectError)}`);
          }
        }

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
    if (this.isShuttingDown) {
      return;
    }

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    if (!sasToken) {
      this.log.debug('[PLATFORM] Toshiba registration did not include SAS token; periodic token refresh disabled');
      return;
    }

    const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days

    const delay = this.calculateTokenRefreshDelayMs(sasToken);
    const safeDelay = Math.min(delay, MAX_TIMEOUT_MS);

    this.log.debug(`[PLATFORM] Scheduling SAS token refresh in ${(safeDelay / 1000).toFixed(0)} seconds`);

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshSasToken().catch(error => {
        this.log.error(`[PLATFORM] Unexpected error while refreshing token: ${this.errorToString(error)}`);
      });
    }, safeDelay);
    this.tokenRefreshTimer.unref?.();
  }

  private scheduleTokenRefreshRetry(): void {
    if (this.isShuttingDown) {
      return;
    }

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshSasToken().catch(error => {
        this.log.error(`[PLATFORM] Unexpected error while refreshing token: ${this.errorToString(error)}`);
      });
    }, TOKEN_REFRESH_RETRY_DELAY_MS);
    this.tokenRefreshTimer.unref?.();
  }

  private calculateTokenRefreshDelayMs(sasToken: string): number {
    const signature = sasToken.trim().startsWith('SharedAccessSignature ')
      ? sasToken.trim().slice('SharedAccessSignature '.length)
      : sasToken.trim();
    const tokenParts = signature.split('&');
    const expirationPart = tokenParts.find(part => part.toLowerCase().startsWith('se='));
    let expirationRaw = '';
    if (expirationPart) {
      const encodedExpiration = expirationPart.split('=')[1] ?? '';
      try {
        expirationRaw = decodeURIComponent(encodedExpiration);
      } catch {
        expirationRaw = encodedExpiration;
      }
    }
    const expiration = Number.parseInt(expirationRaw, 10);

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
    const discoveredUniqueIds = new Set<string>();
    const discoveredConnectionStateUniqueIds = new Set<string>();

    for (const discovered of discoveredDevices) {
      const uniqueIdKey = this.normalizeCloudIdentifier(discovered.uniqueId);
      if (!uniqueIdKey) {
        this.log.warn(`[PLATFORM] Skipping discovered device with malformed uniqueId (${discovered.name})`);
        continue;
      }

      if (discoveredUniqueIds.has(uniqueIdKey)) {
        this.log.warn(`[PLATFORM] Duplicate discovered device uniqueId ${discovered.uniqueId}; skipping duplicate entry (${discovered.name})`);
        continue;
      }
      discoveredUniqueIds.add(uniqueIdKey);
      discoveredConnectionStateUniqueIds.add(discovered.uniqueId);

      try {
        let device = this.devicesByUniqueId.get(uniqueIdKey);
        const shouldFetchAdditionalInfo = !device || !device.hasAdditionalInfo;
        let additionalInfo;

        if (shouldFetchAdditionalInfo && !this.additionalInfoEndpointForbidden) {
          try {
            additionalInfo = await this.httpApi.getDeviceAdditionalInfo(discovered.acId, discovered.uniqueId);
          } catch (error) {
            if (error instanceof ToshibaAuthError) {
              this.log.error(`[PLATFORM] Authentication failed while fetching details for ${discovered.name}; reconnecting cloud session`);
              try {
                await this.connectCloud();
                additionalInfo = await this.httpApi.getDeviceAdditionalInfo(discovered.acId, discovered.uniqueId);
              } catch (retryError) {
                if (this.isHttpForbidden(retryError)) {
                  this.additionalInfoEndpointForbidden = true;
                  this.log.info('[PLATFORM] Additional-info endpoint returned HTTP 403; disabling additional-info fetches for this session');
                } else {
                  this.log.warn(`[PLATFORM] Failed to fetch additional info for ${discovered.name}: ${this.errorToString(retryError)}`);
                }
              }
            } else if (this.isHttpForbidden(error)) {
              this.additionalInfoEndpointForbidden = true;
              this.log.info('[PLATFORM] Additional-info endpoint returned HTTP 403; disabling additional-info fetches for this session');
            } else {
              this.log.warn(`[PLATFORM] Failed to fetch additional info for ${discovered.name}: ${this.errorToString(error)}`);
            }
          }
        }

        if (!device) {
          device = new ToshibaAcDevice(
            this.log,
            this.amqpClient,
            discovered,
            additionalInfo,
            async (uniqueId, name) => this.ensureDeviceOnline(uniqueId, name),
          );
          this.devicesByUniqueId.set(uniqueIdKey, device);
        } else {
          device.updateIdentity(discovered.name);
          device.updateAdditionalInfo(additionalInfo);
          device.applyCloudState(discovered.stateHex);
        }

        const uuid = this.api.hap.uuid.generate(`toshiba-smart-ac:${uniqueIdKey}`);
        discoveredAccessoryUuids.add(uuid);

        const existingAccessory = this.accessories.get(uuid);
        if (existingAccessory) {
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

          existingAccessory.context.uniqueId = uniqueIdKey;
          existingAccessory.context.acId = discovered.acId;

          const handler = this.accessoryHandlers.get(uuid);
          if (handler) {
            handler.setDevice(device);
          } else {
            this.accessoryHandlers.set(uuid, new ToshibaPlatformAccessory(this, existingAccessory, device));
          }

          this.api.updatePlatformAccessories([existingAccessory]);
        } else {
          this.log.info('Adding new accessory:', discovered.name);

          const accessory = new this.api.platformAccessory(discovered.name, uuid);
          accessory.context.uniqueId = uniqueIdKey;
          accessory.context.acId = discovered.acId;

          this.accessories.set(uuid, accessory);
          this.accessoryHandlers.set(uuid, new ToshibaPlatformAccessory(this, accessory, device));

          try {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          } catch (error) {
            if (!this.isAlreadyBridgedAccessoryError(error)) {
              const failedHandler = this.accessoryHandlers.get(uuid);
              failedHandler?.dispose?.();
              this.accessoryHandlers.delete(uuid);
              this.accessories.delete(uuid);
              throw error;
            }

            // Homebridge v2 can pre-bridge platform accessories before explicit registration.
            // Keep the accessory active and persist context without surfacing noisy startup errors.
            this.log.debug(`[PLATFORM] Accessory ${accessory.displayName} was already bridged; continuing`);
            this.api.updatePlatformAccessories([accessory]);
          }
        }
      } catch (error) {
        this.log.error(
          `[PLATFORM] Failed to process discovered device ${discovered.name} (${discovered.uniqueId}): ${this.errorToString(error)}`,
        );
      }
    }

    await this.refreshDeviceConnectionStates([...discoveredConnectionStateUniqueIds]);
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
        const uniqueIdKey = this.normalizeCloudIdentifier(uniqueId);
        const device = this.devicesByUniqueId.get(uniqueIdKey);
        device?.dispose();
        this.devicesByUniqueId.delete(uniqueIdKey);
        if (device) {
          this.connectionStateCache.delete(device.uniqueId);
          this.stateEndpointByDevice.delete(device.uniqueId);
        }
        this.connectionStateCache.delete(uniqueIdKey);
        this.stateEndpointByDevice.delete(uniqueIdKey);
        this.connectionStateCache.delete(uniqueId);
        this.stateEndpointByDevice.delete(uniqueId);
      }
    }
  }

  private startStatePolling(): void {
    if (this.statePollTimer) {
      clearInterval(this.statePollTimer);
      this.statePollTimer = undefined;
    }

    const pollIntervalSeconds = this.normalizeIntegerConfig(
      this.config.pollIntervalSeconds,
      DEFAULT_STATE_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS,
      MAX_POLL_INTERVAL_SECONDS,
      'pollIntervalSeconds',
    );
    const pollIntervalMs = pollIntervalSeconds * 1000;

    this.log.info(`[PLATFORM] Enabled state polling every ${Math.round(pollIntervalMs / 1000)} seconds`);

    this.statePollTimer = setInterval(() => {
      if (this.stateRefreshInProgress) {
        this.log.debug('[PLATFORM] Skipping state refresh tick: previous refresh still in progress');
        return;
      }

      this.stateRefreshInProgress = true;
      this.refreshStates().catch(error => {
        this.log.error(`[PLATFORM] State refresh failed: ${this.errorToString(error)}`);
      }).finally(() => {
        this.stateRefreshInProgress = false;
      });
    }, pollIntervalMs);
    this.statePollTimer.unref?.();
  }

  private startDiscoveryRefresh(): void {
    if (this.discoveryRefreshTimer) {
      clearInterval(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = undefined;
    }

    const intervalMinutes = this.normalizeIntegerConfig(
      this.config.discoveryRefreshMinutes,
      DEFAULT_DISCOVERY_REFRESH_MINUTES,
      MIN_DISCOVERY_REFRESH_MINUTES,
      MAX_DISCOVERY_REFRESH_MINUTES,
      'discoveryRefreshMinutes',
    );
    const intervalMs = intervalMinutes * 60 * 1000;

    this.discoveryRefreshTimer = setInterval(() => {
      if (this.discoveryRefreshInProgress) {
        this.log.debug('[PLATFORM] Skipping rediscovery tick: previous rediscovery still in progress');
        return;
      }

      this.discoveryRefreshInProgress = true;
      this.queueOperation(async () => {
        try {
          await this.discoverDevices();
        } catch (error) {
          this.log.error(`[PLATFORM] Periodic discovery failed: ${this.errorToString(error)}`);
        }
      }).catch(error => {
        this.log.error(`[PLATFORM] Discovery queue failure: ${this.errorToString(error)}`);
      }).finally(() => {
        this.discoveryRefreshInProgress = false;
      });
    }, intervalMs);
    this.discoveryRefreshTimer.unref?.();

    this.log.info(`[PLATFORM] Enabled periodic rediscovery every ${intervalMinutes} minutes`);
  }

  private async refreshStates(): Promise<void> {
    if (this.isShuttingDown || !this.httpApi) {
      return;
    }

    await this.queueOperation(async () => {
      await this.refreshDeviceConnectionStates([...this.devicesByUniqueId.values()].map(device => device.uniqueId));

      for (const device of this.devicesByUniqueId.values()) {
        if (this.getDeviceCloudConnectionState(device.uniqueId) === 'offline') {
          this.log.debug(`[PLATFORM] Skipping state refresh for ${device.name}: device reported offline`);
          continue;
        }

        try {
          const latestState = await this.fetchLatestStateForDevice(device);
          if (!latestState) {
            continue;
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

  private async fetchLatestStateForDevice(device: ToshibaAcDevice): Promise<string | undefined> {
    if (!this.httpApi) {
      return undefined;
    }

    const status = this.getStateEndpointStatus(device.uniqueId);
    const now = Date.now();

    if (
      status.uniqueForbidden &&
      status.acIdForbidden &&
      typeof status.nextForbiddenProbeAt === 'number' &&
      now < status.nextForbiddenProbeAt
    ) {
      return undefined;
    }

    if (status.uniqueForbidden && status.acIdForbidden) {
      status.uniqueForbidden = false;
      status.acIdForbidden = false;
      status.nextForbiddenProbeAt = undefined;
      this.log.debug(`[PLATFORM] Re-probing polling state endpoints for ${device.name}`);
    }

    const endpoints: ToshibaStateEndpoint[] = status.preferred === 'acid'
      ? ['acid', 'unique']
      : ['unique', 'acid'];

    let lastError: unknown;
    for (const endpoint of endpoints) {
      if ((endpoint === 'unique' && status.uniqueForbidden) || (endpoint === 'acid' && status.acIdForbidden)) {
        continue;
      }

      try {
        const latestState = endpoint === 'unique'
          ? await this.httpApi.getDeviceStateByUniqueId(device.uniqueId)
          : await this.httpApi.getDeviceState(device.id);

        if (status.preferred !== endpoint) {
          this.log.info(
            `[PLATFORM] ${device.name}: switched polling state endpoint to ${this.describeStateEndpoint(endpoint)}`,
          );
        }
        status.preferred = endpoint;
        // A successful state fetch proves at least one path is currently valid.
        // Clear stale endpoint-forbidden flags so future failover can react immediately.
        status.uniqueForbidden = false;
        status.acIdForbidden = false;
        status.nextForbiddenWarningAt = undefined;
        status.nextForbiddenProbeAt = undefined;

        this.stateEndpointByDevice.set(device.uniqueId, status);
        return latestState;
      } catch (error) {
        if (error instanceof ToshibaAuthError) {
          throw error;
        }

        lastError = error;
        if (this.isHttpForbidden(error)) {
          this.markStateEndpointForbidden(status, endpoint, device.name);
          continue;
        }

        if (error instanceof ToshibaApiError) {
          const endpointLabel = this.describeStateEndpoint(endpoint);
          const reason = this.errorToString(error);
          this.log.debug(
            `[PLATFORM] ${endpointLabel} state fetch failed for ${device.name} ` +
            `(${device.uniqueId}); trying alternate endpoint: ${reason}`,
          );
          continue;
        }

        break;
      }
    }

    this.stateEndpointByDevice.set(device.uniqueId, status);
    if (status.uniqueForbidden && status.acIdForbidden) {
      this.handleBothPollingStateEndpointsForbidden(status, device.name);
      return undefined;
    }

    if (lastError) {
      throw lastError;
    }

    return undefined;
  }

  private getStateEndpointStatus(uniqueId: string): ToshibaStateEndpointStatus {
    const existing = this.stateEndpointByDevice.get(uniqueId);
    if (existing) {
      return existing;
    }

    const created: ToshibaStateEndpointStatus = {
      preferred: 'unique',
      uniqueForbidden: false,
      acIdForbidden: false,
    };
    this.stateEndpointByDevice.set(uniqueId, created);
    return created;
  }

  private markStateEndpointForbidden(
    status: ToshibaStateEndpointStatus,
    endpoint: ToshibaStateEndpoint,
    deviceName: string,
  ): void {
    if (endpoint === 'unique') {
      if (!status.uniqueForbidden) {
        this.log.info(`[PLATFORM] ${deviceName}: unique-device-id state endpoint returned HTTP 403; trying ACId endpoint`);
      }
      status.uniqueForbidden = true;
      return;
    }

    if (!status.acIdForbidden) {
      this.log.info(`[PLATFORM] ${deviceName}: ACId state endpoint returned HTTP 403; trying unique-device-id endpoint`);
    }
    status.acIdForbidden = true;
  }

  private handleBothPollingStateEndpointsForbidden(status: ToshibaStateEndpointStatus, deviceName: string): void {
    const now = Date.now();
    if (!status.nextForbiddenWarningAt || now >= status.nextForbiddenWarningAt) {
      this.log.info(
        `[PLATFORM] ${deviceName}: both polling state endpoints returned HTTP 403; polling paused and AMQP updates will be used`,
      );
      status.nextForbiddenWarningAt = now + STATE_ENDPOINT_BOTH_FORBIDDEN_LOG_INTERVAL_MS;
    }
    status.nextForbiddenProbeAt = now + STATE_ENDPOINT_FORBIDDEN_PROBE_INTERVAL_MS;
  }

  private describeStateEndpoint(endpoint: ToshibaStateEndpoint): string {
    return endpoint === 'unique' ? 'unique-device-id' : 'ACId';
  }

  private handleCloudStateUpdate(sourceId: string, payload: Record<string, unknown>): void {
    const device = this.findDeviceByCloudSourceId(sourceId);
    if (!device) {
      this.log.debug(`[AMQP API] Ignoring cloud state update for unknown device: ${sourceId}`);
      return;
    }

    const state = payload.data;
    if (typeof state !== 'string') {
      this.log.warn(`[AMQP API] Received malformed state update for ${device.name}`);
      return;
    }

    try {
      device.applyCloudState(state);
    } catch (error) {
      this.log.warn(`[AMQP API] Failed to apply state update for ${device.name}: ${this.errorToString(error)}`);
    }
  }

  private handleCloudHeartbeat(sourceId: string, payload: Record<string, unknown>): void {
    const device = this.findDeviceByCloudSourceId(sourceId);
    if (!device) {
      this.log.debug(`[AMQP API] Ignoring heartbeat for unknown device: ${sourceId}`);
      return;
    }

    try {
      device.applyHeartbeat(payload);
    } catch (error) {
      this.log.warn(`[AMQP API] Failed to apply heartbeat for ${device.name}: ${this.errorToString(error)}`);
    }
  }

  private async queueOperation(operation: () => Promise<void>): Promise<void> {
    // Serialize cloud operations so login/discovery/polling never race each other.
    const run = async (): Promise<void> => {
      if (this.isShuttingDown) {
        return;
      }

      await operation();
    };

    const queued = this.operationQueue.then(run, run);
    this.operationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureDeviceOnline(uniqueId: string, deviceName: string): Promise<void> {
    if (!this.httpApi) {
      return;
    }

    const normalizedUniqueId = this.normalizeCloudIdentifier(uniqueId);
    const cachedState = this.connectionStateCache.get(normalizedUniqueId) ?? this.connectionStateCache.get(uniqueId);
    if (cachedState && (Date.now() - cachedState.updatedAt) <= DEVICE_CONNECTION_STATE_CACHE_TTL_MS) {
      if (this.isConnectedState(cachedState.state)) {
        return;
      }

      throw new Error(`[${deviceName}] Toshiba cloud reports device offline (${cachedState.state})`);
    }

    let states: ToshibaDeviceConnectionState[];
    try {
      states = await this.httpApi.getDeviceConnectionStates([uniqueId]);
    } catch (error) {
      if (error instanceof ToshibaAuthError) {
        this.log.warn(`[PLATFORM] Auth expired before command precheck for ${deviceName}; reconnecting cloud session`);

        try {
          await this.queueOperation(async () => {
            await this.connectCloud();
          });

          if (!this.httpApi || this.isShuttingDown) {
            this.log.warn(`[PLATFORM] Skipping device online precheck retry for ${deviceName}; platform is shutting down`);
            return;
          }

          states = await this.httpApi.getDeviceConnectionStates([uniqueId]);
        } catch (retryError) {
          this.log.warn(
            `[PLATFORM] Device online precheck failed for ${deviceName} after reconnect; allowing command: ${this.errorToString(retryError)}`,
          );
          return;
        }
      } else {
        this.log.warn(
          `[PLATFORM] Device online precheck failed for ${deviceName}; allowing command: ${this.errorToString(error)}`,
        );
        return;
      }
    }
    const state = states.find(item => (
      typeof item.DeviceId === 'string' &&
      this.normalizeCloudIdentifier(item.DeviceId) === normalizedUniqueId
    ));

    if (!state) {
      this.updateConnectionStateCache(normalizedUniqueId, MISSING_DEVICE_CONNECTION_STATE);
      throw new Error(`[${deviceName}] Toshiba cloud did not return device connection state`);
    }

    const connectionState = typeof state.ConnectionState === 'string' ? state.ConnectionState.trim() : '';
    if (!connectionState) {
      this.updateConnectionStateCache(normalizedUniqueId, MALFORMED_DEVICE_CONNECTION_STATE);
      throw new Error(`[${deviceName}] Toshiba cloud returned malformed device connection state`);
    }

    this.updateConnectionStateCache(normalizedUniqueId, connectionState);

    if (this.isConnectedState(connectionState)) {
      return;
    }

    throw new Error(`[${deviceName}] Toshiba cloud reports device offline (${connectionState})`);
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

    if (this.startupRetryTimer) {
      clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }

    for (const handler of this.accessoryHandlers.values()) {
      handler.dispose?.();
    }

    this.accessoryHandlers.clear();

    for (const device of this.devicesByUniqueId.values()) {
      device.dispose();
    }
    this.devicesByUniqueId.clear();
    this.connectionStateCache.clear();
    this.stateEndpointByDevice.clear();

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

  private isHttpForbidden(error: unknown): boolean {
    return error instanceof ToshibaApiError && error.httpStatus === 403;
  }

  private isAlreadyBridgedAccessoryError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return message.includes('already bridged');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private isConnectedState(state: string): boolean {
    const normalized = state.trim().toLowerCase();
    return normalized === 'connected' || normalized === 'online';
  }

  private async refreshDeviceConnectionStates(uniqueIds: string[]): Promise<void> {
    if (!this.httpApi || uniqueIds.length === 0 || this.isShuttingDown) {
      return;
    }

    const requestUniqueIds: string[] = [];
    const normalizedUniqueIds: string[] = [];
    const seenUniqueIds = new Set<string>();
    for (const uniqueId of uniqueIds) {
      const normalizedUniqueId = this.normalizeCloudIdentifier(uniqueId);
      if (!normalizedUniqueId || seenUniqueIds.has(normalizedUniqueId)) {
        continue;
      }

      seenUniqueIds.add(normalizedUniqueId);
      requestUniqueIds.push(uniqueId.trim());
      normalizedUniqueIds.push(normalizedUniqueId);
    }

    if (normalizedUniqueIds.length === 0) {
      return;
    }

    let states: ToshibaDeviceConnectionState[];
    try {
      states = await this.httpApi.getDeviceConnectionStates(requestUniqueIds);
    } catch (error) {
      if (error instanceof ToshibaAuthError) {
        this.log.warn('[PLATFORM] Auth expired while refreshing connection states; reconnecting cloud session');
        try {
          await this.connectCloud();
          if (!this.httpApi || this.isShuttingDown) {
            return;
          }
          states = await this.httpApi.getDeviceConnectionStates(requestUniqueIds);
        } catch (retryError) {
          this.log.warn(`[PLATFORM] Failed to refresh connection states after reconnect: ${this.errorToString(retryError)}`);
          return;
        }
      } else {
        this.log.warn(`[PLATFORM] Failed to refresh connection states: ${this.errorToString(error)}`);
        return;
      }
    }

    const connectionStateByDeviceId = new Map<string, string>();
    for (const state of states) {
      const uniqueIdKey = typeof state.DeviceId === 'string' ? this.normalizeCloudIdentifier(state.DeviceId) : '';
      const connectionState = typeof state.ConnectionState === 'string' ? state.ConnectionState.trim() : '';
      if (!uniqueIdKey || !connectionState) {
        continue;
      }

      connectionStateByDeviceId.set(uniqueIdKey, connectionState);
    }

    for (const uniqueId of normalizedUniqueIds) {
      const connectionState = connectionStateByDeviceId.get(uniqueId);
      if (!connectionState) {
        this.updateConnectionStateCache(uniqueId, MISSING_DEVICE_CONNECTION_STATE);
        continue;
      }

      this.updateConnectionStateCache(uniqueId, connectionState);
    }
  }

  private updateConnectionStateCache(uniqueId: string, connectionState: string): void {
    const uniqueIdKey = this.normalizeCloudIdentifier(uniqueId);
    if (!uniqueIdKey) {
      return;
    }

    const previous = this.connectionStateCache.get(uniqueIdKey);
    const normalizedConnectionState = connectionState.trim();
    this.connectionStateCache.set(uniqueIdKey, {
      state: normalizedConnectionState,
      updatedAt: Date.now(),
    });

    if (previous?.state === normalizedConnectionState) {
      return;
    }

    const device = this.devicesByUniqueId.get(uniqueIdKey);
    const deviceName = device?.name ?? uniqueIdKey;
    if (this.isConnectedState(normalizedConnectionState)) {
      this.log.info(`[PLATFORM] ${deviceName}: cloud connection restored (${normalizedConnectionState})`);
    } else {
      this.log.info(`[PLATFORM] ${deviceName}: cloud reports device offline (${normalizedConnectionState})`);
    }

    const accessoryUuid = this.api.hap.uuid.generate(`toshiba-smart-ac:${uniqueIdKey}`);
    this.accessoryHandlers.get(accessoryUuid)?.refreshFromPlatform();
  }

  private findDeviceByCloudSourceId(sourceId: string): ToshibaAcDevice | undefined {
    const normalized = this.normalizeCloudIdentifier(sourceId);
    if (!normalized) {
      return undefined;
    }

    const exact = this.devicesByUniqueId.get(normalized);
    if (exact) {
      return exact;
    }

    for (const device of this.devicesByUniqueId.values()) {
      if (
        this.normalizeCloudIdentifier(device.uniqueId) === normalized ||
        this.normalizeCloudIdentifier(device.id) === normalized
      ) {
        return device;
      }
    }

    return undefined;
  }

  private normalizeCloudIdentifier(value: string): string {
    const trimmed = value.trim();
    const withoutBraces = trimmed.replace(/^\{+|\}+$/g, '');
    return withoutBraces.toLowerCase();
  }

  private normalizeIntegerConfig(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    key: string,
  ): number {
    let parsed: number;
    if (typeof value === 'number') {
      parsed = value;
    } else if (typeof value === 'string' && value.trim().length > 0) {
      parsed = Number(value.trim());
    } else {
      parsed = Number.NaN;
    }

    if (!Number.isFinite(parsed)) {
      if (typeof value !== 'undefined') {
        this.log.warn(`[PLATFORM] Invalid config "${key}" value "${String(value)}"; using default ${fallback}`);
      }
      return fallback;
    }

    const rounded = Math.round(parsed);
    const bounded = Math.max(min, Math.min(max, rounded));
    if (bounded !== rounded) {
      this.log.warn(`[PLATFORM] Config "${key}" out of range (${rounded}); clamped to ${bounded}`);
    }

    return bounded;
  }

  private scheduleStartupRetry(delayMs: number): void {
    if (this.isShuttingDown || this.startupRetryTimer) {
      return;
    }

    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = undefined;
      this.start().catch(error => {
        this.log.error(`[PLATFORM] Unexpected startup retry failure: ${this.errorToString(error)}`);
      });
    }, delayMs);
    this.startupRetryTimer.unref?.();
  }
}
