export const TOSHIBA_API_BASE_URL = 'https://mobileapi.toshibahomeaccontrols.com';

export const API_LOGIN_PATH = '/api/Consumer/Login';
export const API_REGISTER_DEVICE_PATH = '/api/Consumer/RegisterMobileDevice';
export const API_AC_MAPPING_PATH = '/api/AC/GetConsumerACMappingV2';
export const API_AC_STATE_PATH = '/api/AC/GetCurrentACStateV2';
export const API_AC_STATE_BY_UNIQUE_ID_PATH = '/api/AC/GetCurrentACStateByUniqueDeviceIdV2';
export const API_AC_ALL_DEVICE_STATE_PATH = '/api/AC/GetAllDeviceState';

export const TOSHIBA_BRAND_ID = '39635025-5BD1-45BD-AF8B-75E71CC90467';

export const AMQP_METHOD_NAME = 'smmobile';
export const CMD_HEARTBEAT = 'CMD_HEARTBEAT';
export const CMD_FCU_FROM_AC = 'CMD_FCU_FROM_AC';
export const CMD_FCU_TO_AC = 'CMD_FCU_TO_AC';

export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_HTTP_RETRIES = 5;
export const DEFAULT_HTTP_BACKOFF_MS = 100;

export const DEFAULT_STATE_POLL_INTERVAL_SECONDS = 120;
export const DEFAULT_DISCOVERY_REFRESH_MINUTES = 30;

export const TOKEN_REFRESH_ADVANCE_SECONDS = 10 * 60;
export const TOKEN_REFRESH_RETRY_DELAY_MS = 5 * 60 * 1000;
export const COMMAND_COALESCE_DELAY_MS = 500;

export const TOSHIBA_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
