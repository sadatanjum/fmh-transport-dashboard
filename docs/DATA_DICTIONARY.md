# Data Dictionary

## FMH Report-Manual Sheet

### Core Fields

| Field Name | Data Type | Description | Example | Notes |
|------------|-----------|-------------|---------|-------|
| **Date** | Date | Operational date for the trip | 01/08/2026 | Format: DD/MM/YYYY |
| **Hub Name** | Text | Name of the first mile hub | Hub Alpha | See Hub Configuration for valid values |
| **Slot** | Integer | Slot number for the night | 1, 2, 3, 4 | Hubs have 1-5 slots depending on volume |
| **Parcel Handover Set Time** | Time | Scheduled handover time (SLA target) | 23:00:00 | Format: HH:MM:SS |
| **Parcel Handover Time** | Time | Actual time parcels handed over to van | 23:05:00 | Format: HH:MM:SS |
| **Van Left Time** | Time | Actual time van departed hub | 23:20:00 | Format: HH:MM:SS |
| **Van Reach Time** | Time | Actual time van arrived at central sort | 00:15:00 | Format: HH:MM:SS (can cross midnight) |
| **Parcel Qty** | Integer | Number of parcels in the trip | 150 | Optional field |
| **Van No** | Text | Vehicle registration number | DH-12-3456 | Optional field |
| **Driver** | Text | Driver name or ID | Driver-123 | Optional field |
| **Remarks** | Text | Notes about delays or issues | Traffic delay | Optional field |

### Calculated Fields (Backend)

These are calculated by the Apps Script backend and not present in the source sheet:

| Field | Calculation | Description |
|-------|-------------|-------------|
| **Handover Status** | `On Time` if actual ≤ (set time + 15 min), else `Late Handover` | Whether parcels were handed over on time |
| **Dispatch Status** | `On Time` if left ≤ (handover + 15 min), else `Late Move` | Whether van departed on time |
| **Reach Status** | `On Time` if travel time ≤ hub target, else `Late Reach` | Whether van arrived on time |
| **Handover Delay** | Actual handover - Set time (minutes) | How late the handover was |
| **Dispatch Delay** | Van left - Handover (minutes) | How long between handover and departure |
| **Travel Time** | Van reach - Van left (minutes) | Actual travel duration |
| **Breach Count** | Count of `Late` statuses (0-3) | Number of SLA checkpoints breached |

---

## OSD To Central Sort Sheet

### Core Fields

| Field Name | Data Type | Description | Example | Notes |
|------------|-----------|-------------|---------|-------|
| **Reporting Date** | Date | Operational date | 01/08/2026 | Format: DD/MM/YYYY |
| **Name of Senders** | Text | Originating hub/sender | Station North | Outside-Dhaka pickup location |
| **Route** | Text | Route designation | Route A-C | Route from sender to central sort |
| **Parcel Handover Time To TNL** | Time | When parcels handed to linehaul | 20:00:00 | Optional field |
| **Van Departure** | Time | When van departed sender location | 20:30:00 | Format: HH:MM:SS |
| **Max. Targeted Arrival** | Time | SLA cutoff for arrival | 02:00:00 | Format: HH:MM:SS (usually next-day AM) |
| **Arrived at Central Sort** | Time | Actual arrival time | 01:45:00 | Format: HH:MM:SS |
| **Trip Duration** | Duration | Total trip time | 05:15:00 | Optional field (may be calculated) |

### Calculated Fields (Backend)

| Field | Calculation | Description |
|-------|-------------|-------------|
| **Arrival Status** | `Late` if arrival > target (overnight-anchored), else `No Late` | Whether van arrived before SLA cutoff |
| **Late By (minutes)** | Actual arrival - Target (overnight-anchored) | How late the arrival was (if late) |
| **Calculated Trip Duration** | Arrival - Departure (overnight-anchored) | Actual travel time in minutes |

---

## SLA Calculation Rules

### Checkpoint 1: Hub Handover

**Rule**: Parcels must be handed over to the van within **15 minutes** of the set time.

**Formula**:
```
if (Actual Handover Time) ≤ (Set Time + 15 minutes)
  then "On Time"
  else "Late Handover"
```

**Grace Window**: 15 minutes (configured in `CONFIG.HANDOVER_GRACE_MIN`)

**Example**:
- Set Time: 23:00:00
- Actual: 23:12:00 → **On Time** (12 min ≤ 15 min)
- Actual: 23:18:00 → **Late Handover** (18 min > 15 min)

---

### Checkpoint 2: Van Dispatch

**Rule**: Van must leave the hub within **15 minutes** of handover completion.

**Formula**:
```
if (Van Left Time) ≤ (Actual Handover Time + 15 minutes)
  then "On Time"
  else "Late Move"
```

**Grace Window**: 15 minutes (configured in `CONFIG.DISPATCH_GRACE_MIN`)

**Example**:
- Handover: 23:05:00
- Van Left: 23:18:00 → **On Time** (13 min ≤ 15 min)
- Van Left: 23:25:00 → **Late Move** (20 min > 15 min)

---

### Checkpoint 3: Warehouse Arrival

**Rule**: Van must reach central sort within the **hub-specific travel limit**.

**Formula**:
```
Travel Time = Van Reach Time - Van Left Time (overnight-anchored)

if Travel Time ≤ Hub Travel Limit
  then "On Time"
  else "Late Reach"
```

**Travel Limits**: Vary by hub (30-128 minutes). See Hub Configuration below.

**No Grace Window**: Exact travel limit is the cutoff.

**Example**:
- Hub Alpha travel limit: 30 minutes
- Van Left: 23:20:00
- Van Reach: 00:15:00
- Travel Time: 55 minutes → **Late Reach** (55 > 30)

---

### OSD Arrival Status

**Rule**: Van must arrive at central sort **before or at** the max targeted arrival time.

**Overnight Logic**: Uses the same anchoring as FMH calculations.

**Formula**:
```
if (Actual Arrival) > (Max Targeted Arrival) [both overnight-anchored]
  then "Late"
  else "No Late"
```

**Example** (see Overnight Rollover section):
- Departure: 20:00 (evening)
- Target: 02:30 (next morning)
- Arrival: 01:45 → **No Late** (before cutoff)
- Arrival: 04:00 → **Late** (after cutoff)

---

## Overnight Rollover Logic

### The Problem

Logistics operations span midnight. A van departing at **22:00** and arriving at **01:30** looks like it traveled *backwards in time* (-20.5 hours) when using raw clock values.

### The Solution: Time Anchoring

All times are "anchored" to a single operational day using a **rollover threshold**.

**Algorithm**:
```javascript
ROLLOVER_ANCHOR_HOUR = 12  // Noon is the split point

function anchor(minutes_from_midnight) {
  if (minutes_from_midnight < ROLLOVER_ANCHOR_HOUR * 60) {
    return minutes_from_midnight + 1440  // Add 24 hours
  }
  return minutes_from_midnight
}
```

**How It Works**:
- Any time **before 12:00 PM** is treated as "next day" of the operational window
- Times **12:00 PM and later** stay on the "same day"

**Example Calculation**:

| Clock Time | Raw Minutes | Anchored Minutes | Interpretation |
|------------|-------------|------------------|----------------|
| 22:00 | 1320 | 1320 | Same operational day |
| 23:00 | 1380 | 1380 | Same operational day |
| 00:30 | 30 | 30 + 1440 = **1470** | Next calendar day, same operational night |
| 01:30 | 90 | 90 + 1440 = **1530** | Next calendar day, same operational night |

**Travel Time Calculation**:
```
Departure: 22:00 → 1320 minutes (anchored)
Arrival: 01:30 → 1530 minutes (anchored)
Travel Time: 1530 - 1320 = 210 minutes (3.5 hours) ✓
```

---

## Hub Configuration

### Hub Slot Set Times

Each hub has 1-5 configured slots with specific handover set times:

**Example** (anonymized):
```javascript
{
  'Hub Alpha':   { 1: '00:01:00' },
  'Hub Beta':    { 1: '23:00:00', 2: '01:00:00' },
  'Hub Gamma':   { 1: '00:30:00' },
  'Hub Delta':   { 1: '23:00:00', 2: '00:30:00' },
  // ... etc.
}
```

**Note**: If a slot's set time is missing from configuration, the backend looks for a "Set Time" column in the sheet. If both are missing, the handover status becomes `Not Evaluated`.

### Hub Transit Limits

Each hub has a target travel time to central sort (in minutes):

**Example** (anonymized):
```javascript
{
  'Hub Alpha': 30,    // 30 minutes
  'Hub Beta': 40,     // 40 minutes
  'Hub Gamma': 45,    // 45 minutes
  'Hub Delta': 62,    // 1:02
  'Hub Epsilon': 85,  // 1:25
  // ... etc.
}
```

**Fallback**: If a hub has no configured limit, the default is **90 minutes** (`CONFIG.DEFAULT_TRAVEL_LIMIT_MIN`).

---

## Status Values

### SLA Status Enumeration

| Status | Meaning |
|--------|---------|
| **On Time** | Checkpoint met SLA requirement |
| **Late Handover** | Parcels handed over late (> set time + 15 min) |
| **Late Move** | Van departed late (> handover + 15 min) |
| **Late Reach** | Van arrived late (> hub travel limit) |
| **Late** | OSD arrival after target cutoff |
| **No Late** | OSD arrival before or at target cutoff |
| **Not Evaluated** | Missing data or implausible values (quarantined) |

---

## Data Quality Rules

### Validation Checks

1. **Date Parsing**
   - Must be valid calendar date
   - Format: DD/MM/YYYY or MM/DD/YYYY (configured)
   - Invalid dates → row skipped, logged in DQ panel

2. **Time Parsing**
   - Accepts: Date objects, numeric fractions, "HH:MM", "HH:MM:SS", "HH.MM", "HHMM"
   - Midnight stored as numeric `0` is treated as 00:00:00
   - Unparseable times → field marked as null, status becomes `Not Evaluated`

3. **Hub Name Mapping**
   - Hub names normalized (lowercase, collapsed spaces, standardized hyphens)
   - Aliases supported (e.g., "Mirpur" → "Mirpur 60 Feet")
   - Unmapped hubs → listed in DQ panel, but row still processed

4. **Sequence Validation**
   - Set Time → Handover → Van Left → Van Reach must be chronologically ordered (allowing for overnight rollover)
   - Small inversions (<60 min tolerance) flagged as anomalies but kept
   - Large inversions trigger midnight rollover correction

5. **Implausible Travel Time Quarantine**
   - Travel time > 360 minutes (6 hours) is flagged as implausible
   - Such rows get `Reach Status = "Not Evaluated"` and are excluded from KPIs
   - Logged in DQ panel for manual review

### Quarantine Behavior

**Key Principle**: Bad data is **never silently dropped**.

- Invalid rows are excluded from KPIs
- All exceptions are visible in the **Data Quality Panel**
- Users can review and correct source data

---

## Performance Optimizations

### Server-Side Caching

- **Cache Key**: `fmh_tracker_payload_v3` (FMH), `osd_linehaul_source_v2` (OSD)
- **TTL**: 300 seconds (5 minutes)
- **Cache Storage**: Apps Script's `CacheService.getScriptCache()`
- **Max Size**: ~95KB (larger payloads served live)

### Client-Side Filtering

- Full dataset loaded once and cached in memory
- Filter changes recalculate KPIs client-side (instant updates)
- No server round-trip for date/hub/slot filtering

### Payload Limiting

- **OSD Detail Table**: Limited to 2,000 newest rows to prevent browser freeze
- **KPIs and Aggregations**: Always use full filtered dataset
- Users notified if detail table is truncated

---

## Example Data Flow

### Full Trip Processing Example

**Source Data**:
```
Date: 01/08/2026
Hub: Hub Alpha
Slot: 1
Set Time: 23:00:00
Handover: 23:15:00
Left: 23:35:00
Reach: 00:20:00
```

**Backend Processing**:

1. **Parse & Normalize**:
   - Date → ISO: 2026-08-01
   - Hub → Normalized: "hub alpha"
   - Slot → 1

2. **Time Anchoring**:
   - Set: 23:00 → 1380 min
   - Handover: 23:15 → 1395 min
   - Left: 23:35 → 1415 min
   - Reach: 00:20 → 20 + 1440 = **1460 min** (anchored)

3. **SLA Evaluation**:
   - **Handover**: 1395 - 1380 = 15 min → **On Time** (≤15 min grace)
   - **Dispatch**: 1415 - 1395 = 20 min → **Late Move** (>15 min grace)
   - **Arrival**: 1460 - 1415 = 45 min travel
     - Hub Alpha limit: 30 min
     - 45 > 30 → **Late Reach**

4. **Output**:
   - Breach Count: 2
   - Total Delay: 5 min (dispatch) + 15 min (arrival) = **20 minutes**

---

## Integration Notes

### For Developers

**To Add a New Hub**:
1. Add to `HUB_SLOT_SET_TIME` with slot times
2. Add to `HUB_TRANSIT_LIMIT_MIN` with travel limit
3. Add any name aliases to `HUB_ALIASES`
4. Redeploy dashboard

**To Modify SLA Rules**:
1. Update `CONFIG.HANDOVER_GRACE_MIN` or `CONFIG.DISPATCH_GRACE_MIN`
2. Update `HUB_TRANSIT_LIMIT_MIN` for specific hubs
3. Update documentation (this file)
4. Clear cache: Run `clearDashboardCache()`

**To Change Overnight Threshold**:
1. Update `CONFIG.ROLLOVER_ANCHOR_HOUR` (default: 12)
2. Test with overnight test cases in `testDashboardSetup()`
3. Clear cache and refresh dashboard

---

## Glossary

| Term | Definition |
|------|------------|
| **FMH** | First Mile Hub - Suburban distribution hubs |
| **OSD** | Outside Dhaka - Linehaul routes from outside the city |
| **SLA** | Service Level Agreement - Time-based performance targets |
| **Checkpoint** | A measurable point in the delivery process (handover, dispatch, arrival) |
| **Anchored Time** | Time value adjusted for overnight rollover to enable accurate calculations |
| **Quarantine** | Data excluded from KPIs due to quality issues but visible in DQ panel |
| **Grace Window** | Tolerance period added to SLA target (e.g., 15 minutes) |
| **Breach** | SLA checkpoint that was missed (late) |
| **Consistency Ranking** | Multi-dimensional hub performance comparison (frequency × severity) |

---

**Document Version**: 1.0  
**Last Updated**: 2026-09-13  
**Maintained By**: Data Intelligence Department
