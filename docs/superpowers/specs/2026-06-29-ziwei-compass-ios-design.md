# Zi Wei Compass iOS Design

Date: 2026-06-29
Status: Approved direction, pending implementation plan

## Goal

Build a native iOS MVP in this repository from the product material under
`/Users/caoxiaopeng/ios/fengshui/outputs`.

The app must be a real SwiftUI app, not a web wrapper, and it must avoid mock
data and fake fallback behavior. Every feature should either use a real local
implementation, a real device/simulator framework, or the configured live LLM
service. Failures should be surfaced as explicit app states.

## Existing Context

The current repository is a TypeScript/Next.js service project named
`agent-im`. It does not contain an existing iOS project. The iOS app will live
under a new isolated path:

```text
ios/ZiWeiCompass/
```

The source product material contains:

- A Chinese PRD for a Zi Wei Dou Shu and feng shui iOS client.
- An English static prototype named `Zi Wei Compass`.
- Requirements, user stories, design notes, and static mobile HTML screens.

The PRD references `Renhuai123/ziwei-doushu` commit `88194a4`. That upstream
repository is MIT licensed and uses real `iztro` and `lunar-javascript`
libraries for chart calculation.

## Non-Negotiable Constraints

- Native SwiftUI, not WKWebView wrapping.
- No mock data for product behavior.
- No synthetic AI result fallback.
- No committed API secrets.
- Local deterministic domain logic where practical.
- Live LLM calls only through the user's configured Ark/Doubao environment.
- UI tests must run against the simulator app and record issues before fixes.

## MVP Scope

### Included

- Local birth profile creation and validation.
- True solar time adjustment using longitude when provided.
- Real Zi Wei chart generation with the upstream algorithm bundle.
- Twelve-palace chart grid, palace detail, major cycle summary, and annual
  summary derived from generated chart data.
- Pattern detection only if it can be bundled from upstream without inventing
  missing logic; otherwise the UI shows "Not available in this build" and the
  feature is not counted as complete.
- Live AI chart reading through the configured Ark/Doubao model.
- Real photo selection or camera capture for feng shui analysis.
- Live multimodal feng shui analysis through the configured Ark/Doubao model.
- Real compass heading where CoreLocation provides it.
- Local knowledge search over bundled upstream classics and knowledge text.
- Local history, privacy status, and delete-local-data flow.

### Deferred

- Compatibility and relationship reports.
- Share cards and social export.
- Paid subscriptions, accounts, sync, and cloud backup.
- LiDAR floor plans and AR room mapping.
- Photo redaction and manual annotation editing beyond displaying model
  findings.
- Unknown birth time rectification.
- Lunar-date birth input. MVP accepts Gregorian dates only.
- Admin, consultant, or content-management workflows.

## Architecture

### App Target

Create a new Xcode project with:

- `ZiWeiCompass` app target.
- `ZiWeiCompassTests` unit test target.
- `ZiWeiCompassUITests` UI test target.
- Bundle ID: `com.caoxiaopeng.ZiWeiCompass`.
- Scheme: `ZiWeiCompass`.
- Minimum iOS version: iOS 18.0.

Use SwiftUI for the UI and Swift concurrency for asynchronous work.

The build must use full Xcode without changing global `xcode-select`:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -version
```

Xcode 26.4 is available in this environment through that explicit
`DEVELOPER_DIR`.

### Domain Modules

`BirthProfileStore`

- Stores user-created birth profiles locally.
- Uses Codable JSON file storage in the app support directory for the MVP.
- Persists only user-entered data and generated real results.
- Interface:
  `loadProfiles() throws -> [BirthProfile]`,
  `saveProfile(_ profile: BirthProfile) throws`,
  `deleteAll() throws`.

`ChartHistoryStore`

- Stores generated charts keyed by profile ID and generation timestamp.
- Provides the latest successful chart for Today and Chart tabs.
- Interface:
  `latestChart(profileID: UUID?) throws -> ZiweiChart?`,
  `saveChart(_ chart: ZiweiChart) throws`,
  `deleteAll() throws`.
- `latestChart(profileID: nil)` means latest successful chart across all
  profiles; Today prefers the selected profile when one exists.

`ZiweiEngine`

- Runs real Zi Wei chart generation locally.
- Uses a bundled JavaScript build of the upstream `ziwei-doushu` chart logic,
  including `iztro` and `lunar-javascript`, through JavaScriptCore.
- Exposes a typed Swift API:
  `generateChart(profile: BirthProfile) async throws -> ZiweiChart`.
- Does not return fixture charts.
- JavaScript bundle path:
  `ios/ZiWeiCompass/ZiWeiCompass/Resources/ziwei-engine.js`.
- Build script input:
  vendored upstream files under
  `ios/ZiWeiCompass/ThirdParty/ziwei-doushu/`.
- Build script output:
  a single JavaScriptCore-compatible bundle produced with `esbuild`.
- If the JavaScript bundle cannot load, evaluate, or return valid JSON, the
  engine throws `ZiweiError.engineUnavailable` or `ZiweiError.invalidChart`.

`KnowledgeStore`

- Bundles real classical and knowledge text derived from the upstream project.
- Supports local full-text style filtering for MVP search.
- Shows empty/error states instead of invented results.
- Interface:
  `search(query: String) throws -> [KnowledgeItem]`,
  `item(id: String) throws -> KnowledgeItem`.
- Bundle path:
  `ios/ZiWeiCompass/ZiWeiCompass/Resources/knowledge.json`.

`LLMService`

- Reads Debug configuration generated from:
  `/Users/caoxiaopeng/wiki/loneweibo/99_Scripts/.env`.
- Uses the keys:
  `ARK_BASE_URL`, `ARK_API_KEY`, `DOUBAO_TEXT_MODEL`,
  `DOUBAO_VISION_MODEL`, and `DOUBAO_VISION_MODEL_IMAGE` when present.
- Calls the real OpenAI-compatible chat completions API.
- Uses the multimodal model for text when requested by the user constraint.
- Returns explicit missing-config, transport, decoding, and provider errors.
- Interface:
  `chartReading(chart: ZiweiChart, question: String) async throws -> AIReading`.
- Timeouts use `URLSession` request timeout of 60 seconds.
- Authentication failures, rate limits, provider validation errors, and
  cancellations are preserved as distinct `LLMError` cases.
- Model selection:
  chart/text reading uses `DOUBAO_TEXT_MODEL` first, then
  `DOUBAO_VISION_MODEL`; vision analysis uses `DOUBAO_VISION_MODEL_IMAGE`
  first, then `DOUBAO_VISION_MODEL`, then `DOUBAO_TEXT_MODEL` only when the
  configured provider accepts multimodal input for that model.

`FengShuiVisionService`

- Uses a real selected image or captured camera image.
- Sends the image to the configured multimodal model.
- Produces structured findings, evidence labels, and action items from the
  model response.
- Does not generate local fake analysis if the model call fails.
- Interface:
  `analyze(image: FengShuiImage, heading: CompassHeading?) async throws -> FengShuiReport`.
- Images are JPEG-compressed client-side to a maximum long edge of 1600 px and
  a maximum encoded payload of 4 MB before upload.
- If an image is too large after compression, unclear, empty, or unreadable,
  the service throws `VisionError.invalidImage`.
- Reports are persisted only after a successful real model response.

`FengShuiReportStore`

- Stores successful feng shui reports and action completion state.
- Provides the latest report and open action items for Today.
- Interface:
  `latestReport() throws -> FengShuiReport?`,
  `saveReport(_ report: FengShuiReport) throws`,
  `updateAction(reportID: UUID, actionID: UUID, completed: Bool) throws`,
  `deleteAll() throws`.

`CompassService`

- Uses CoreLocation heading where available.
- Handles simulator/device permission states explicitly.
- Shows unavailable and denied states without fake headings.
- Interface:
  `start()`, `stop()`, and published `CompassState`.

`PrivacySettingsStore`

- Stores local-only privacy preferences.
- MVP toggles:
  exact birth data display, store location/longitude, store feng shui photos,
  require Face ID prompt on launch when available.
- Defaults:
  `showExactBirthData = false`, `storeLocation = true`,
  `storeFengShuiPhotos = false`, `requireBiometricUnlock = false`.
- Turning `storeLocation` off removes saved longitude/city fields from local
  profiles after confirmation. Turning `storeFengShuiPhotos` off deletes saved
  raw image files while retaining report text and image hashes.
- Interface:
  `load() throws -> PrivacySettings`,
  `save(_ settings: PrivacySettings) throws`,
  `deleteAll() throws`.

### Core Models

```swift
struct BirthProfile: Codable, Identifiable, Equatable {
    enum Gender: String, Codable { case male, female }
    enum BirthHour: Int, Codable { case zi = 0, chou, yin, mao, chen, si, wu, wei, shen, you, xu, hai }
    var id: UUID
    var name: String
    var gregorianDate: DateComponents
    var localBirthTime: DateComponents
    var correctedBirthHour: BirthHour
    var gender: Gender
    var cityName: String?
    var longitude: Double?
    var timezoneIdentifier: String
    var createdAt: Date
}

struct LunarInfo: Codable, Equatable {
    var lunarYear: Int
    var lunarMonth: Int
    var lunarDay: Int
    var yearStem: Int
    var yearBranch: Int
    var isLeapMonth: Bool
}

struct ZiweiChart: Codable, Equatable {
    var profileID: UUID
    var lunarInfo: LunarInfo
    var mingGongBranch: Int
    var shenGongBranch: Int
    var wuxingJu: Int
    var wuxingJuName: String
    var ziweiPos: Int
    var palaces: [Palace]
    var daXians: [DaXian]
    var currentAge: Int
    var currentDaXianIndex: Int
}

struct Palace: Codable, Identifiable, Equatable {
    var id: Int { branch }
    var branch: Int
    var stem: Int
    var name: String
    var stars: [Star]
    var daXianAge: ClosedRange<Int>?
    var isCurrentDaXian: Bool
    var isMingGong: Bool
    var isShenGong: Bool
    var oppositeBranch: Int?
    var isEmpty: Bool
    var borrowedFromBranch: Int?
    var borrowedFromName: String?
    var borrowedStars: [String]
}

struct Star: Codable, Equatable {
    enum Kind: String, Codable { case major, minor, lucky, sha }
    enum Brightness: String, Codable { case bright, normal, dim }
    var name: String
    var kind: Kind
    var siHua: String?
    var brightness: Brightness?
}

struct DaXian: Codable, Equatable {
    var startAge: Int
    var endAge: Int
    var palaceBranch: Int
    var palaceName: String
}

struct KnowledgeItem: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var source: String
    var body: String
    var tags: [String]
}

struct AIReading: Codable, Equatable {
    var summary: String
    var evidence: [EvidenceTag]
    var nextSteps: [ActionItem]
    var safetyNote: String
}

struct FengShuiReport: Codable, Identifiable, Equatable {
    var id: UUID
    var createdAt: Date
    var imageHash: String
    var heading: CompassHeading?
    var findings: [FengShuiFinding]
    var actionItems: [ActionItem]
    var uncertainty: String?
}

struct FengShuiImage: Equatable {
    var jpegData: Data
    var width: Int
    var height: Int
    var sha256: String
}

struct CompassHeading: Codable, Equatable {
    var magneticHeading: Double
    var trueHeading: Double?
    var accuracy: Double
    var capturedAt: Date
}

enum CompassState: Equatable {
    case idle
    case requestingPermission
    case unavailable
    case denied
    case heading(CompassHeading)
    case failed(String)
}

struct FengShuiFinding: Codable, Identifiable, Equatable {
    var id: UUID
    var title: String
    var evidence: String
    var confidence: Double
    var area: String?
}

struct ActionItem: Codable, Identifiable, Equatable {
    var id: UUID
    var title: String
    var detail: String
    var difficulty: String
    var expectedEffect: String
    var completed: Bool
}

enum EvidenceTag: String, Codable {
    case chart, photo, compass, classicText, userInput, uncertain
}

struct PrivacySettings: Codable, Equatable {
    var showExactBirthData: Bool
    var storeLocation: Bool
    var storeFengShuiPhotos: Bool
    var requireBiometricUnlock: Bool
}
```

### Error Types

```swift
enum BirthProfileError: Error {
    case invalidName, invalidDate, unsupportedDate, missingBirthTime
    case invalidLongitude, invalidTimezone
}

enum StoreError: Error {
    case readFailed, writeFailed, deleteFailed, corruptedData
}

enum ZiweiError: Error {
    case engineUnavailable, bundleMissing, evaluationFailed, invalidChart
}

enum LLMError: Error {
    case missingConfiguration, authenticationFailed, rateLimited
    case timeout, offline, providerRejected(String), invalidResponse
    case cancelled
}

enum VisionError: Error {
    case permissionDenied, invalidImage, imageTooLarge, providerFailed(LLMError)
}

enum KnowledgeError: Error {
    case bundleMissing, corruptedBundle, itemNotFound
}
```

## UI Structure

The MVP uses five tabs:

- Today
- Chart
- Feng Shui
- Knowledge
- Profile

### Required Screens

Today

- Shows the selected profile name, current generated chart status, current
  major cycle summary, and the latest saved feng shui action items.
- Data sources are `BirthProfileStore`, the latest successful `ZiweiChart`,
  and saved `FengShuiReport` action items.
- Empty state: prompt to create a birth profile.
- Error state: show the latest chart or store error with a retry action.
- Offline state: local chart and knowledge still work; AI and vision actions
  show provider unavailable/offline state.

Onboarding/Profile

- Local-first app introduction.
- Birth profile form with name, date, exact local birth time, gender,
  city/longitude fields where available.
- Save profile and trigger real chart generation.

Chart

- Twelve-palace chart grid from `ZiweiEngine`.
- Palace detail view with stars, transformations, empty-palace borrowing, and
  evidence labels.
- Major cycle and annual summary sections based on generated chart data.
- AI reading button that sends chart data to `LLMService`.

Feng Shui

- Photo selection/capture entry.
- Vision analysis call through `FengShuiVisionService`.
- Report view with evidence, uncertainty, and low-risk action checklist.
- Compass view using `CompassService`.

Knowledge

- Local search over bundled real classical/knowledge content.
- Detail view for selected text.

Profile

- Stored profiles and history.
- Privacy toggles.
- Delete local data action.
- LLM configuration status without exposing secrets.

## Birth Input Rules

- MVP accepts Gregorian calendar dates only.
- Supported birth years: 1900 through the current calendar year.
- Unknown birth time is deferred; the user must enter an exact local clock time.
- Gender is required and limited to `male` or `female` because the upstream
  chart engine expects those branches.
- Timezone defaults to the current device timezone and can be overridden by
  city selection when available.
- Longitude is optional. If supplied, true solar time adjustment is calculated
  as `(longitude - 120.0) * 4` minutes relative to China standard meridian.
- The adjusted clock time is mapped to the twelve two-hour branches before
  calling the upstream engine. Date rollover caused by adjustment is preserved
  in the generated chart input.
- If longitude is absent, the UI states that true solar time is not adjusted
  and chart generation maps the entered clock time directly to a branch.
- Dates outside the supported range, invalid component combinations, missing
  birth time, and invalid longitude block chart generation with validation
  messages.

## Feng Shui Response Schema

The multimodal prompt must require JSON with this minimum shape:

```json
{
  "findings": [
    {
      "title": "Desk faces the door",
      "evidence": "The chair and desk are aligned toward the visible doorway.",
      "confidence": 0.72,
      "area": "desk"
    }
  ],
  "actionItems": [
    {
      "title": "Shift the chair angle",
      "detail": "Rotate the chair slightly so the door remains visible without direct alignment.",
      "difficulty": "low",
      "expectedEffect": "Reduce visual tension and improve focus."
    }
  ],
  "uncertainty": "Only one image was available, so room depth may be incomplete."
}
```

The parser rejects responses missing `findings` or `actionItems`. The UI shows
invalid-response error instead of filling fields with local text.

## Data Flow

1. User enters birth data.
2. `BirthProfileStore` persists it locally.
3. The app computes true-solar adjusted time when longitude exists and maps it
   to `correctedBirthHour`.
4. `ZiweiEngine` generates a real `ZiweiChart`.
5. `ChartHistoryStore` persists the generated chart.
6. Chart and Today views render only returned chart data.
7. AI reading serializes chart data and sends it to `LLMService`.
8. User selects or captures a photo.
9. `FengShuiVisionService` sends the real image to the multimodal model.
10. `FengShuiReportStore` persists successful reports and action state.
11. Compass views subscribe to `CompassService` heading updates.
12. UI tests exercise the same app services and do not inject fake results.

## Error Handling

Every external or permission-dependent feature needs an explicit UI state:

- Missing API key or base URL.
- Model request failure.
- Invalid model response.
- Camera permission denied.
- Photo selection unavailable.
- Compass unavailable or permission denied.
- Chart generation failure.
- Empty knowledge search results.
- Persistence read/write/delete failure.
- Corrupted stored profile, chart, knowledge, or report data.
- JavaScriptCore bundle missing, load failure, evaluation failure, or invalid
  JSON result.
- Knowledge bundle missing or corrupted.
- Offline network state.
- LLM authentication failure, rate limit, timeout, provider validation error,
  malformed provider response, and user cancellation.
- Vision image too large, unreadable, unclear, or rejected by the provider.

The app must not silently substitute mocked content.

## Testing Strategy

Unit tests:

- Validate birth profile persistence.
- Validate JavaScriptCore chart engine returns a 12-palace chart for real input.
- Validate LLM request building and response decoding using local deterministic
  decoder tests, while live provider calls are covered by an integration smoke
  path when configuration is present.
- Validate knowledge search on bundled content.
- Validate feng shui JSON parsing with checked-in response samples. These are
  parser fixtures, not product mock data, and are not shown in the app.

UI tests:

- Launch app on iOS Simulator.
- Complete onboarding/profile creation with deterministic real input.
- Generate and inspect a real chart.
- Open a palace detail.
- Search knowledge content and open a detail.
- Open AI reading and verify either live success or explicit provider error.
- Open feng shui flow and verify either live success with a selected real image
  or explicit permission/provider error.
- Open compass and verify real availability or explicit unavailable state.
- Open privacy/profile and delete local data.

Deterministic UI test inputs:

- Birth profile: fixed Gregorian date, exact local clock time, gender, timezone,
  and longitude entered through the UI.
- Knowledge search: query term known to exist in the bundled upstream content.
- Feng shui photo: a checked-in real sample image used only as a UI test input.
  The app still sends the image through the real vision service when
  configuration and network are available.
- Live LLM/vision tests may pass through either successful provider responses
  or explicit provider/configuration errors. They do not accept synthetic app
  content as success.

Build/deploy loop:

- Use `ios-devtools` simulator lock.
- Build with Xcode command line tools.
- Install and launch on simulator.
- Run XCUITest with a result bundle.
- Capture screenshots/logs/artifacts.
- Record issues found, fix them, redeploy, and rerun until the test suite
  passes or a true external blocker remains.

## Secrets Handling

Do not commit `.env` content. Generate a local, gitignored Debug config from:

```text
/Users/caoxiaopeng/wiki/loneweibo/99_Scripts/.env
```

The generated config should be under `ios/ZiWeiCompass/Local/` or another
gitignored path and consumed by the Debug build.

## Acceptance Criteria

- A native iOS app exists under `ios/ZiWeiCompass/`.
- The app builds with Xcode 26.4 through explicit `DEVELOPER_DIR`.
- The app installs and launches on an iOS Simulator.
- The chart path uses real upstream Zi Wei logic, not fixtures.
- LLM and vision paths use the configured Ark/Doubao service or show explicit
  configuration/provider errors.
- The Today tab shows real local chart/action data or explicit empty/error
  states.
- No API secrets are committed.
- XCUITest result bundle is produced.
- Issues found during UI testing are recorded and fixed.
- Final verification report includes project, scheme, simulator, app bundle ID,
  commands, artifacts, test result path, and remaining risks.
