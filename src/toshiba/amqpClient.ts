import { randomUUID } from 'node:crypto';

import type { Logging } from 'homebridge';

import type { DeviceMethodRequest, DeviceMethodResponse } from 'azure-iot-device';
import azureIotDevice from 'azure-iot-device';
import { Amqp } from 'azure-iot-device-amqp';

import { AMQP_METHOD_NAME, CMD_FCU_TO_AC } from './constants.js';
import type { ToshibaMobileRegistration } from './types.js';
import type { ToshibaAmqpMethodPayload } from './types.js';

export type ToshibaAmqpCommandHandler = (payload: ToshibaAmqpMethodPayload) => Promise<void> | void;
const AMQP_OPEN_TIMEOUT_MS = 30_000;
const AMQP_SEND_TIMEOUT_MS = 20_000;
const AMQP_CLOSE_TIMEOUT_MS = 10_000;

export class ToshibaAmqpClient {
  private client?: azureIotDevice.Client;
  private readonly handlers = new Map<string, ToshibaAmqpCommandHandler>();
  private connectionLossHandler?: (error?: Error) => Promise<void> | void;
  private isIntentionalDisconnect = false;
  private isConnected = false;
  private connectionLossNotified = false;

  constructor(
    private readonly log: Logging,
    private readonly sessionId: string,
  ) {}

  registerCommandHandler(command: string, handler: ToshibaAmqpCommandHandler): void {
    this.handlers.set(command, handler);
  }

  setConnectionLossHandler(handler: (error?: Error) => Promise<void> | void): void {
    this.connectionLossHandler = handler;
  }

  async connect(registration: ToshibaMobileRegistration): Promise<void> {
    await this.disconnect();

    this.isIntentionalDisconnect = false;
    this.isConnected = false;
    this.connectionLossNotified = false;
    this.client = this.createClient(registration);
    const client = this.client;

    client.on('error', (error: Error) => {
      this.log.warn(`[AMQP API] Transport error: ${error.message}`);
    });
    client.on('disconnect', (error?: Error) => {
      this.isConnected = false;
      if (this.isIntentionalDisconnect) {
        return;
      }

      this.log.warn(`[AMQP API] Cloud connection lost: ${error?.message ?? 'unknown reason'}`);
      this.invokeConnectionLossHandler(error);
    });

    client.onDeviceMethod(AMQP_METHOD_NAME, async (request: DeviceMethodRequest, response: DeviceMethodResponse) => {
      await this.handleMethodRequest(request, response);
    });

    await this.withTimeout(new Promise<void>((resolve, reject) => {
      client.open((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }), AMQP_OPEN_TIMEOUT_MS, 'Timed out opening AMQP connection');

    this.isConnected = true;
    this.connectionLossNotified = false;
    this.log.info('[AMQP API] Connected to Toshiba cloud push channel');
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      this.isConnected = false;
      return;
    }

    this.isIntentionalDisconnect = true;
    this.isConnected = false;
    const client = this.client;
    this.client = undefined;

    try {
      await this.withTimeout(new Promise<void>((resolve) => {
        client.close((error?: Error | null) => {
          if (error) {
            this.log.warn(`[AMQP API] Error while disconnecting AMQP client: ${error.message}`);
          }
          resolve();
        });
      }), AMQP_CLOSE_TIMEOUT_MS, 'Timed out closing AMQP connection');
    } catch (error) {
      this.log.warn(`[AMQP API] AMQP close timeout: ${this.errorToString(error)}`);
    } finally {
      client.removeAllListeners();
    }

    this.log.info('[AMQP API] Disconnected from Toshiba cloud push channel');
  }

  async sendState(deviceUniqueId: string, stateHex: string): Promise<void> {
    const messagePayload = {
      sourceId: this.sessionId,
      messageId: randomUUID(),
      targetId: [deviceUniqueId],
      cmd: CMD_FCU_TO_AC,
      payload: {
        data: stateHex,
      },
      timeStamp: this.generateEventTimestamp(),
    };

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const client = this.client;
        if (!client || !this.isConnected) {
          throw new Error('AMQP client is not connected');
        }

        const message = new azureIotDevice.Message(JSON.stringify(messagePayload));
        message.properties.add('type', 'mob');
        message.contentType = 'application/json';
        message.contentEncoding = 'utf-8';

        await this.withTimeout(new Promise<void>((resolve, reject) => {
          client.sendEvent(message, (error?: Error | null) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }), AMQP_SEND_TIMEOUT_MS, 'Timed out sending AMQP event');

        this.log.debug(`[AMQP API] Sent ${stateHex} to ${deviceUniqueId}`);
        return;
      } catch (error) {
        lastError = error;
        if (this.isConnectionProblem(error)) {
          this.isConnected = false;
          if (!this.connectionLossNotified) {
            this.log.warn('[AMQP API] Send failed due to connection issue; requesting reconnect');
          }
          this.invokeConnectionLossHandler(error instanceof Error ? error : undefined);
        }

        if (attempt >= maxAttempts) {
          break;
        }

        const delay = attempt * 500;
        this.log.warn(`[AMQP API] Send failed for ${deviceUniqueId} (attempt ${attempt}/${maxAttempts}): ${this.errorToString(error)}. Retrying in ${delay}ms`);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private invokeConnectionLossHandler(error?: Error): void {
    if (!this.connectionLossHandler) {
      return;
    }

    if (this.connectionLossNotified) {
      return;
    }

    this.connectionLossNotified = true;
    Promise.resolve(this.connectionLossHandler(error)).catch(handlerError => {
      this.connectionLossNotified = false;
      this.log.error(`[AMQP API] Connection loss handler failed: ${this.errorToString(handlerError)}`);
    });
  }

  private createClient(registration: ToshibaMobileRegistration): azureIotDevice.Client {
    if (typeof registration.SasToken === 'string' && registration.SasToken.length > 0) {
      return azureIotDevice.Client.fromSharedAccessSignature(registration.SasToken, Amqp);
    }

    if (
      typeof registration.HostName === 'string' &&
      registration.HostName.length > 0 &&
      typeof registration.DeviceId === 'string' &&
      registration.DeviceId.length > 0 &&
      typeof registration.PrimaryKey === 'string' &&
      registration.PrimaryKey.length > 0
    ) {
      const connectionString = `HostName=${registration.HostName};DeviceId=${registration.DeviceId};SharedAccessKey=${registration.PrimaryKey}`;
      return azureIotDevice.Client.fromConnectionString(connectionString, Amqp);
    }

    throw new Error('Missing AMQP registration data from Toshiba API');
  }

  private async handleMethodRequest(request: DeviceMethodRequest, response: DeviceMethodResponse): Promise<void> {
    if (!request || typeof request.payload !== 'object' || request.payload === null) {
      this.sendMethodResponse(response, 400);
      return;
    }

    const payload = request.payload as Record<string, unknown>;
    const command = payload.cmd;

    if (typeof command !== 'string') {
      this.sendMethodResponse(response, 400);
      return;
    }

    const innerPayload = payload.payload;
    const normalizedPayload: ToshibaAmqpMethodPayload = {
      sourceId: typeof payload.sourceId === 'string' ? payload.sourceId : '',
      messageId: typeof payload.messageId === 'string' ? payload.messageId : '',
      targetId: Array.isArray(payload.targetId) ? payload.targetId : [],
      cmd: command,
      payload: typeof innerPayload === 'object' && innerPayload !== null ? innerPayload as Record<string, unknown> : {},
      timeStamp: typeof payload.timeStamp === 'string' ? payload.timeStamp : '',
    };

    const handler = this.handlers.get(command);
    if (!handler) {
      this.log.debug(`[AMQP API] Ignoring unhandled command: ${command}`);
      this.sendMethodResponse(response, 200);
      return;
    }

    try {
      await handler(normalizedPayload);
      this.sendMethodResponse(response, 200);
    } catch (error) {
      this.log.error(`[AMQP API] Failed to process ${command}: ${this.errorToString(error)}`);
      this.sendMethodResponse(response, 500);
    }
  }

  private sendMethodResponse(response: DeviceMethodResponse, statusCode: number): void {
    response.send(statusCode, undefined, (error?: Error | null) => {
      if (error) {
        this.log.warn(`[AMQP API] Failed to send method response: ${error.message}`);
      }
    });
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

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      timer.unref?.();

      promise.then(value => {
        clearTimeout(timer);
        resolve(value);
      }).catch(error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private isConnectionProblem(error: unknown): boolean {
    const text = this.errorToString(error).toLowerCase();
    return (
      text.includes('not connected') ||
      text.includes('disconnected') ||
      text.includes('timed out') ||
      text.includes('transport') ||
      text.includes('socket')
    );
  }

  private generateEventTimestamp(): string {
    const now = new Date();
    const hours = now.getUTCHours().toString().padStart(2, '0');
    const minutes = now.getUTCMinutes().toString().padStart(2, '0');
    const seconds = now.getUTCSeconds().toString().padStart(2, '0');
    const fractional = (now.getUTCMilliseconds() * 10_000).toString().padStart(7, '0');
    return `${hours}:${minutes}:${seconds}.${fractional}`;
  }
}
