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
- Command-send retries with detailed logs for transient AMQP send failures.
- HeaterCooler control:
  - Power (`Active`)
  - Mode (`Auto`, `Cool`, `Heat`)
  - Target temperature
  - Fan speed
  - Swing mode
  - Indoor temperature
- Optional Fan service (fan-only mode).
- Optional indoor/outdoor temperature sensor services.
- Optional feature switches (only when supported by device model/merit flags):
  - Eco Mode
  - Hi Power
  - 8C Heating
  - Floor Mode
  - Comfort
  - Ionizer
  - Self Cleaning
- Robust error handling and detailed Homebridge logs.

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
  "httpRetries": 5,
  "enableFanService": true,
  "enableFeatureSwitches": true,
  "enableTemperatureSensors": true
}
```

## Notes

- This plugin controls devices via Toshiba cloud, not local LAN.
- Real-time state updates come from cloud AMQP; polling is only a fallback.
- Some Toshiba app modes are not directly representable by native HomeKit HVAC characteristics. When possible, they are exposed via additional HomeKit services/switches.

## Development

```bash
npm run lint
npm run build
```

## Troubleshooting

- Verify your Toshiba app credentials.
- Check Homebridge logs for `HTTP API` / `AMQP API` messages.
- If login works but no accessories appear, confirm devices are visible in the official Toshiba app account.
- If accessories become stale, restart Homebridge and verify cloud connectivity.
