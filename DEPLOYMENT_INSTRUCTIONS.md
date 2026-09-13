# 🚀 Deployment Instructions

## Quick Deploy to Google Apps Script

Follow these steps to deploy your own version of the FMH Transport Dashboard.

### Prerequisites
- Google account with Google Sheets access
- Demo data: `Demo_Transport_Tracker_Dataset.xlsx` (included in this repo)

---

## Step 1: Create Google Sheet with Demo Data

1. **Create a new Google Sheet**: Go to [sheets.new](https://sheets.new)
2. **Name it**: "FMH Transport Dashboard Demo"

3. **Import demo data**:
   - Download `Demo_Transport_Tracker_Dataset.xlsx` from this repo
   - In your Google Sheet, create two sheets with exact names:
     - `FMH Report-Manual`
     - `OSD To Central Sort`
   - Open the Excel file and copy data from each sheet
   - Paste into the corresponding Google Sheet tabs

---

## Step 2: Set Up Apps Script

1. **Open Apps Script**:
   - In your Google Sheet: **Extensions → Apps Script**
   - You'll see a `Code.gs` file with some default code

2. **Add the 4 project files**:

   **File 1: Code.gs**
   - Delete existing code
   - Copy all content from `FMH_Tracker/Code.gs`
   - Paste into Code.gs
   - Save (Ctrl+S / Cmd+S)

   **File 2: index.html**
   - Click **"+"** icon (Add a file)
   - Select **"HTML"**
   - Name it: `index`
   - Copy all content from `FMH_Tracker/index.html`
   - Paste and save

   **File 3: script.html**
   - Click **"+"** icon again
   - Select **"HTML"**
   - Name it: `script`
   - Copy all content from `FMH_Tracker/script.html`
   - Paste and save

   **File 4: style.html**
   - Click **"+"** icon again
   - Select **"HTML"**
   - Name it: `style`
   - Copy all content from `FMH_Tracker/style.html`
   - Paste and save

3. **Your Apps Script project should now have**:
   ```
   ├── Code.gs
   ├── index.html
   ├── script.html
   └── style.html
   ```

---

## Step 3: Test the Setup

1. **Run the test function**:
   - In the Apps Script editor, find the function dropdown (top toolbar)
   - Select: `testDashboardSetup`
   - Click **Run** (▶️ button)

2. **Authorize the script** (first time only):
   - Click "Review permissions"
   - Select your Google account
   - Click "Advanced" → "Go to [Project Name] (unsafe)"
   - Click "Allow"

3. **Check the results**:
   - Click **View → Executions** (or **Ctrl+Enter**)
   - Find the most recent execution
   - Check the returned object:
     - `fmh.sheetFound` should be `true`
     - `osd.sheetFound` should be `true`
     - `osd.missingRequired` should be `[]` (empty array)
     - All `overnightTests` should have `passed: true`

4. **If tests fail**:
   - Check sheet names are exactly: `FMH Report-Manual` and `OSD To Central Sort`
   - Verify demo data was pasted correctly
   - Make sure all 4 files were added to Apps Script

---

## Step 4: Deploy as Web App

1. **Clear the cache** (recommended):
   - Function dropdown → Select `clearDashboardCache`
   - Click **Run**

2. **Deploy**:
   - Click **Deploy → New deployment**
   - Click **Select type** → Choose **Web app**
   - Configuration:
     - **Description**: "FMH Dashboard v1"
     - **Execute as**: Me
     - **Who has access**: 
       - `Anyone with Google account` (public demo)
       - OR `Only me` (private testing)
   - Click **Deploy**

3. **Copy the Web App URL**:
   - The deployment success dialog shows your URL
   - Format: `https://script.google.com/macros/s/.../exec`
   - **Save this URL** - this is your live dashboard!

4. **Test the dashboard**:
   - Open the URL in a new tab
   - You should see the FMH Transport Dashboard
   - Try the filters (date range, hub selection)
   - Switch between FMH and OSD tabs

---

## Step 5: Make Updates (Optional)

To update the dashboard after making changes:

1. **Edit the files** in Apps Script editor
2. **Save all changes** (Ctrl+S / Cmd+S)
3. **Deploy again**:
   - Click **Deploy → Manage deployments**
   - Click ✏️ (Edit) next to your deployment
   - Change **Version**: New version
   - Click **Deploy**
4. **Refresh your dashboard URL** to see changes

---

## Troubleshooting

### "Sheet not found" error
- Check sheet names are exact: `FMH Report-Manual` and `OSD To Central Sort`
- No extra spaces or different capitalization

### No data showing in dashboard
1. Run `testDashboardSetup()` - check execution log
2. Verify demo data is in the correct sheets
3. Clear cache: run `clearDashboardCache()`
4. Refresh the dashboard URL

### Charts not loading
- Chart.js loads from CDN - check internet connection
- Charts fail gracefully - KPIs and tables still work

### Permission errors on first run
- Normal! Click "Review permissions" and authorize
- You need to allow the script to access your spreadsheet

### Dashboard shows "Loading..." forever
1. Check browser console for errors (F12 → Console)
2. Verify all 4 files (Code.gs, index.html, script.html, style.html) were added
3. Try incognito/private window (to rule out browser extensions)

---

## Configuration (Advanced)

### To customize for your own data:

1. **Update hub configuration** in `Code.gs`:
   ```javascript
   // Line 86: Hub slot set times
   var HUB_SLOT_SET_TIME = {
     'your-hub-name': { 1: '23:00:00', 2: '01:00:00' },
     // ... add your hubs
   };

   // Line 121: Hub transit limits
   var HUB_TRANSIT_LIMIT_MIN = {
     'your-hub-name': 30,  // minutes
     // ... add your hubs
   };
   ```

2. **Update grace windows** (if needed):
   ```javascript
   // Line 23-24 in CONFIG object
   HANDOVER_GRACE_MIN: 15,   // handover tolerance
   DISPATCH_GRACE_MIN: 15,   // dispatch tolerance
   ```

3. **Redeploy** after configuration changes

---

## File Structure Reference

```
Your Google Sheet:
├── FMH Report-Manual          (Hub operations data)
└── OSD To Central Sort        (Linehaul routes data)

Apps Script Project:
├── Code.gs                    (Backend: 1,600+ lines)
│   ├── Configuration
│   ├── Hub dictionaries
│   ├── ETL pipeline
│   ├── SLA calculations
│   ├── Overnight logic
│   └── Data quality checks
├── index.html                 (Dashboard structure)
├── script.html                (Frontend JavaScript)
└── style.html                 (CSS styles)
```

---

## Need Help?

- **Test your setup**: Run `testDashboardSetup()` and check the execution log
- **Check the demo**: [Live Dashboard](https://script.google.com/macros/s/AKfycbzZFwTF3YphAxOCZ0G9BQluBcmtcKNVUiezfiiZdMTZ21Ja_ok9CrG5vI_ltX2QULkeIA/exec)
- **Read the docs**: See `docs/DATA_DICTIONARY.md` for data schema
- **Open an issue**: GitHub issues for bugs or questions

---

**Estimated setup time**: 10-15 minutes

**Result**: A fully functional, zero-cost logistics dashboard running on Google Apps Script! 🎉
