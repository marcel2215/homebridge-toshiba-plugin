# homebridge-toshiba-plugin

Homebridge dynamic platform plugin for Toshiba **Home AC Control** cloud devices.

- Uses the same cloud login (username/email + password) as the official Android/iOS app.
- Connects to Toshiba cloud services (`mobileapi.toshibahomeaccontrols.com`) and Azure IoT AMQP push channel.
- Auto-discovers registered AC units from your cloud account.
- Exposes devices to Apple Home with real-time updates + fallback polling.
- Mirrors key cloud API flow from decompiled app assemblies (`Login`, `RegisterMobileDevice`, `GetConsumerACMappingV2`, `GetCurrentACStateV2`, `GetCurrentACStateByUniqueDeviceIdV2`).

## Features

- Cloud authentication + automatic SAS token refresh.
- Login payload includes Toshiba `BrandId` and mobile registration uses username-prefixed device id format (app parity).
- Mobile cloud registration supports both response formats used by the app backend (`SasToken` or `HostName` + `DeviceId` + `PrimaryKey`).
- Device auto-discovery and cache reconciliation.
- Automatic AMQP reconnect with exponential backoff after cloud disconnects.
- Command coalescing (500ms debounce) to mirror native app command burst behavior.
- Command preflight online check (`GetAllDeviceState`) before AMQP sends, with offline protection.
- Command-send retries with detailed logs for transient AMQP send failures.
- Single accessory model: each Toshiba AC is exposed as one HomeKit `HeaterCooler` service (no extra Fan/Switch/Sensor services).
- HeaterCooler control:
  - Power (`Active`)
  - Mode (`Auto`, `Cool`, `Heat`)
  - Target temperature
  - Fan speed
  - Swing mode
  - Indoor temperature
- Robust error handling and detailed Homebridge logs.

## RotationSpeed Mapping Profile

The plugin keeps a single HomeKit `HeaterCooler` tile and maps Toshiba-specific behavior from `RotationSpeed`:

- `0%` => fan `AUTO`
- `> 0% && <= 5%` => outdoor silent (`CDU_SILENT_1`) ON
- `> 0% && <= 10%` => indoor silent (`QUIET` fan) ON
- `> 0% && <= 20%` => eco (`ECO`) ON
- `100%` => high power (`HIGH_POWER`) ON
- Power selection is derived from `RotationSpeed`:
  - `0%` => middle (`POWER_75`)
  - `1..33%` => `POWER_50`
  - `34..66%` => `POWER_75`
  - `67..100%` => `POWER_100`

Note: Toshiba `Merit A` is a single field in cloud payload, so overlapping low-speed modes use precedence:
`HIGH_POWER` > `CDU_SILENT_1` > `ECO` > `OFF`.

## Install

```bash
npm install
npm run build
```

For local Homebridge development:

```bash
npm link
homebridge -D
```

## Homebridge Config

```json
{
  "platform": "ToshibaSmartAC",
  "name": "Toshiba Smart AC",
  "username": "your-email@example.com",
  "password": "your-password",
  "pollIntervalSeconds": 120,
  "discoveryRefreshMinutes": 30,
  "requestTimeoutSeconds": 60,
  "httpRetries": 5
}
```

## Notes

- This plugin controls devices via Toshiba cloud, not local LAN.
- Real-time state updates come from cloud AMQP; polling is only a fallback.
- Some Toshiba app features are not directly representable by native HomeKit `HeaterCooler` characteristics and are not exposed as separate tiles/services.
- Not mapped on purpose: `Pure`/ionizer, self-cleaning, floor/comfort/fireplace variants, and other non-`HeaterCooler` native controls.

## Development

```bash
npm run lint
npm run build
```

## Troubleshooting

- Verify your Toshiba app credentials.
- Check Homebridge logs for `HTTP API` / `AMQP API` messages.
- If a child bridge appears to stop with empty plugin logs, make sure you are running the latest plugin build:
  - `npm run build`
  - restart Homebridge after updating.
- If login works but no accessories appear, confirm devices are visible in the official Toshiba app account.
- If accessories become stale, restart Homebridge and verify cloud connectivity.
