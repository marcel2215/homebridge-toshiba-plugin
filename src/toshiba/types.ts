export enum ToshibaAcStatus {
  ON = 'ON',
  OFF = 'OFF',
  NONE = 'NONE',
}

export enum ToshibaAcMode {
  AUTO = 'AUTO',
  COOL = 'COOL',
  HEAT = 'HEAT',
  DRY = 'DRY',
  FAN = 'FAN',
  NONE = 'NONE',
}

export enum ToshibaAcFanMode {
  AUTO = 'AUTO',
  QUIET = 'QUIET',
  LOW = 'LOW',
  MEDIUM_LOW = 'MEDIUM_LOW',
  MEDIUM = 'MEDIUM',
  MEDIUM_HIGH = 'MEDIUM_HIGH',
  HIGH = 'HIGH',
  NONE = 'NONE',
}

export enum ToshibaAcSwingMode {
  OFF = 'OFF',
  SWING_VERTICAL = 'SWING_VERTICAL',
  SWING_HORIZONTAL = 'SWING_HORIZONTAL',
  SWING_VERTICAL_AND_HORIZONTAL = 'SWING_VERTICAL_AND_HORIZONTAL',
  FIXED_1 = 'FIXED_1',
  FIXED_2 = 'FIXED_2',
  FIXED_3 = 'FIXED_3',
  FIXED_4 = 'FIXED_4',
  FIXED_5 = 'FIXED_5',
  NONE = 'NONE',
}

export enum ToshibaAcPowerSelection {
  POWER_50 = 'POWER_50',
  POWER_75 = 'POWER_75',
  POWER_100 = 'POWER_100',
  NONE = 'NONE',
}

export enum ToshibaAcMeritB {
  FIREPLACE_1 = 'FIREPLACE_1',
  FIREPLACE_2 = 'FIREPLACE_2',
  OFF = 'OFF',
  NONE = 'NONE',
}

export enum ToshibaAcMeritA {
  HIGH_POWER = 'HIGH_POWER',
  CDU_SILENT_1 = 'CDU_SILENT_1',
  ECO = 'ECO',
  HEATING_8C = 'HEATING_8C',
  SLEEP_CARE = 'SLEEP_CARE',
  FLOOR = 'FLOOR',
  COMFORT = 'COMFORT',
  CDU_SILENT_2 = 'CDU_SILENT_2',
  OFF = 'OFF',
  NONE = 'NONE',
}

export enum ToshibaAcAirPureIon {
  OFF = 'OFF',
  ON = 'ON',
  NONE = 'NONE',
}

export enum ToshibaAcSelfCleaning {
  ON = 'ON',
  OFF = 'OFF',
  NONE = 'NONE',
}

export interface ToshibaApiEnvelope<T> {
  IsSuccess: boolean;
  Message: string;
  StatusCode?: string;
  ResObj: T;
}

export interface ToshibaAuthToken {
  access_token: string;
  token_type: string;
  expires_in?: number;
  consumerId: string;
  consumerMasterId?: string;
  countryId?: number;
}

export interface ToshibaAcMappingGroup {
  GroupId: string;
  GroupName: string;
  ACList: ToshibaMappedAc[];
}

export interface ToshibaMappedAc {
  Id: string;
  DeviceUniqueId: string;
  Name: string;
  ACModelId: string;
  MeritFeature: string;
  OpeMode?: string;
  SystemConfig?: string;
  ACStateData: string;
  AdapterType?: string;
  FirmwareVersion?: string;
}

export interface ToshibaDiscoveredDevice {
  acId: string;
  uniqueId: string;
  name: string;
  groupId: string;
  groupName: string;
  acModelId: string;
  meritFeature: string;
  opeMode?: string;
  systemConfig?: string;
  stateHex: string;
  adapterType?: string;
  firmwareVersion?: string;
}

export interface ToshibaAdditionalInfo {
  cduModelName?: string;
  cduSerialNumber?: string;
  fcuModelName?: string;
  fcuSerialNumber?: string;
}

export interface ToshibaDeviceStateResponse {
  ACStateData: string;
  Cdu?: {
    model_name?: string;
    serial_number?: string;
  };
  Fcu?: {
    model_name?: string;
    serial_number?: string;
  };
}

export interface ToshibaDeviceConnectionState {
  DeviceId: string;
  ConnectionState: string;
}

export interface ToshibaMobileRegistration {
  SasToken?: string;
  HostName?: string;
  DeviceId?: string;
  PrimaryKey?: string;
}

export interface ToshibaAmqpMethodPayload {
  sourceId: string;
  messageId: string;
  targetId: unknown[];
  cmd: string;
  payload: Record<string, unknown>;
  timeStamp: string;
}
