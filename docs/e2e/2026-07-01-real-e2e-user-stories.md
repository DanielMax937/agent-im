# ZiWeiCompass Real E2E User Stories

Scope: run the app as a real user with the production app bundle, real local storage, real bundled Zi Wei engine, real bundled knowledge data, real permissions, and real server calls. No fake backend, mocked model output, mocked photo analysis, or seeded in-app state is allowed.

## US-01 First Launch And Status

As a first-time user, I want the app to launch into Today so I can see whether I need to create a birth profile.

Acceptance:
- Launch after local state reset.
- Today tab shows a visible status message.
- Profile and chart empty states are visible or reachable without crash.
- No startup error banner is shown.

## US-02 Birth Profile Validation

As a user entering birth data, I want invalid profile fields rejected so I do not generate a misleading chart.

Acceptance:
- Empty name is rejected.
- Invalid date components are rejected.
- Invalid birth time is rejected.
- Invalid longitude is rejected.
- Error messages remain visible until the next user action.

## US-03 Birth Profile Save And Chart Generation

As a user with valid birth data, I want to save my profile and generate a Zi Wei Dou Shu chart.

Acceptance:
- Valid default profile is saved through the Profile tab.
- The bundled JavaScript engine generates exactly 12 palaces.
- Chart tab shows the chart grid and a selected palace detail.
- Palace tiles can be opened without layout or navigation failures.
- Today tab reflects the generated profile/current cycle.

## US-04 AI Chart Reading

As a user viewing a generated chart, I want to request an AI reading backed by the real server.

Acceptance:
- Runs on a physical iOS device because App Attest is required.
- Uses the configured `ZIWEI_SERVER_BASE_URL`.
- App Attest registration/assertion succeeds.
- `/api/v1/ziwei/reading` returns a structured reading.
- UI shows summary, evidence, action items, and safety note.
- Provider errors, auth failures, timeouts, and rate limits are recorded as issues, not treated as success.

## US-05 Knowledge Search

As a user researching classical references, I want local knowledge search to return relevant bundled material.

Acceptance:
- Default query returns at least one result.
- Selecting a result updates the detail panel.
- A nonsense query returns the empty state without crash.
- Search results are based on bundled `knowledge.json`.

## US-06 Compass

As a user checking workspace direction, I want to start the compass and see the real heading state.

Acceptance:
- Runs on simulator for permission/error UI and on physical device for real heading.
- Location permission prompt/state is handled.
- On a device with heading support, a magnetic heading is shown.
- Denied/unavailable states show clear UI and do not crash.

## US-07 Feng Shui Photo Analysis

As a user with a workspace photo, I want the app to analyze the real selected image through the real server.

Acceptance:
- Selecting a real photo through PhotosPicker updates the selected-photo status.
- Tapping Analyze without a selected photo shows a real validation error.
- With a selected photo, `/api/v1/feng-shui/vision-report` returns a structured report.
- Report findings, uncertainty, and action items are visible.
- Provider errors, auth failures, timeouts, image-size errors, and unavailable photos are recorded as issues, not treated as success.

## US-08 Privacy Settings And Local Data

As a privacy-conscious user, I want to control local data handling and delete local app data.

Acceptance:
- Privacy toggles can be changed.
- Privacy settings persist across app restart.
- Delete Local Data clears profile, chart, report, and privacy files.
- After deletion, Today/Profile/Chart return to empty state without stale data.

## US-09 Legal Documents

As a user reviewing terms, I want legal documents to open in-app and be readable.

Acceptance:
- Terms of Service opens from Profile.
- Privacy Policy opens from Profile.
- WebView content loads from the configured public legal URLs.
- Reload and Close controls work.
- Network failures are surfaced instead of leaving a blank sheet.

## US-10 Localization Smoke

As a non-English user, I want the major screens to render in supported languages.

Acceptance:
- Run launch smoke checks for `en`, `zh-Hans`, `zh-Hant`, `ja`, and `ko`.
- Tabs and primary actions render without missing localization keys.
- Text does not visibly overlap in the main screens.

## Required Evidence

- Simulator install/build log.
- XCUITest `.xcresult` bundle and xcodebuild log for simulator-local stories.
- Physical-device build/install log.
- Physical-device XCUITest `.xcresult` bundle and xcodebuild log for real App Attest/server/photo/heading stories.
- Focused app logs during each E2E run.
- Screenshots for Today, Profile, Chart, Feng Shui, Knowledge, Terms, and any failing state.
- `ISSUES.md` with repro, expected, actual, evidence, suspected area, status, and retest notes.
