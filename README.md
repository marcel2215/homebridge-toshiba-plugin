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
- Startup self-recovery for transient cloud/network errors with exponential retry backoff.
- Device auto-discovery and cache reconciliation.
- Resilient discovery parsing (malformed cloud entries are skipped instead of aborting discovery).
- Automatic AMQP reconnect with exponential backoff after cloud disconnects.
- AMQP operation timeout guards (connect/send/disconnect) with failure-triggered recovery.
- Poll/discovery overlap protection to avoid queue buildup during slow cloud responses.
- Per-device polling endpoint failover between `GetCurrentACStateByUniqueDeviceIdV2` and `GetCurrentACStateV2` (one device's 403 no longer forces global fallback).
- If both polling endpoints return 403 for a device, polling is temporarily paused for that device and retried later while AMQP remains active.
- Command coalescing (500ms debounce) to mirror native app command burst behavior.
- No-op command suppression (skips AMQP send when requested state already matches current effective state).
- Command preflight online check (`GetAllDeviceState`) before AMQP sends, with offline protection.
- Short-lived connection-state cache on command precheck to reduce command latency and cloud rate-limit pressure.
- If online precheck itself fails (timeout/network/transient cloud error), command falls back to best-effort send instead of hard-failing control.
- Command-send retries with detailed logs for transient AMQP send failures.
- Defensive payload parsing and malformed-cloud-update guards.
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

- `0%`:
  - fan `AUTO`
  - eco OFF
  - high power OFF
  - indoor silent OFF
  - outdoor silent OFF
- `> 0% && <= 10%`:
  - indoor silent ON (`QUIET` fan)
  - outdoor silent ON (`CDU_SILENT_1/2`)
  - eco requested by profile, but Toshiba `MeritA` is single-choice so this band prioritizes outdoor silent
- `> 10% && <= 20%`:
  - indoor silent ON (`QUIET` fan)
  - eco ON (`ECO`)
  - outdoor silent OFF
- `> 20% && <= 30%`:
  - indoor silent OFF
  - eco ON (`ECO`)
  - outdoor silent OFF
- `> 30% && < 100%`:
  - eco OFF
  - high power OFF
  - indoor silent OFF
  - outdoor silent OFF
- `100%`:
  - high power ON (`HIGH_POWER`)
  - eco OFF
  - indoor silent OFF
  - outdoor silent OFF
- Power selection is derived from `RotationSpeed`:
  - `0%` => middle (`POWER_75`)
  - `1..33%` => `POWER_50`
  - `34..66%` => `POWER_75`
  - `67..100%` => `POWER_100`
- Fan mode selection for non-silent speeds uses nearest discrete Toshiba step by absolute difference.
- Rotation slider stability:
  - Plugin keeps your last explicit Home app slider percentage while cloud state still matches the same mapped Toshiba tuple.
  - This prevents Home app “jumping” to quantized fan buckets after a successful set.

Note: Toshiba `Merit A` is a single field in cloud payload, so overlapping low-speed modes use precedence:
`HIGH_POWER` > `CDU_SILENT_1/2` > `ECO` > `OFF`.

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

## Publish

```bash
# Optional: bump version first
npm run version:bump:revision
# or
npm run version:bump:minor
npm run version:bump:major

# Preview publish
npm run publish:plugin:dry-run

# Publish to npm (latest tag)
npm run publish:plugin
```

Optional flags:

```bash
# Use a custom dist-tag
npm run publish:plugin -- --tag beta

# If npm account uses 2FA
npm run publish:plugin -- --otp 123456
```

## Troubleshooting

- Verify your Toshiba app credentials.
- Check Homebridge logs for `HTTP API` / `AMQP API` messages.
- If a child bridge appears to stop with empty plugin logs, make sure you are running the latest plugin build:
  - `npm run build`
  - restart Homebridge after updating.
- If login works but no accessories appear, confirm devices are visible in the official Toshiba app account.
- If accessories become stale, restart Homebridge and verify cloud connectivity.
