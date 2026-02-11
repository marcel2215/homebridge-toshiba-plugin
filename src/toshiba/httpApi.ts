import type { Logging } from 'homebridge';

import {
  API_AC_ALL_DEVICE_STATE_PATH,
  API_AC_MAPPING_PATH,
  API_AC_STATE_PATH,
  API_AC_STATE_BY_UNIQUE_ID_PATH,
  API_LOGIN_PATH,
  API_REGISTER_DEVICE_PATH,
  DEFAULT_HTTP_BACKOFF_MS,
  DEFAULT_HTTP_RETRIES,
  DEFAULT_HTTP_TIMEOUT_MS,
  TOSHIBA_BRAND_ID,
  TOSHIBA_API_BASE_URL,
  TOSHIBA_HTTP_USER_AGENT,
} from './constants.js';
import type {
  ToshibaAcMappingGroup,
  ToshibaAdditionalInfo,
  ToshibaApiEnvelope,
  ToshibaAuthToken,
  ToshibaDeviceConnectionState,
  ToshibaDeviceStateResponse,
  ToshibaDiscoveredDevice,
  ToshibaMobileRegistration,
} from './types.js';

export class ToshibaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: string,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class ToshibaAuthError extends ToshibaApiError {}

export interface ToshibaHttpApiOptions {
  username: string;
  password: string;
  timeoutMs?: number;
  retries?: number;
  retryBackoffMs?: number;
}

interface ToshibaRequestOptions {
  includeAuth?: boolean;
  includeConsumerId?: boolean;
  query?: Record<string, string>;
  body?: unknown;
}

export class ToshibaHttpApi {
  private accessToken = '';
  private tokenType = 'Bearer';
  private consumerId = '';

  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly normalizedUsername: string;

  constructor(
    private readonly log: Logging,
    private readonly options: ToshibaHttpApiOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_HTTP_RETRIES;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_HTTP_BACKOFF_MS;
    this.normalizedUsername = options.username.trim().toLowerCase();
  }

  async login(): Promise<void> {
    const token = await this.withRetry('login', async () => {
      const result = await this.request<ToshibaAuthToken>(API_LOGIN_PATH, {
        includeAuth: false,
        includeConsumerId: false,
        body: {
          Username: this.options.username,
          Password: this.options.password,
          BrandId: TOSHIBA_BRAND_ID,
        },
      });

      if (!result.access_token || !result.consumerId) {
        throw new ToshibaApiError('Malformed login response from Toshiba API');
      }

      return result;
    });

    this.accessToken = token.access_token;
    this.tokenType = token.token_type || 'Bearer';
    this.consumerId = token.consumerId;
  }

  async getDevices(): Promise<ToshibaDiscoveredDevice[]> {
    const groups = await this.withRetry('get devices', async () => {
      return this.request<ToshibaAcMappingGroup[]>(API_AC_MAPPING_PATH, {
        includeConsumerId: true,
      });
    });

    if (!Array.isArray(groups)) {
      throw new ToshibaApiError('Malformed device mapping payload: expected array');
    }

    const devices: ToshibaDiscoveredDevice[] = [];
    for (const [groupIndex, groupRaw] of groups.entries()) {
      if (typeof groupRaw !== 'object' || groupRaw === null) {
        this.log.warn(`[HTTP API] Skipping malformed device group at index ${groupIndex}`);
        continue;
      }

      const group = groupRaw as ToshibaAcMappingGroup;
      const groupId = typeof group.GroupId === 'string' && group.GroupId.length > 0 ? group.GroupId : `group-${groupIndex + 1}`;
      const groupName = typeof group.GroupName === 'string' && group.GroupName.length > 0 ? group.GroupName : groupId;
      const acList = Array.isArray(group.ACList) ? group.ACList : [];

      if (!Array.isArray(group.ACList)) {
        this.log.warn(`[HTTP API] Group ${groupId} has malformed ACList; skipping`);
        continue;
      }

      for (const [acIndex, acRaw] of acList.entries()) {
        if (typeof acRaw !== 'object' || acRaw === null) {
          this.log.warn(`[HTTP API] Skipping malformed AC entry in group ${groupId} at index ${acIndex}`);
          continue;
        }

        const ac = acRaw as ToshibaAcMappingGroup['ACList'][number];
        const hasRequiredFields = (
          typeof ac.Id === 'string' && ac.Id.length > 0 &&
          typeof ac.DeviceUniqueId === 'string' && ac.DeviceUniqueId.length > 0 &&
          typeof ac.Name === 'string' && ac.Name.length > 0 &&
          typeof ac.ACModelId === 'string' && ac.ACModelId.length > 0 &&
          typeof ac.MeritFeature === 'string' && ac.MeritFeature.length > 0 &&
          typeof ac.ACStateData === 'string' && ac.ACStateData.length > 0
        );

        if (!hasRequiredFields) {
          this.log.warn(`[HTTP API] Skipping AC entry with missing required fields in group ${groupId} at index ${acIndex}`);
          continue;
        }

        devices.push({
          acId: ac.Id,
          uniqueId: ac.DeviceUniqueId,
          name: ac.Name,
          groupId,
          groupName,
          acModelId: ac.ACModelId,
          meritFeature: ac.MeritFeature,
          opeMode: ac.OpeMode,
          systemConfig: ac.SystemConfig,
          stateHex: ac.ACStateData,
          adapterType: ac.AdapterType,
          firmwareVersion: ac.FirmwareVersion,
        });
      }
    }

    return devices;
  }

  async getDeviceState(acId: string): Promise<string> {
    const state = await this.fetchDeviceStateByAcId(acId);
    return this.extractAcStateData(state, acId);
  }

  async getDeviceStateByUniqueId(uniqueId: string): Promise<string> {
    const state = await this.fetchDeviceStateByUniqueId(uniqueId);
    return this.extractAcStateData(state, uniqueId);
  }

  async getDeviceConnectionStates(uniqueDeviceIds: string[]): Promise<ToshibaDeviceConnectionState[]> {
    if (uniqueDeviceIds.length === 0) {
      return [];
    }

    const response = await this.withRetry(`get all device state (${uniqueDeviceIds.length} devices)`, async () => {
      return this.request<ToshibaDeviceConnectionState[]>(API_AC_ALL_DEVICE_STATE_PATH, {
        includeConsumerId: false,
        body: uniqueDeviceIds,
      });
    });

    if (!Array.isArray(response)) {
      throw new ToshibaApiError('Malformed all-device-state payload from Toshiba API');
    }

    return response;
  }

  async getDeviceAdditionalInfo(acId: string, uniqueId?: string): Promise<ToshibaAdditionalInfo> {
    let state: ToshibaDeviceStateResponse;
    if (uniqueId) {
      try {
        state = await this.fetchDeviceStateByUniqueId(uniqueId);
      } catch (error) {
        if (error instanceof ToshibaAuthError) {
          throw error;
        }
        this.log.debug(`[HTTP API] Failed to fetch additional info by unique id (${uniqueId}), falling back to ACId (${acId})`);
        state = await this.fetchDeviceStateByAcId(acId);
      }
    } else {
      state = await this.fetchDeviceStateByAcId(acId);
    }

    return {
      cduModelName: state.Cdu?.model_name,
      cduSerialNumber: state.Cdu?.serial_number,
      fcuModelName: state.Fcu?.model_name,
      fcuSerialNumber: state.Fcu?.serial_number,
    };
  }

  async registerMobileClient(deviceId: string): Promise<ToshibaMobileRegistration> {
    const response = await this.withRetry('register mobile device', async () => {
      return this.request<ToshibaMobileRegistration>(API_REGISTER_DEVICE_PATH, {
        includeConsumerId: false,
        body: {
          DeviceID: `${this.normalizedUsername}_${deviceId}`,
          DeviceType: '1',
          Username: this.options.username,
        },
      });
    });

    const hasSasToken = typeof response.SasToken === 'string' && response.SasToken.length > 0;
    const hasConnectionKey =
      typeof response.HostName === 'string' &&
      response.HostName.length > 0 &&
      typeof response.DeviceId === 'string' &&
      response.DeviceId.length > 0 &&
      typeof response.PrimaryKey === 'string' &&
      response.PrimaryKey.length > 0;

    if (!hasSasToken && !hasConnectionKey) {
      throw new ToshibaApiError('Malformed register mobile device response: expected SasToken or HostName/DeviceId/PrimaryKey');
    }

    return response;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private async fetchDeviceStateByAcId(acId: string): Promise<ToshibaDeviceStateResponse> {
    return this.withRetry(`get device state (${acId})`, async () => {
      return this.request<ToshibaDeviceStateResponse>(API_AC_STATE_PATH, {
        includeConsumerId: false,
        query: {
          ACId: acId,
        },
      });
    });
  }

  private async fetchDeviceStateByUniqueId(uniqueId: string): Promise<ToshibaDeviceStateResponse> {
    return this.withRetry(`get device state (${uniqueId})`, async () => {
      return this.request<ToshibaDeviceStateResponse>(API_AC_STATE_BY_UNIQUE_ID_PATH, {
        includeConsumerId: false,
        query: {
          ACDeviceUniqueId: uniqueId,
        },
      });
    });
  }

  private extractAcStateData(state: ToshibaDeviceStateResponse, deviceIdentifier: string): string {
    if (!state.ACStateData || typeof state.ACStateData !== 'string') {
      throw new ToshibaApiError(`Malformed AC state payload for device ${deviceIdentifier}`);
    }

    return state.ACStateData;
  }

  private async withRetry<T>(action: string, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const maxAttempts = this.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (!this.shouldRetry(error) || attempt >= maxAttempts) {
          break;
        }

        const delay = this.computeRetryDelayMs(error, attempt);
        this.log.warn(`[HTTP API] ${action} failed (attempt ${attempt}/${maxAttempts}): ${this.errorToString(error)}. Retrying in ${delay}ms`);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof ToshibaAuthError) {
      return false;
    }

    if (error instanceof ToshibaApiError) {
      if (typeof error.httpStatus === 'number') {
        if (error.httpStatus === 401) {
          return false;
        }

        if (error.httpStatus === 408 || error.httpStatus === 429) {
          return true;
        }

        return error.httpStatus >= 500;
      }

      const statusCodeText = (error.statusCode ?? '').toLowerCase();
      if (statusCodeText.includes('toomanyrequest') || statusCodeText.includes('429')) {
        return true;
      }

      return true;
    }

    return true;
  }

  private computeRetryDelayMs(error: unknown, attempt: number): number {
    const exponentialBackoff = this.randomBackoff(attempt);
    if (error instanceof ToshibaApiError && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)) {
      return Math.max(exponentialBackoff, Math.max(0, error.retryAfterMs));
    }

    return exponentialBackoff;
  }

  private randomBackoff(attempt: number): number {
    const baseDelayMs = Math.pow(2, attempt) * 1000;
    const jitterMs = Math.floor(Math.random() * Math.max(1, this.retryBackoffMs));
    return baseDelayMs + jitterMs;
  }

  private async request<T>(path: string, opts?: ToshibaRequestOptions): Promise<T> {
    const includeAuth = opts?.includeAuth ?? true;
    const includeConsumerId = opts?.includeConsumerId ?? false;
    const query = new URLSearchParams();

    if (includeConsumerId && this.consumerId) {
      query.set('consumerId', this.consumerId);
    }

    for (const [key, value] of Object.entries(opts?.query ?? {})) {
      query.set(key, value);
    }

    const url = new URL(`${TOSHIBA_API_BASE_URL}${path}`);
    if (query.toString()) {
      url.search = query.toString();
    }

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('User-Agent', TOSHIBA_HTTP_USER_AGENT);

    if (includeAuth) {
      if (!this.accessToken || !this.tokenType) {
        throw new ToshibaApiError('Missing Toshiba API auth token, login is required before calling this endpoint.');
      }

      headers.set('Authorization', `${this.tokenType} ${this.accessToken}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const method = opts?.body ? 'POST' : 'GET';
      this.log.debug(`[HTTP API] ${method} ${url.toString()}`);

      const response = await fetch(url, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfterMs = response.status === 429 ? this.parseRetryAfterMs(response.headers.get('Retry-After')) : undefined;

        if (response.status === 401) {
          throw new ToshibaAuthError(`HTTP ${response.status} while calling ${path}`, 'Unauthorized', response.status);
        }

        if (response.status === 429) {
          throw new ToshibaApiError(`HTTP ${response.status} while calling ${path}`, 'TooManyRequests', response.status, retryAfterMs);
        }

        throw new ToshibaApiError(`HTTP ${response.status} while calling ${path}`, undefined, response.status, retryAfterMs);
      }

      let payloadRaw: unknown;
      try {
        payloadRaw = await response.json();
      } catch (error) {
        throw new ToshibaApiError(`Failed to parse Toshiba API response for ${path}: ${this.errorToString(error)}`, undefined, response.status);
      }

      if (typeof payloadRaw !== 'object' || payloadRaw === null) {
        throw new ToshibaApiError(`Malformed Toshiba API payload for ${path}: expected JSON object`, undefined, response.status);
      }

      const payload = payloadRaw as Partial<ToshibaApiEnvelope<T>>;
      const statusCode = typeof payload.StatusCode === 'string' ? payload.StatusCode : undefined;
      const message = typeof payload.Message === 'string' ? payload.Message : undefined;

      if (payload.IsSuccess !== true) {
        if (this.isAuthFailure(statusCode, message)) {
          throw new ToshibaAuthError(message || 'Toshiba API authentication failed', statusCode, response.status);
        }

        throw new ToshibaApiError(message || 'Toshiba API returned failure', statusCode, response.status);
      }

      if (!('ResObj' in payload)) {
        throw new ToshibaApiError(`Malformed Toshiba API payload for ${path}: missing ResObj`, undefined, response.status);
      }

      return payload.ResObj as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ToshibaApiError(`Request timeout after ${this.timeoutMs}ms while calling ${path}`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private parseRetryAfterMs(value: string | null): number | undefined {
    if (!value) {
      return undefined;
    }

    const trimmed = value.trim();
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1_000);
    }

    const retryDateMs = Date.parse(trimmed);
    if (Number.isFinite(retryDateMs)) {
      return Math.max(0, retryDateMs - Date.now());
    }

    return undefined;
  }

  private isAuthFailure(statusCode?: string, message?: string): boolean {
    const statusCodeText = (statusCode ?? '').toLowerCase();
    const messageText = (message ?? '').toLowerCase();
    return (
      statusCodeText === 'invalidusernameorpassword' ||
      statusCodeText.includes('unauthor') ||
      statusCodeText.includes('invalidtoken') ||
      statusCodeText.includes('expiredtoken') ||
      messageText.includes('invalid username') ||
      messageText.includes('invalid password') ||
      messageText.includes('unauthor') ||
      messageText.includes('token expired')
    );
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
