# FMH + OSD Dashboard — Rechecked Build

## Replace all four Apps Script project files together

1. `Code.gs`
2. `index.html`
3. `script.html`
4. `style.html`

Do not mix these files with an earlier package. The frontend and backend payloads must be from the same build.

## Verification steps

1. Save all four files.
2. In the Apps Script editor, select and run `testDashboardSetup`.
3. Authorize the script when prompted.
4. Open **Executions** and inspect the returned/logged object:
   - `fmh.sheetFound` should be `true`.
   - `osd.sheetFound` should be `true`.
   - `osd.missingRequired` should be an empty array.
   - Every item in `overnightTests` should have `passed: true`.
5. Run `clearDashboardCache` once.
6. Deploy the web app as a **new version**, then open the new deployment URL.

## Main fixes in this build

- Detects mixed or incomplete HTML/JavaScript file deployments and shows a visible error instead of silently stopping.
- Uses safe event binding so one missing DOM element cannot crash unrelated dashboard sections.
- Loads Chart.js asynchronously. KPI cards and tables still work when the CDN is blocked or unavailable.
- Isolates frontend rendering errors and hides the loading overlay when an error occurs.
- Uses tolerant OSD header aliases while preserving support for the exact multiline headers.
- Correctly parses Google Sheets midnight values stored as numeric `0`.
- Limits only the browser detail-table payload to 2,000 newest rows so a large OSD sheet cannot freeze the page. KPIs and route/sender aggregations still use every filtered trip.
- Keeps the overnight SLA rule: an arrival exactly at the target is `No Late`; only a later arrival is `Late`.

## Expected overnight test cases

| Departure | Target | Arrival | Result |
|---|---|---|---|
| 20:00 | 02:30 | 23:30 | No Late |
| 20:00 | 02:30 | 01:45 | No Late |
| 20:00 | 02:30 | 02:30 | No Late |
| 20:00 | 02:30 | 04:00 | Late |
