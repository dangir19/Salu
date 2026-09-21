# Apple HealthKit Plan — Salu native iOS app

> Status: **planned, not built.** The web app cannot read Apple Health — HealthKit
> data lives on the device and is only available to a native iOS app with the
> HealthKit entitlement. The Salu website is honest about this: the Apple Health
> connect button reads "Coming with the Salu app". What *is* built today:
>
> - `POST /api/health/apple/ingest` — validated ingest endpoint (bearer device
>   token or member session). Accepts `{date, workouts[], steps, sleepHours,
>   restingHr, hrvMs}` and stores it in `health_metrics` with source
>   `apple_health`.
> - `POST /api/health/device-token` — mints a one-time bearer token the app
>   stores in the iOS keychain; the server stores only the SHA-256 hash.
> - The same weekly-summary + recovery-recommendation pipeline Atlas already
>   uses for Strava works unchanged for Apple Health data.

## iOS entitlements

1. In Xcode, target → Signing & Capabilities → **+ HealthKit**.
2. `Info.plist` usage strings (required, shown on the system prompt):
   - `NSHealthShareUsageDescription`: "Salu reads your workouts, steps, sleep and heart data to personalize recovery recommendations."
   - `NSHealthUpdateUsageDescription`: "Salu saves completed Salu sessions to your Health records." (only if we write)
3. Request only what we use — workouts (`HKWorkoutType`), step count
   (`HKQuantityTypeIdentifier.stepCount`), sleep (`HKCategoryTypeIdentifier.sleepAnalysis`),
   resting heart rate (`HKQuantityTypeIdentifier.restingHeartRate`), HRV
   (`HKQuantityTypeIdentifier.heartRateVariabilitySDNN`).

## Sync design (background delivery)

- On first launch after sign-in: request HealthKit authorization, then call
  `POST /api/health/device-token` (member session) and store the returned token
  in the keychain (`kSecClassGenericPassword`, `accessibleAfterFirstUnlock`).
- Use `HKHealthStore.enableBackgroundDelivery(for:frequency:.daily)` per type,
  plus an `HKObserverQuery` for workouts.
- On background wake: run an `HKSampleQuery`/`HKStatisticsCollectionQuery` for
  the last 24h, map to the ingest payload, and `POST` it to
  `/api/health/apple/ingest` with `Authorization: Bearer <device token>`.
- Also sync on app foreground (cheap, keeps the dashboard fresh).
- Handle 401 on the device token by re-minting after the member re-authenticates.

## Privacy rules (carry over from web)

- Minimal fields only: per-day aggregates + a compact workout list. Never send
  raw HealthKit sample dumps.
- Never log health payloads or tokens on client or server.
- Disconnecting Apple Health in the app calls `POST /api/health/disconnect`
  with `{provider: "apple_health"}` — the server deletes the account row and
  every `health_metrics` row with that source. Show "Disconnecting deletes your
  Apple Health data from Salu" in the UI before confirming.

## Open questions for the native build

- Write-back: should completed Salu sessions be saved as HealthKit workouts?
  (Nice for the training-load picture; adds the update entitlement + prompt.)
- Watch app: out of scope for v1.
