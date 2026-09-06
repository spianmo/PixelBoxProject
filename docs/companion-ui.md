# Companion UI and Session Persistence

Both example6 and example7 share the pixel cat model and responsive renderer.
Idle randomly selects five poses without immediate repeats every 4.5-8.5 seconds.
Listening, thinking, speaking, wake, rest and error have distinct silhouettes.
State changes blend geometry and pose over 420 ms, including interrupted blends.
Fixed projection buffers and lazy shape arrays retain the native run projection
path. Animation time uses elapsed frame time even below the requested FPS.
Clean black eyes and the normal silhouette follow the unperturbed reference;
scan streaks and eye color offsets appear only for 180 ms after an IMU jolt.
Latest IMU tilt is applied directly after pose blending, without a low-pass
filter or yaw/pitch animation. Rendering batches rectangle commands through
`fillRects` and caches bounded font measurements; older firmware has a fallback.
All shapes are prepared at app startup to avoid a cold shape allocation during
an IMU-driven frame or conversation state change.

Normal mode enlarges the cat and reserves only three caption lines. The account
name is absent from the assistant header; connectivity follows the brand.
Fullscreen leaves only its exit icon, a larger cat, waveform and captions.
Actual service progress is retained in the central status area normally and
as a compact extra caption in fullscreen, including intermediate updates.
Touch routing ignores hidden toolbar actions, while tapping the subject still
starts listening. A long BOOT press exits fullscreen and opens settings.

Example7 persists credentials and access/refresh sessions in device KV. Records
are scoped to the HTTPS origin, OEM, enterprise domain and device. Passwords
additionally match the enterprise/account pair and preserve their exact text.
Restoring waits for Wi-Fi and clock synchronization. Active tokens are reused;
expired tokens refresh, with remembered-password login after session expiry.
Explicit logout invalidates the session but retains the password and disables
automatic login. App disposal retains the session. Late login/refresh results
cannot undo explicit logout. Device KV is not separately encrypted.

Validation: 25 example6 tests, 29 example7 tests, all seven example builds,
117 Playwright scenes at 320/368/480 pixels, including nonblank canvas,
chromatic outlines, text bounds/overlap, IMU changes and four morph frames.
Tests exercise five idle forms, interrupted transitions, extreme tilts,
fullscreen touch handling, persistent-session reload and explicit logout.

The earlier firmware performance measurements in `jsvm-performance.md` predate
these larger scenes and morph animations; they are not final UI FPS claims.

The enlarged-scene device probe after the batch/font firmware measured 5.38 FPS
for example6, 5.92 FPS for example7 normal and 5.72 FPS fullscreen, with live
IMU and no execution timeouts or dropped jobs. It used a renderer fixture,
without authenticated speech, and preceded moving shape preparation to startup.
These values are frame throughput, not measured motion-to-photon latency.
