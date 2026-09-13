/*************************************************************************
 * CarryBee — Data Intelligence Department
 * First Mile Hub (FMH) Time Tracker Dashboard
 * Backend: Code.gs
 *
 * Source grain      : one row = one van trip (Date x Hub x Slot)
 * Output grain      : one record per source row, with 3 SLA verdicts
 * Timezone          : Asia/Dhaka (UTC+6). Sheet values are ALREADY BD local
 *                     clock time — no +6h offset is applied anywhere.
 * Operational day   : FMH night window. All clock times are anchored to a
 *                     single operational night using ROLLOVER_ANCHOR_HOUR.
 *************************************************************************/

/* =====================================================================
 * 1. CONFIGURATION  — change values here, not in the logic below
 * ===================================================================== */

var CONFIG = {
  SHEET_NAME: 'FMH Report-Manual',
  HEADER_ROW: 1,

  // SLA grace windows (minutes)
  HANDOVER_GRACE_MIN: 15,   // handover must be <= set time + 15
  DISPATCH_GRACE_MIN: 15,   // van must leave <= handover + 15

  // Fallback travel limit when hub has no specific target (01:30:00)
  DEFAULT_TRAVEL_LIMIT_MIN: 90,

  // Any clock time earlier than this hour is treated as "next calendar day"
  // within the same operational night. FMH window is ~18:00 -> 06:00,
  // so noon is a safe split point.
  ROLLOVER_ANCHOR_HOUR: 12,

  // Tolerance (minutes) for out-of-sequence timestamps before we assume a
  // midnight rollover rather than a data-entry error.
  SEQUENCE_TOLERANCE_MIN: 60,

  // Travel duration above this is treated as implausible and quarantined.
  MAX_PLAUSIBLE_TRAVEL_MIN: 360,

  // Date parsing order for STRING date cells (Bangladesh convention).
  DATE_ORDER: 'DMY',

  /* ---- Delay duration reporting -----------------------------------
   * 'gross' = Actual Timestamp - SLA Target Timestamp  (as specified)
   * 'net'   = Actual - SLA Target - grace window       (minutes actually
   *           outside the tolerance the hub is allowed)
   * Both are always calculated and returned per row; this key only sets
   * which one the dashboard scorecards display by default.
   * ---------------------------------------------------------------- */
  DELAY_BASIS: 'gross',

  // ---- Consistency Tracker (lateness profile over the selected range) --
  // A hub needs at least this many EVALUATED checkpoints on a metric before
  // it can be ranked; below it, one bad night would decide the leaderboard.
  CONSISTENCY_MIN_EVALUATED: 3,
  CONSISTENCY_LIST_SIZE: 6,          // rows shown in the best / worst cards

  // Severity bands for AVERAGE minutes late per late occurrence. These drive
  // bar colour only, never a ranking. Absolute minutes, not relative rank,
  // so a colour means the same thing on every date range.
  DELAY_BAND_AMBER_MIN: 15,
  DELAY_BAND_RED_MIN: 30,

  // Server-side cache (seconds). Set to 0 to disable.
  CACHE_SECONDS: 300,
  CACHE_KEY: 'fmh_tracker_payload_v3',

  // Outside-Dhaka inbound linehaul dashboard
  OSD_SHEET_NAME: 'OSD To Central Sort',
  OSD_HEADER_ROW: 1,
  OSD_CACHE_KEY: 'osd_linehaul_source_v2',
  OSD_OFFENDER_THRESHOLD_PCT: 30,
  OSD_CONSISTENT_THRESHOLD_PCT: 10,

  // Prevent very large browser payloads from freezing the page. KPI and
  // aggregation calculations still use every filtered row; only the raw
  // detail table is capped.
  OSD_DETAIL_ROW_LIMIT: 2000
};

/* ---------------------------------------------------------------------
 * 1B. HUB SLOT DICTIONARY — Parcel Handover Set Times
 * Keys are NORMALISED hub names (lowercase, single-spaced, hyphenated).
 * ------------------------------------------------------------------- */
var HUB_SLOT_SET_TIME = {
  'badda':              { 1: '00:01:00' },
  'bhulta-gawsia':      { 1: '23:00:00', 2: '01:00:00' },
  'board bazar':        { 1: '00:30:00' },
  'donia':              { 1: '23:00:00', 2: '00:30:00' },
  'jatrabari':          { 1: '00:01:00', 2: '01:00:00' },
  'keraniganj':         { 1: '23:00:00' },
  'khilgaon':           { 1: '00:01:00' },
  'lalbagh':            { 1: '23:00:00', 2: '00:01:00', 3: '01:30:00', 4: '02:00:00' },
  'mirpur 60 feet':     { 1: '21:30:00', 2: '23:00:00', 3: '01:00:00', 4: '01:30:00' },
  'mohammadpur':        { 1: '23:00:00', 2: '01:00:00', 3: '01:30:00', 4: '02:00:00' },
  'narayanganj':        { 1: '00:01:00' },

  // >>> REVIEW: Slot 1 supplied as 10:30:00. Every other FMH slot falls in
  // the 20:00-02:00 night window, so this is very likely 22:30 or 01:30.
  // Value kept verbatim pending Operations confirmation.
  'pallabi':            { 1: '10:30:00', 2: '01:00:00', 3: '01:30:00' },

  'savar':              { 1: '21:00:00' },
  'tejgaon-mohakhali':  { 1: '20:00:00', 2: '21:30:00', 3: '23:00:00', 4: '00:30:00', 5: '01:30:00' },
  'uttara':             { 1: '00:01:00' },
  'demra':              { 1: '00:01:00' },
  'khilkhet':           { 1: '00:01:00' },
  'siddhirganj':        { 1: '23:00:00' },
  'kamrangirchar':      { 1: '23:00:00' },
  'gazipur-joydebpur':  { 1: '21:00:00' },
  'narayaganj-bandar':  { 1: '21:00:00' },
  'baipail-mouchak':    { 1: '21:00:00' }
  // NOTE: 'diabari' has a transit target but NO set time — handover status
  // will resolve to "Not Evaluated" until Operations supplies a slot time.
};

/* ---------------------------------------------------------------------
 * 1C. TRANSIT TIME DICTIONARY — Average Required Reach Time (minutes)
 * ------------------------------------------------------------------- */
var HUB_TRANSIT_LIMIT_MIN = {
  'badda': 30,  'tejgaon-mohakhali': 30,  'khilkhet': 30,
  'khilgaon': 33, 'uttara': 38, 'mirpur 60 feet': 40, 'mohammadpur': 40, 'diabari': 40,
  'pallabi': 42, 'jatrabari': 43, 'board bazar': 45, 'lalbagh': 45,
  'demra': 55, 'bhulta-gawsia': 56,
  'donia': 62,            // 1:02
  'keraniganj': 73,       // 1:13
  'kamrangirchar': 76,    // 1:16
  'narayanganj': 85,      // 1:25
  'siddhirganj': 85,      // 1:25
  'gazipur-joydebpur': 95,   // 1:35
  'savar': 108,              // 1:48
  'narayaganj-bandar': 118,  // 1:58
  'baipail-mouchak': 128     // 2:08
};

/* ---------------------------------------------------------------------
 * 1D. HUB NAME ALIASES — messy manual entry -> canonical key
 * Left side is compared after normalisation (lowercase, spaces collapsed).
 * ------------------------------------------------------------------- */
var HUB_ALIASES = {
  'mirpur': 'mirpur 60 feet',
  'mirpur60': 'mirpur 60 feet',
  'mirpur 60': 'mirpur 60 feet',
  'mirpur60feet': 'mirpur 60 feet',
  'mirpur-60 feet': 'mirpur 60 feet',
  'mirpur 60ft': 'mirpur 60 feet',
  'mirpur 60 ft': 'mirpur 60 feet',

  'tejgaon': 'tejgaon-mohakhali',
  'mohakhali': 'tejgaon-mohakhali',
  'tejgaon mohakhali': 'tejgaon-mohakhali',
  'tejgaon/mohakhali': 'tejgaon-mohakhali',

  'bhulta': 'bhulta-gawsia',
  'gawsia': 'bhulta-gawsia',
  'gaushia': 'bhulta-gawsia',
  'bhulta gawsia': 'bhulta-gawsia',
  'bhulta-gaushia': 'bhulta-gawsia',

  'boardbazar': 'board bazar',
  'board-bazar': 'board bazar',

  'gazipur': 'gazipur-joydebpur',
  'joydebpur': 'gazipur-joydebpur',
  'gazipur joydebpur': 'gazipur-joydebpur',

  'bandar': 'narayaganj-bandar',
  'narayanganj-bandar': 'narayaganj-bandar',
  'narayangonj-bandar': 'narayaganj-bandar',

  'baipail': 'baipail-mouchak',
  'mouchak': 'baipail-mouchak',
  'baipail mouchak': 'baipail-mouchak',

  'narayangonj': 'narayanganj',
  'narayanganj city': 'narayanganj',
  'siddhirgonj': 'siddhirganj',
  'kamrangir char': 'kamrangirchar',
  'keranigonj': 'keraniganj',
  'jatrabari ': 'jatrabari',
  'jatrabary': 'jatrabari',
  'mohammadpur ': 'mohammadpur',
  'lalbag': 'lalbagh',
  'khilgao': 'khilgaon',
  'dhiabari': 'diabari',
  'diyabari': 'diabari'
};

/* ---------------------------------------------------------------------
 * 1E. COLUMN HEADER ALIASES — sheet header -> logical field
 * ------------------------------------------------------------------- */
var HEADER_ALIASES = {
  date:      ['date', 'trip date', 'report date', 'operation date', 'operational date', 'ops date'],
  hub:       ['hub name', 'hub', 'fmh', 'fmh name', 'pickup hub', 'hub_name', 'first mile hub'],
  slot:      ['slot', 'slot number', 'slot no', 'slot no.', 'slot #', 'trip slot'],
  setTime:   ['set time', 'scheduled time', 'schedule time', 'parcel handover set time', 'sla time'],
  handover:  ['parcel handover time', 'handover time', 'actual handover time', 'actual handover',
              'parcel handover', 'handover', 'hand over time', 'parcel hand over time'],
  left:      ['van left time', 'left time', 'van left', 'departure time', 'van departure time',
              'left hub time', 'van leave time', 'dispatch time'],
  reach:     ['van reach time', 'reach time', 'van reach', 'arrival time', 'warehouse reach time',
              'reach warehouse time', 'van reached time', 'central sort reach time', 'cs reach time'],
  remarks:   ['remarks', 'remark', 'comment', 'comments', 'reason', 'delay reason', 'note', 'notes'],
  van:       ['van no', 'van number', 'van', 'vehicle no', 'vehicle number', 'van id', 'truck no'],
  driver:    ['driver', 'driver name', 'van driver'],
  parcels:   ['parcel qty', 'total parcel', 'total parcels', 'parcel count', 'no of parcel',
              'parcels', 'qty', 'quantity', 'parcel quantity']
};

/* =====================================================================
 * 2. WEB APP ENTRY POINTS
 * ===================================================================== */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('CarryBee — FMH & Linehaul Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FMH Tracker')
    .addItem('Open Dashboard', 'showDashboardSidebar_')
    .addItem('Clear Cache', 'clearDashboardCache')
    .addItem('Test Dashboard Setup', 'testDashboardSetup')
    .addItem('Run Data Quality Check', 'runDataQualityCheck')
    .addToUi();
}

function showDashboardSidebar_() {
  var html = HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('FMH & Linehaul Tracker').setWidth(1400);
  SpreadsheetApp.getUi().showModalDialog(html, 'CarryBee — FMH & Linehaul Tracker');
}

function clearDashboardCache() {
  var cache = CacheService.getScriptCache();
  cache.remove(CONFIG.CACHE_KEY);
  cache.remove(CONFIG.OSD_CACHE_KEY);
  return 'FMH and OSD dashboard caches cleared.';
}

/* =====================================================================
 * 3. MAIN SERVER FUNCTION
 * ===================================================================== */

/**
 * Fetch, clean, evaluate and return the full FMH dataset.
 * @param {boolean} forceRefresh  bypass cache
 * @return {Object} { ok, rows, filters, reference, dq, meta }
 */
function getDashboardData(forceRefresh) {
  try {
    var cache = CacheService.getScriptCache();
    if (!forceRefresh && CONFIG.CACHE_SECONDS > 0) {
      var hit = cache.get(CONFIG.CACHE_KEY);
      if (hit) {
        var parsed = JSON.parse(hit);
        parsed.meta.fromCache = true;
        return parsed;
      }
    }

    var ss = SpreadsheetApp.getActive();
    var tz = ss.getSpreadsheetTimeZone() || 'Asia/Dhaka';
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

    if (!sheet) {
      return errorPayload_('Sheet "' + CONFIG.SHEET_NAME + '" was not found in this spreadsheet.');
    }

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow <= CONFIG.HEADER_ROW) {
      return errorPayload_('Sheet "' + CONFIG.SHEET_NAME + '" has a header but no data rows.');
    }

    var range = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastCol);
    var values = range.getValues();
    var display = range.getDisplayValues();   // fallback for messy / formatted cells

    var headers = values[0];
    var colMap = mapHeaders_(headers);

    var missingCore = [];
    ['date', 'hub', 'slot', 'handover', 'left', 'reach'].forEach(function (k) {
      if (colMap[k] === undefined) missingCore.push(k);
    });
    if (missingCore.indexOf('date') > -1 || missingCore.indexOf('hub') > -1) {
      return errorPayload_(
        'Required column(s) not found: ' + missingCore.join(', ') +
        '. Headers detected: ' + headers.filter(String).join(' | ')
      );
    }

    var dq = {
      totalSourceRows: 0,
      blankRowsSkipped: 0,
      unmappedHubs: {},
      missingSlotConfig: {},
      unparsedDate: 0,
      unparsedHandover: 0,
      unparsedLeft: 0,
      unparsedReach: 0,
      sequenceAnomalies: 0,
      implausibleTravel: 0,
      duplicateKeys: {},
      missingColumns: missingCore,
      notes: []
    };

    var rows = [];
    var seenKeys = {};

    for (var r = 1; r < values.length; r++) {
      var v = values[r];
      var d = display[r];

      if (isRowBlank_(v)) { dq.blankRowsSkipped++; continue; }
      dq.totalSourceRows++;

      var rec = buildRecord_(v, d, colMap, tz, r + CONFIG.HEADER_ROW, dq);
      if (!rec) { continue; }

      var key = rec.dateISO + '|' + rec.hubKey + '|' + rec.slot;
      seenKeys[key] = (seenKeys[key] || 0) + 1;
      if (seenKeys[key] === 2) dq.duplicateKeys[key] = 2;
      else if (seenKeys[key] > 2) dq.duplicateKeys[key] = seenKeys[key];

      rows.push(rec);
    }

    // --- Filter option lists -------------------------------------------
    var hubSet = {}, slotSet = {}, dateSet = {};
    rows.forEach(function (x) {
      if (x.hubLabel) hubSet[x.hubLabel] = true;
      if (x.slot !== '') slotSet[x.slot] = true;
      if (x.dateISO) dateSet[x.dateISO] = true;
    });

    // --- Server-side aggregation (full dataset, unfiltered) -------------
    var latenessBook = buildLatenessBook_(rows, CONFIG.DELAY_BASIS);

    var payload = {
      ok: true,
      rows: rows,
      filters: {
        hubs: Object.keys(hubSet).sort(),
        slots: Object.keys(slotSet).sort(function (a, b) { return Number(a) - Number(b); }),
        dates: Object.keys(dateSet).sort()
      },
      lateness: latenessBook,
      hubDelayTotals: buildHubDelayTotals_(rows, CONFIG.DELAY_BASIS),
      reference: {
        handoverGrace: CONFIG.HANDOVER_GRACE_MIN,
        dispatchGrace: CONFIG.DISPATCH_GRACE_MIN,
        defaultTravelLimit: CONFIG.DEFAULT_TRAVEL_LIMIT_MIN,
        transitLimits: HUB_TRANSIT_LIMIT_MIN,
        delayBasis: CONFIG.DELAY_BASIS,
        minEvaluated: CONFIG.CONSISTENCY_MIN_EVALUATED,
        listSize: CONFIG.CONSISTENCY_LIST_SIZE,
        bandAmberMin: CONFIG.DELAY_BAND_AMBER_MIN,
        bandRedMin: CONFIG.DELAY_BAND_RED_MIN
      },
      dq: dq,
      meta: {
        sheet: CONFIG.SHEET_NAME,
        timezone: tz,
        generatedAt: Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm:ss'),
        rowCount: rows.length,
        dayCount: Object.keys(dateSet).length,
        fromCache: false
      }
    };

    if (CONFIG.CACHE_SECONDS > 0) {
      try {
        var s = JSON.stringify(payload);
        if (s.length < 95000) cache.put(CONFIG.CACHE_KEY, s, CONFIG.CACHE_SECONDS);
      } catch (ignore) { /* payload too large for cache — serve live */ }
    }

    return payload;

  } catch (err) {
    return errorPayload_(err && err.message ? err.message : String(err));
  }
}

function errorPayload_(msg) {
  var book = {};
  ['handover', 'dispatch', 'arrival', 'overall'].forEach(function (m) {
    book[m] = { label: '', profiles: [],
                ranking: { basis: 'total', basisLabel: '', best: [], worst: [], all: [],
                           insufficientData: [], minEvaluated: CONFIG.CONSISTENCY_MIN_EVALUATED } };
  });
  return {
    ok: false,
    error: msg,
    rows: [],
    filters: { hubs: [], slots: [], dates: [] },
    lateness: book,
    hubDelayTotals: [],
    reference: {},
    dq: {},
    meta: { generatedAt: '', rowCount: 0 }
  };
}

/* =====================================================================
 * 3B. OSD / LINEHAUL DASHBOARD
 * ===================================================================== */

/**
 * Exact source headers from the "OSD To Central Sort" sheet. The mapper
 * attempts an exact match first, then a whitespace-normalised exact match so
 * line breaks, leading spaces and trailing spaces remain supported.
 *
 * Arrival Status is intentionally NOT read from the sheet. It is calculated
 * below from Van Departure, Max. Targeted Arrival and Actual Arrival.
 */
var OSD_HEADERS = {
  date:      'Reporting Date',
  sender:    'Name of Senders',
  route:     ' Route',
  handover:  'Parcel Handover  \nTime To TNL',
  departure: 'Van Departure  ',
  target:    'Max. Targeted\n Arrival',
  arrival:   'Arrived at \nCentral Sort',
  duration:  'Trip Duration'
};

/**
 * Return OSD linehaul data after applying validated server-side filters.
 *
 * filters = {
 *   startDate: 'yyyy-MM-dd', endDate: 'yyyy-MM-dd',
 *   route: exact route label, sender: exact sender label,
 *   forceRefresh: boolean
 * }
 */
function getOsdDashboardData(filters) {
  try {
    filters = filters || {};
    var source = getOsdSourcePayload_(filters.forceRefresh === true);
    if (!source.ok) return source;

    var startDate = sanitiseIsoDate_(filters.startDate);
    var endDate = sanitiseIsoDate_(filters.endDate);
    if (filters.startDate && !startDate) return osdErrorPayload_('Invalid start date. Use yyyy-MM-dd.');
    if (filters.endDate && !endDate) return osdErrorPayload_('Invalid end date. Use yyyy-MM-dd.');
    if (startDate && endDate && startDate > endDate) {
      return osdErrorPayload_('Start date cannot be after end date.');
    }

    var route = sanitiseOsdFilter_(filters.route);
    var sender = sanitiseOsdFilter_(filters.sender);
    var validRoutes = listToSet_(source.filters.routes);
    var validSenders = listToSet_(source.filters.senders);

    // Only exact values discovered in the sheet are accepted. This prevents
    // arbitrary client input from affecting spreadsheet access or matching.
    if (route && !validRoutes[route]) return osdErrorPayload_('The selected route is not available.');
    if (sender && !validSenders[sender]) return osdErrorPayload_('The selected sender is not available.');

    var rows = source.rows.filter(function (r) {
      if (startDate && (!r.dateISO || r.dateISO < startDate)) return false;
      if (endDate && (!r.dateISO || r.dateISO > endDate)) return false;
      if (route && r.route !== route) return false;
      if (sender && r.sender !== sender) return false;
      return true;
    });

    rows.sort(function (a, b) {
      if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? 1 : -1;
      if (a.route !== b.route) return a.route.localeCompare(b.route);
      return a.row - b.row;
    });

    var routeStats = aggregateOsdRows_(rows, 'route');
    var senderStats = aggregateOsdRows_(rows, 'sender');
    var evaluatedCount = rows.reduce(function (n, r) { return n + (r.evaluated ? 1 : 0); }, 0);
    var lateCount = rows.reduce(function (n, r) { return n + (r.isLate ? 1 : 0); }, 0);
    var activeRouteSet = {};
    rows.forEach(function (r) { if (r.route) activeRouteSet[r.route] = true; });

    // Send a bounded raw detail set to the browser. This avoids a large sheet
    // making google.script.run appear to hang, while all KPIs and rankings are
    // still calculated from the complete filtered dataset above.
    var detailLimit = Math.max(1, Number(CONFIG.OSD_DETAIL_ROW_LIMIT || 2000));
    var detailRows = rows.slice(0, detailLimit);

    return {
      ok: true,
      rows: detailRows,
      filters: source.filters,
      kpis: {
        activeRoutes: Object.keys(activeRouteSet).length,
        totalTrips: rows.length,
        evaluatedTrips: evaluatedCount,
        notEvaluatedTrips: rows.length - evaluatedCount,
        lateCount: lateCount,
        lateRate: evaluatedCount ? round2_(lateCount * 100 / evaluatedCount) : 0
      },
      aggregates: {
        route: routeStats,
        sender: senderStats,
        offenderThresholdPct: CONFIG.OSD_OFFENDER_THRESHOLD_PCT,
        consistentThresholdPct: CONFIG.OSD_CONSISTENT_THRESHOLD_PCT
      },
      dq: source.dq,
      meta: {
        sheet: CONFIG.OSD_SHEET_NAME,
        timezone: source.meta.timezone,
        generatedAt: source.meta.generatedAt,
        sourceRowCount: source.meta.rowCount,
        filteredRowCount: rows.length,
        detailRowCount: detailRows.length,
        detailRowLimit: detailLimit,
        detailTruncated: rows.length > detailRows.length,
        fromCache: source.meta.fromCache,
        applied: { startDate: startDate, endDate: endDate, route: route, sender: sender },
        statusRule: 'Actual arrival is Late only when its overnight-anchored time is after the overnight-anchored SLA cut-off.'
      }
    };
  } catch (err) {
    return osdErrorPayload_(err && err.message ? err.message : String(err));
  }
}

/** Read and normalise the full OSD sheet, with a small script cache. */
function getOsdSourcePayload_(forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh && CONFIG.CACHE_SECONDS > 0) {
    var hit = cache.get(CONFIG.OSD_CACHE_KEY);
    if (hit) {
      var cached = JSON.parse(hit);
      cached.meta.fromCache = true;
      return cached;
    }
  }

  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Dhaka';
  var sheet = ss.getSheetByName(CONFIG.OSD_SHEET_NAME);
  if (!sheet) return osdErrorPayload_('Sheet "' + CONFIG.OSD_SHEET_NAME + '" was not found.');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= CONFIG.OSD_HEADER_ROW) {
    return osdErrorPayload_('Sheet "' + CONFIG.OSD_SHEET_NAME + '" has no data rows.');
  }

  var range = sheet.getRange(CONFIG.OSD_HEADER_ROW, 1,
    lastRow - CONFIG.OSD_HEADER_ROW + 1, lastCol);
  var values = range.getValues();
  var display = range.getDisplayValues();
  // Display text is the safest header source when a header is generated by a
  // formula or contains line breaks. Fall back to the raw value when needed.
  var headers = display[0].map(function (h, i) {
    return String(h || values[0][i] || '');
  });
  var col = mapOsdHeaders_(headers);

  // These fields are required to identify the trip and calculate the SLA.
  var required = ['date', 'sender', 'route', 'departure', 'target', 'arrival'];
  var missingRequired = required.filter(function (k) { return col[k] === undefined; });
  if (missingRequired.length) {
    return osdErrorPayload_(
      'Required OSD column(s) not found: ' + missingRequired.join(', ') +
      '. Headers detected: ' + headers.filter(String).join(' | ')
    );
  }

  var missingOptional = ['handover', 'duration']
    .filter(function (k) { return col[k] === undefined; });
  var dq = {
    totalSourceRows: 0,
    blankRowsSkipped: 0,
    unparsedDates: 0,
    unparsedDeparture: 0,
    unparsedTarget: 0,
    unparsedArrival: 0,
    notEvaluatedTrips: 0,
    missingOptionalColumns: missingOptional
  };
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var raw = values[r];
    var disp = display[r];
    if (isRowBlank_(raw)) { dq.blankRowsSkipped++; continue; }
    dq.totalSourceRows++;

    var date = parseDateCell_(pickRaw_(raw, col.date), pick_(raw, disp, col.date), tz);
    if (!date) { dq.unparsedDates++; continue; }

    var handoverMin = parseTimeCell_(pickRaw_(raw, col.handover), pick_(raw, disp, col.handover), tz);
    var departureMin = parseTimeCell_(pickRaw_(raw, col.departure), pick_(raw, disp, col.departure), tz);
    var targetMin = parseTimeCell_(pickRaw_(raw, col.target), pick_(raw, disp, col.target), tz);
    var arrivalMin = parseTimeCell_(pickRaw_(raw, col.arrival), pick_(raw, disp, col.arrival), tz);

    if (departureMin === null) dq.unparsedDeparture++;
    if (targetMin === null) dq.unparsedTarget++;
    if (arrivalMin === null) dq.unparsedArrival++;

    var sla = calculateOsdArrivalSla_(departureMin, targetMin, arrivalMin);
    if (!sla.evaluated) dq.notEvaluatedTrips++;

    rows.push({
      row: r + CONFIG.OSD_HEADER_ROW,
      dateISO: date.iso,
      dateLabel: date.label,
      sender: cleanOsdText_(pick_(raw, disp, col.sender)) || '(blank sender)',
      route: cleanOsdText_(pick_(raw, disp, col.route)) || '(blank route)',
      handoverTime: osdTimeDisplay_(raw, disp, col.handover, tz, handoverMin),
      departureTime: osdTimeDisplay_(raw, disp, col.departure, tz, departureMin),
      maxTargetArrival: osdTimeDisplay_(raw, disp, col.target, tz, targetMin),
      actualArrival: osdTimeDisplay_(raw, disp, col.arrival, tz, arrivalMin),
      tripDuration: osdDisplayValue_(raw, disp, col.duration, tz),

      // Server-calculated SLA verdict. Never sourced from an Arrival Status column.
      status: sla.status,
      evaluated: sla.evaluated,
      isLate: sla.isLate,
      isNoLate: sla.isNoLate,
      lateByMin: sla.lateByMin,
      calculatedTripMin: sla.tripMin,
      departureDayMinute: sla.departureAnchoredMin,
      targetDeadlineMinute: sla.targetAnchoredMin,
      actualArrivalMinute: sla.arrivalAnchoredMin
    });
  }

  var routeSet = {}, senderSet = {}, dateSet = {};
  rows.forEach(function (r) {
    if (r.route) routeSet[r.route] = true;
    if (r.sender) senderSet[r.sender] = true;
    if (r.dateISO) dateSet[r.dateISO] = true;
  });

  var payload = {
    ok: true,
    rows: rows,
    filters: {
      routes: Object.keys(routeSet).sort(),
      senders: Object.keys(senderSet).sort(),
      dates: Object.keys(dateSet).sort()
    },
    dq: dq,
    meta: {
      sheet: CONFIG.OSD_SHEET_NAME,
      timezone: tz,
      generatedAt: Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm:ss'),
      rowCount: rows.length,
      fromCache: false
    }
  };

  if (CONFIG.CACHE_SECONDS > 0) {
    try {
      var json = JSON.stringify(payload);
      if (json.length < 95000) cache.put(CONFIG.OSD_CACHE_KEY, json, CONFIG.CACHE_SECONDS);
    } catch (ignore) { /* Serve live when payload is too large for CacheService. */ }
  }
  return payload;
}

/**
 * Overnight OSD arrival calculation.
 *
 * Example with departure 20:00 and cut-off 02:30:
 *   23:30 -> same operational night, before the next-day 02:30 cut-off.
 *   01:45 -> lifted to next day 01:45, still before the cut-off.
 *   04:00 -> lifted to next day 04:00, therefore Late.
 *
 * The comparison is strict: arrival exactly at the cut-off is No Late.
 */
function calculateOsdArrivalSla_(departureMin, targetMin, arrivalMin) {
  if (departureMin === null || targetMin === null || arrivalMin === null) {
    return {
      status: 'Not Evaluated', evaluated: false, isLate: false, isNoLate: false,
      lateByMin: null, tripMin: null,
      departureAnchoredMin: null, targetAnchoredMin: null, arrivalAnchoredMin: null
    };
  }

  var departureA = departureMin;

  // The SLA cut-off belongs to the first occurrence of that clock time after
  // departure. For an evening departure and a 02:30 cut-off, this becomes
  // 02:30 on the following calendar day (1590 minutes from day start).
  var targetA = targetMin;
  while (targetA <= departureA) targetA += 1440;

  // The actual arrival also belongs to the first occurrence at/after departure.
  // 23:30 remains same-day; 01:45 and 04:00 are lifted into the next day.
  var arrivalA = arrivalMin;
  while (arrivalA < departureA) arrivalA += 1440;

  var lateBy = Math.max(0, arrivalA - targetA);
  var isLate = arrivalA > targetA;

  return {
    status: isLate ? 'Late' : 'No Late',
    evaluated: true,
    isLate: isLate,
    isNoLate: !isLate,
    lateByMin: lateBy,
    tripMin: arrivalA - departureA,
    departureAnchoredMin: departureA,
    targetAnchoredMin: targetA,
    arrivalAnchoredMin: arrivalA
  };
}

var OSD_HEADER_ALIASES = {
  date:      ['Reporting Date', 'Report Date', 'Date'],
  sender:    ['Name of Senders', 'Name of Sender', 'Sender', 'Sender Name', 'Hub Name'],
  route:     [' Route', 'Route', 'Route Name'],
  handover:  ['Parcel Handover  \nTime To TNL', 'Parcel Handover Time To TNL', 'Parcel Handover Time', 'Handover Time'],
  departure: ['Van Departure  ', 'Van Departure', 'Departure Time', 'Van Left'],
  target:    ['Max. Targeted\n Arrival', 'Max. Targeted Arrival', 'Maximum Targeted Arrival', 'SLA Max Arrival'],
  arrival:   ['Arrived at \nCentral Sort', 'Arrived at Central Sort', 'Actual Arrival', 'Central Sort Arrival'],
  duration:  ['Trip Duration', 'Total Trip Duration', 'Duration']
};

function mapOsdHeaders_(headers) {
  var map = {};
  var normalised = headers.map(normaliseHeader_);

  Object.keys(OSD_HEADERS).forEach(function (field) {
    var exact = OSD_HEADERS[field];

    // Preserve support for the exact, space-sensitive source names first.
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]) === exact) { map[field] = i; return; }
    }

    // Then accept harmless spacing, line-break and common label variations.
    var aliases = (OSD_HEADER_ALIASES[field] || [exact]).map(normaliseHeader_);
    for (var j = 0; j < normalised.length; j++) {
      if (aliases.indexOf(normalised[j]) > -1) { map[field] = j; return; }
    }
  });
  return map;
}

function aggregateOsdRows_(rows, field) {
  var grouped = {};
  rows.forEach(function (r) {
    var label = r[field] || '(blank)';
    if (!grouped[label]) {
      grouped[label] = { label: label, totalTrips: 0, evaluatedTrips: 0, lateCount: 0 };
    }
    grouped[label].totalTrips++;
    if (r.evaluated) grouped[label].evaluatedTrips++;
    if (r.isLate) grouped[label].lateCount++;
  });

  return Object.keys(grouped).map(function (label) {
    var x = grouped[label];
    x.notEvaluatedTrips = x.totalTrips - x.evaluatedTrips;
    x.lateRate = x.evaluatedTrips ? round2_(x.lateCount * 100 / x.evaluatedTrips) : 0;
    return x;
  }).sort(function (a, b) {
    if (b.lateCount !== a.lateCount) return b.lateCount - a.lateCount;
    if (b.lateRate !== a.lateRate) return b.lateRate - a.lateRate;
    return a.label.localeCompare(b.label);
  });
}

function osdTimeDisplay_(values, display, idx, tz, parsedMin) {
  if (parsedMin !== null && parsedMin !== undefined) return minutesToHHMM_(parsedMin);
  return osdDisplayValue_(values, display, idx, tz);
}

function osdDisplayValue_(values, display, idx, tz) {
  if (idx === undefined) return '';
  var shown = cleanOsdText_(display[idx]);
  if (shown) return shown;
  var raw = values[idx];
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return Utilities.formatDate(raw, tz, 'HH:mm:ss');
  }
  return cleanOsdText_(raw);
}

function cleanOsdText_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitiseIsoDate_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  var parts = s.split('-');
  var y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  var dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  return s;
}

function sanitiseOsdFilter_(value) {
  var s = cleanOsdText_(value);
  return s.length > 200 ? s.substring(0, 200) : s;
}

function listToSet_(items) {
  var out = {};
  (items || []).forEach(function (x) { out[x] = true; });
  return out;
}

function round2_(n) { return Math.round(Number(n || 0) * 100) / 100; }

function osdErrorPayload_(msg) {
  return {
    ok: false,
    error: msg,
    rows: [],
    filters: { routes: [], senders: [], dates: [] },
    kpis: {
      activeRoutes: 0, totalTrips: 0, evaluatedTrips: 0,
      notEvaluatedTrips: 0, lateCount: 0, lateRate: 0
    },
    aggregates: { route: [], sender: [] },
    dq: {},
    meta: { sheet: CONFIG.OSD_SHEET_NAME, generatedAt: '', filteredRowCount: 0 }
  };
}

/* =====================================================================
 * 4. RECORD BUILDER + SLA EVALUATION
 * ===================================================================== */

function buildRecord_(v, d, c, tz, sheetRow, dq) {
  var rawHub = pick_(v, d, c.hub);
  var hubKey = normaliseHub_(rawHub);
  var hubLabel = hubKey ? titleCaseHub_(hubKey) : (String(rawHub || '').trim() || '(blank)');

  var known = !!(HUB_SLOT_SET_TIME[hubKey] || HUB_TRANSIT_LIMIT_MIN[hubKey]);
  if (!known && rawHub) {
    dq.unmappedHubs[String(rawHub).trim()] = (dq.unmappedHubs[String(rawHub).trim()] || 0) + 1;
  }

  // ---- Date --------------------------------------------------------
  var dateObj = parseDateCell_(pickRaw_(v, c.date), pick_(v, d, c.date), tz);
  if (!dateObj) dq.unparsedDate++;

  // ---- Slot --------------------------------------------------------
  var slot = parseSlot_(pick_(v, d, c.slot));

  // ---- Set time (dictionary first, sheet column as fallback) --------
  var setSrc = 'dictionary';
  var setMin = null;
  if (hubKey && HUB_SLOT_SET_TIME[hubKey] && HUB_SLOT_SET_TIME[hubKey][slot] !== undefined) {
    setMin = hhmmssToMinutes_(HUB_SLOT_SET_TIME[hubKey][slot]);
  } else {
    if (c.setTime !== undefined) {
      setMin = parseTimeCell_(pickRaw_(v, c.setTime), pick_(v, d, c.setTime), tz);
      if (setMin !== null) setSrc = 'sheet column';
    }
    if (setMin === null && hubKey) {
      var mk = hubLabel + ' / Slot ' + (slot === '' ? '(blank)' : slot);
      dq.missingSlotConfig[mk] = (dq.missingSlotConfig[mk] || 0) + 1;
      setSrc = 'not configured';
    }
  }

  // ---- Raw clock times ---------------------------------------------
  var hoMin = parseTimeCell_(pickRaw_(v, c.handover), pick_(v, d, c.handover), tz);
  var lfMin = parseTimeCell_(pickRaw_(v, c.left), pick_(v, d, c.left), tz);
  var rcMin = parseTimeCell_(pickRaw_(v, c.reach), pick_(v, d, c.reach), tz);

  if (hoMin === null) dq.unparsedHandover++;
  if (lfMin === null) dq.unparsedLeft++;
  if (rcMin === null) dq.unparsedReach++;

  // ---- Anchor to a single operational night -------------------------
  // Everything is expressed as minutes from midnight of the operational
  // date, and may exceed 1440 when the event happens after midnight.
  var setA = (setMin === null) ? null : anchor_(setMin);
  var hoA  = null, lfA = null, rcA = null;
  var seqFlag = false;

  if (hoMin !== null) {
    hoA = (setA === null) ? anchor_(hoMin) : alignNear_(hoMin, setA);
  }
  if (lfMin !== null) {
    if (hoA !== null) {
      lfA = alignForward_(lfMin, hoA, CONFIG.SEQUENCE_TOLERANCE_MIN);
      if (lfA < hoA) seqFlag = true;
    } else {
      lfA = anchor_(lfMin);
    }
  }
  if (rcMin !== null) {
    if (lfA !== null) {
      rcA = alignForward_(rcMin, lfA, CONFIG.SEQUENCE_TOLERANCE_MIN);
      if (rcA < lfA) seqFlag = true;
    } else {
      rcA = anchor_(rcMin);
    }
  }
  if (seqFlag) dq.sequenceAnomalies++;

  // ---- Rule A1: Hub Handover Status ---------------------------------
  var handoverDelay = null, handoverStatus = 'Not Evaluated';
  if (setA !== null && hoA !== null) {
    handoverDelay = hoA - setA;
    handoverStatus = (handoverDelay > CONFIG.HANDOVER_GRACE_MIN) ? 'Late Handover' : 'On Time';
  }

  // ---- Rule A2: Van Dispatch Status ---------------------------------
  var dispatchDelay = null, dispatchStatus = 'Not Evaluated';
  if (hoA !== null && lfA !== null) {
    dispatchDelay = lfA - hoA;
    dispatchStatus = (dispatchDelay > CONFIG.DISPATCH_GRACE_MIN) ? 'Late Move' : 'On Time';
  }

  // ---- Rule A3: Travel / Reach Status -------------------------------
  var travelMin = null, reachStatus = 'Not Evaluated', reachOver = null;
  var travelLimit = (hubKey && HUB_TRANSIT_LIMIT_MIN[hubKey] !== undefined)
      ? HUB_TRANSIT_LIMIT_MIN[hubKey]
      : CONFIG.DEFAULT_TRAVEL_LIMIT_MIN;
  var travelLimitSrc = (hubKey && HUB_TRANSIT_LIMIT_MIN[hubKey] !== undefined)
      ? 'hub target' : 'default 01:30:00';

  if (lfA !== null && rcA !== null) {
    travelMin = rcA - lfA;
    if (travelMin < 0 || travelMin > CONFIG.MAX_PLAUSIBLE_TRAVEL_MIN) {
      dq.implausibleTravel++;
      reachStatus = 'Not Evaluated';   // quarantine — do not pollute the KPI
      travelMin = null;
    } else {
      reachOver = travelMin - travelLimit;
      reachStatus = (travelMin > travelLimit) ? 'Late Reach' : 'On Time';
    }
  }

  var breaches = 0;
  if (handoverStatus === 'Late Handover') breaches++;
  if (dispatchStatus === 'Late Move') breaches++;
  if (reachStatus === 'Late Reach') breaches++;

  /* ---- Delay durations (minutes) ------------------------------------
   * gross = Actual - SLA Target. net = gross - grace window.
   * On-time checkpoints contribute 0 (not null) so the totals below are
   * a clean sum. Not Evaluated stays null and is excluded everywhere.
   * The reach checkpoint has no grace window, so gross === net there.
   * ------------------------------------------------------------------ */
  var hoDelayGross = delayGross_(handoverStatus, 'Late Handover', handoverDelay);
  var hoDelayNet   = delayNet_(hoDelayGross, CONFIG.HANDOVER_GRACE_MIN);
  var dpDelayGross = delayGross_(dispatchStatus, 'Late Move', dispatchDelay);
  var dpDelayNet   = delayNet_(dpDelayGross, CONFIG.DISPATCH_GRACE_MIN);
  var rcDelayGross = delayGross_(reachStatus, 'Late Reach', reachOver);
  var rcDelayNet   = rcDelayGross;

  var totalDelayGross = sumNotNull_([hoDelayGross, dpDelayGross, rcDelayGross]);
  var totalDelayNet   = sumNotNull_([hoDelayNet, dpDelayNet, rcDelayNet]);

  return {
    row: sheetRow,
    dateISO: dateObj ? dateObj.iso : '',
    dateLabel: dateObj ? dateObj.label : String(pick_(v, d, c.date) || ''),
    hubKey: hubKey,
    hubLabel: hubLabel,
    hubMapped: known,
    slot: slot === '' ? '' : String(slot),

    setTime: (setMin === null) ? '' : minutesToHHMM_(setMin),
    setTimeSource: setSrc,
    handoverTime: (hoMin === null) ? '' : minutesToHHMM_(hoMin),
    leftTime: (lfMin === null) ? '' : minutesToHHMM_(lfMin),
    reachTime: (rcMin === null) ? '' : minutesToHHMM_(rcMin),

    handoverDelayMin: handoverDelay,
    dispatchDelayMin: dispatchDelay,
    travelMin: travelMin,
    travelLimitMin: travelLimit,
    travelLimitSource: travelLimitSrc,
    reachOverMin: reachOver,

    handoverStatus: handoverStatus,
    dispatchStatus: dispatchStatus,
    reachStatus: reachStatus,
    breachCount: breaches,
    sequenceAnomaly: seqFlag,

    // Delay durations — 0 when on time, null when Not Evaluated
    hoDelayGrossMin: hoDelayGross,
    hoDelayNetMin: hoDelayNet,
    dpDelayGrossMin: dpDelayGross,
    dpDelayNetMin: dpDelayNet,
    rcDelayGrossMin: rcDelayGross,
    rcDelayNetMin: rcDelayNet,
    totalDelayGrossMin: totalDelayGross,
    totalDelayNetMin: totalDelayNet,

    van: c.van !== undefined ? String(pick_(v, d, c.van) || '') : '',
    driver: c.driver !== undefined ? String(pick_(v, d, c.driver) || '') : '',
    parcels: c.parcels !== undefined ? toNumberOrNull_(pick_(v, d, c.parcels)) : null,
    remarks: c.remarks !== undefined ? String(pick_(v, d, c.remarks) || '').trim() : ''
  };
}

/* =====================================================================
 * 4B. DELAY DURATION HELPERS
 * ===================================================================== */

/** Breach variance in minutes: the raw (Actual - SLA Target) gap. */
function delayGross_(status, breachLabel, variance) {
  if (status === 'Not Evaluated') return null;
  if (status !== breachLabel) return 0;               // On Time
  if (variance === null || variance === undefined) return null;
  return Math.max(0, Math.round(variance));
}

/** Same variance, less the grace window the hub is permitted. */
function delayNet_(gross, graceMin) {
  if (gross === null) return null;
  return Math.max(0, gross - (gross > 0 ? (graceMin || 0) : 0));
}

function sumNotNull_(arr) {
  var total = 0, seen = false;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === null || arr[i] === undefined) continue;
    total += arr[i];
    seen = true;
  }
  return seen ? total : null;
}

/* =====================================================================
 * 4C. LATENESS PROFILE + CONSISTENCY RANKING
 * ---------------------------------------------------------------------
 * The tracker answers one question per checkpoint, over whatever date
 * range is selected:
 *
 *     How OFTEN was this hub late, and by HOW MUCH when it was?
 *
 * For every Hub x metric pair we keep the count of late occurrences plus
 * the total, minimum, maximum and average minutes of lateness. Min / max /
 * average are computed over the LATE OCCURRENCES ONLY — an on-time trip is
 * not a "0 minute delay" that drags the average down, it simply is not a
 * delay. Total minutes is the operational cost; average is the severity
 * per incident; max minus min is the spread, i.e. how predictable the hub
 * is when it does slip.
 *
 * Nothing here is a percentage and nothing is a streak. A hub is ranked on
 * one explicitly chosen basis (total / count / average / max / spread) so
 * the ordering is always explainable to Operations.
 *
 * ASSUMPTION (labelled, per DIR standard): the same aggregation runs
 * SERVER-side over the full dataset (payload.lateness, for exports and API
 * consumers) and CLIENT-side over the filtered rows, so the widget tracks
 * the Date / Hub / Slot slicers without a round trip. Row-level SLA
 * verdicts and delay minutes stay server-computed and are never
 * recalculated in the browser.
 * ===================================================================== */

var LATENESS_METRICS = {
  handover: { key: 'handover', label: 'Hub Handover',       status: 'handoverStatus', breach: 'Late Handover', gross: 'hoDelayGrossMin', net: 'hoDelayNetMin' },
  dispatch: { key: 'dispatch', label: 'Van Dispatch',       status: 'dispatchStatus', breach: 'Late Move',     gross: 'dpDelayGrossMin', net: 'dpDelayNetMin' },
  arrival:  { key: 'arrival',  label: 'Warehouse Arrival',  status: 'reachStatus',    breach: 'Late Reach',    gross: 'rcDelayGrossMin', net: 'rcDelayNetMin' }
};

/** Running min / max / sum / count over a stream of late durations. */
function newStat_() {
  return { lateCount: 0, evaluated: 0, totalMin: 0, minMin: null, maxMin: null,
           avgMin: null, spreadMin: null, worstDate: '', worstSlot: '' };
}

function pushLate_(stat, minutes, dateLabel, slot) {
  stat.lateCount++;
  stat.totalMin += minutes;
  if (stat.minMin === null || minutes < stat.minMin) stat.minMin = minutes;
  if (stat.maxMin === null || minutes > stat.maxMin) {
    stat.maxMin = minutes;
    stat.worstDate = dateLabel || '';
    stat.worstSlot = (slot === '' || slot === null || slot === undefined) ? '' : String(slot);
  }
}

function sealStat_(stat) {
  stat.avgMin = stat.lateCount ? (stat.totalMin / stat.lateCount) : null;
  stat.spreadMin = (stat.lateCount && stat.minMin !== null && stat.maxMin !== null)
    ? (stat.maxMin - stat.minMin) : null;
  return stat;
}

/**
 * Build one lateness profile per hub for a single checkpoint metric.
 * @param {Array}  rows    record array from buildRecord_
 * @param {string} metric  'handover' | 'dispatch' | 'arrival' | 'overall'
 * @param {string} basis   'gross' | 'net'
 * @return {Array} profiles, unsorted
 */
function buildLatenessProfiles_(rows, metric, basis) {
  var net = (basis === 'net');
  var defs = (metric === 'overall')
    ? [LATENESS_METRICS.handover, LATENESS_METRICS.dispatch, LATENESS_METRICS.arrival]
    : [LATENESS_METRICS[metric]];
  if (!defs[0]) return [];

  var map = {};

  (rows || []).forEach(function (r) {
    var hub = r.hubLabel || '(blank)';
    if (!map[hub]) {
      map[hub] = { hub: hub, metric: metric, trips: 0, stat: newStat_() };
    }
    var p = map[hub];
    p.trips++;

    defs.forEach(function (def) {
      var status = r[def.status];
      if (status === 'Not Evaluated') return;      // never counted either way
      p.stat.evaluated++;
      if (status !== def.breach) return;           // on time

      var mins = r[net ? def.net : def.gross];
      if (mins === null || mins === undefined) return;
      pushLate_(p.stat, mins, r.dateLabel, r.slot);
    });
  });

  return Object.keys(map).map(function (k) {
    var p = map[k];
    sealStat_(p.stat);
    // Flatten the stat onto the profile so consumers read one object.
    p.evaluated  = p.stat.evaluated;
    p.lateCount  = p.stat.lateCount;
    p.onTimeCount = p.stat.evaluated - p.stat.lateCount;
    p.totalMin   = p.stat.totalMin;
    p.minMin     = p.stat.minMin;
    p.maxMin     = p.stat.maxMin;
    p.avgMin     = p.stat.avgMin;
    p.spreadMin  = p.stat.spreadMin;
    p.worstDate  = p.stat.worstDate;
    p.worstSlot  = p.stat.worstSlot;
    p.rankable   = p.stat.evaluated >= CONFIG.CONSISTENCY_MIN_EVALUATED;
    delete p.stat;
    return p;
  });
}

/** Ranking bases exposed to the UI. */
var RANK_BASES = {
  total:  { key: 'total',  field: 'totalMin',  label: 'Total time late' },
  count:  { key: 'count',  field: 'lateCount', label: 'Number of times late' },
  avg:    { key: 'avg',    field: 'avgMin',    label: 'Average time late' },
  max:    { key: 'max',    field: 'maxMin',    label: 'Worst single delay' },
  spread: { key: 'spread', field: 'spreadMin', label: 'Spread (max - min)' }
};

/**
 * Split profiles into best and worst on one explicit basis.
 *
 * A hub that was never late has no average, no max and no spread. It is
 * unambiguously the BEST on every basis, so it sorts first with a value of
 * zero; it is excluded from the worst list entirely rather than being
 * ranked on a number it does not have.
 */
function rankConsistency_(profiles, basisKey, listSize) {
  var basis = RANK_BASES[basisKey] || RANK_BASES.total;
  var field = basis.field;
  var size = listSize || CONFIG.CONSISTENCY_LIST_SIZE;

  var rankable = [], thin = [];
  (profiles || []).forEach(function (p) {
    if (p.rankable) rankable.push(p); else thin.push(p);
  });

  function val(p) {
    var v = p[field];
    return (v === null || v === undefined) ? 0 : v;
  }

  // Best: lowest first. Ties break on total minutes, then on late count, so
  // two hubs with one late trip each are separated by how bad it was.
  var best = rankable.slice().sort(function (a, b) {
    return (val(a) - val(b)) || (a.totalMin - b.totalMin) || (a.lateCount - b.lateCount);
  });

  // Worst: highest first, and only hubs that were actually late qualify.
  var worst = rankable.filter(function (p) { return p.lateCount > 0; })
    .sort(function (a, b) {
      return (val(b) - val(a)) || (b.totalMin - a.totalMin) || (b.lateCount - a.lateCount);
    });

  return {
    basis: basis.key,
    basisLabel: basis.label,
    best: best.slice(0, size),
    worst: worst.slice(0, size),
    all: rankable.slice().sort(function (a, b) {
      return (val(b) - val(a)) || (b.totalMin - a.totalMin);
    }),
    insufficientData: thin.map(function (p) {
      return { hub: p.hub, evaluated: p.evaluated, trips: p.trips };
    }),
    minEvaluated: CONFIG.CONSISTENCY_MIN_EVALUATED
  };
}

/** Whole-dataset lateness view, one entry per metric. */
function buildLatenessBook_(rows, basis) {
  var book = {};
  ['handover', 'dispatch', 'arrival', 'overall'].forEach(function (metric) {
    var profiles = buildLatenessProfiles_(rows, metric, basis);
    book[metric] = {
      label: (metric === 'overall') ? 'All checkpoints' : LATENESS_METRICS[metric].label,
      profiles: profiles,
      ranking: rankConsistency_(profiles, 'total', CONFIG.CONSISTENCY_LIST_SIZE)
    };
  });
  return book;
}

/** Flat Hub x metric delay totals, worst first. Kept for exports. */
function buildHubDelayTotals_(rows, basis) {
  var net = (basis === 'net');
  var map = {};
  (rows || []).forEach(function (r) {
    var k = r.hubLabel || '(blank)';
    if (!map[k]) map[k] = { hub: k, trips: 0, handoverDelayMin: 0, dispatchDelayMin: 0, reachDelayMin: 0, totalDelayMin: 0 };
    var h = map[k];
    h.trips++;
    h.handoverDelayMin += nn_(net ? r.hoDelayNetMin : r.hoDelayGrossMin);
    h.dispatchDelayMin += nn_(net ? r.dpDelayNetMin : r.dpDelayGrossMin);
    h.reachDelayMin    += nn_(net ? r.rcDelayNetMin : r.rcDelayGrossMin);
  });
  return Object.keys(map).map(function (k) {
    var h = map[k];
    h.totalDelayMin = h.handoverDelayMin + h.dispatchDelayMin + h.reachDelayMin;
    return h;
  }).sort(function (a, b) { return b.totalDelayMin - a.totalDelayMin; });
}

function nn_(v) { return (v === null || v === undefined) ? 0 : v; }


/* =====================================================================
 * 5. TIME ANCHORING HELPERS
 * ===================================================================== */

/** Lift an early-morning clock time onto the same operational night. */
function anchor_(min) {
  return (min < CONFIG.ROLLOVER_ANCHOR_HOUR * 60) ? min + 1440 : min;
}

/** Shift t by whole days so it lands within +/-12h of ref. */
function alignNear_(t, ref) {
  var x = t;
  while (x - ref > 720) x -= 1440;
  while (ref - x > 720) x += 1440;
  return x;
}

/**
 * Align t to be at/after ref. A small negative gap (within tol) is kept and
 * flagged as a sequence anomaly rather than being pushed a full day forward,
 * because a 3-minute inversion is a typo, not a midnight crossing.
 */
function alignForward_(t, ref, tol) {
  var x = alignNear_(t, ref);
  if (x < ref - tol) x += 1440;
  return x;
}

/* =====================================================================
 * 6. PARSERS
 * ===================================================================== */

function mapHeaders_(headers) {
  var map = {};
  var norm = headers.map(function (h) { return normaliseHeader_(h); });
  Object.keys(HEADER_ALIASES).forEach(function (field) {
    var aliases = HEADER_ALIASES[field].map(normaliseHeader_);
    for (var i = 0; i < norm.length; i++) {
      if (!norm[i]) continue;
      if (aliases.indexOf(norm[i]) > -1) { map[field] = i; return; }
    }
    // second pass: contains-match
    for (var j = 0; j < norm.length; j++) {
      if (!norm[j]) continue;
      for (var k = 0; k < aliases.length; k++) {
        if (norm[j].indexOf(aliases[k]) > -1) { map[field] = j; return; }
      }
    }
  });
  return map;
}

function normaliseHeader_(h) {
  return String(h == null ? '' : h)
    .toLowerCase()
    .replace(/[\n\r]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseHub_(raw) {
  if (raw === null || raw === undefined) return '';
  var s = String(raw).toLowerCase().trim()
    .replace(/[\u2010-\u2015]/g, '-')     // unicode dashes
    .replace(/\s*[-\/]\s*/g, '-')          // " - " and "/" -> "-"
    .replace(/[^a-z0-9\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (HUB_SLOT_SET_TIME[s] || HUB_TRANSIT_LIMIT_MIN[s]) return s;
  if (HUB_ALIASES[s]) return HUB_ALIASES[s];
  var noDash = s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (HUB_SLOT_SET_TIME[noDash] || HUB_TRANSIT_LIMIT_MIN[noDash]) return noDash;
  if (HUB_ALIASES[noDash]) return HUB_ALIASES[noDash];
  var dashed = s.replace(/\s+/g, '-');
  if (HUB_SLOT_SET_TIME[dashed] || HUB_TRANSIT_LIMIT_MIN[dashed]) return dashed;
  if (HUB_ALIASES[dashed]) return HUB_ALIASES[dashed];
  return s;   // unmapped — kept as-is and reported in the DQ panel
}

function titleCaseHub_(key) {
  return key.split(/([\- ])/).map(function (p) {
    if (p === '-' || p === ' ') return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join('');
}

function parseSlot_(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'number') return Math.round(raw);
  var m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : '';
}

var BLANK_TOKENS = ['', '-', '--', '---', 'n/a', 'na', 'null', 'nil', 'x', 'xx', 'tbd', 'no', 'none', '#n/a'];

function isBlankToken_(s) {
  return BLANK_TOKENS.indexOf(String(s == null ? '' : s).toLowerCase().trim()) > -1;
}

/**
 * Parse a time cell into minutes since 00:00 (0..1439), or null.
 * Handles: Date objects (incl. 1899-epoch time-only cells), decimal day
 * fractions, "HH:mm", "HH:mm:ss", "h:mm AM/PM", "23.05", "2305".
 */
function parseTimeCell_(rawVal, dispVal, tz) {
  // 1) Native Date object — format in the SPREADSHEET timezone
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    var s = Utilities.formatDate(rawVal, tz, 'HH:mm:ss');
    return hhmmssToMinutes_(s);
  }
  // 2) Numeric serial / day fraction
  if (typeof rawVal === 'number' && isFinite(rawVal)) {
    var frac = rawVal - Math.floor(rawVal);
    // Google Sheets stores midnight as numeric zero. A truly blank cell is an
    // empty string, not zero, so 00:00 must remain a valid time.
    if (rawVal === 0) {
      var midnight = parseTimeString_(dispVal);
      return midnight === null ? 0 : midnight;
    }
    var mins = Math.round(frac * 1440);
    if (mins >= 0 && mins < 1440 && frac > 0) return mins;
  }
  // 3) Text — try raw first, then the display value
  var cands = [rawVal, dispVal];
  for (var i = 0; i < cands.length; i++) {
    var t = parseTimeString_(cands[i]);
    if (t !== null) return t;
  }
  return null;
}

function parseTimeString_(val) {
  if (val === null || val === undefined) return null;
  var s = String(val).trim();
  if (isBlankToken_(s)) return null;

  s = s.toLowerCase().replace(/\s+/g, ' ');
  var ampm = null;
  var ap = s.match(/\b(am|pm)\b/);
  if (ap) { ampm = ap[1]; s = s.replace(/\b(am|pm)\b/, '').trim(); }

  // "HH:mm[:ss]" or "HH.mm[.ss]" or "HH mm"
  var m = s.match(/^(\d{1,2})\s*[:.\s]\s*(\d{1,2})(?:\s*[:.\s]\s*(\d{1,2}))?$/);
  if (m) {
    var h = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    if (isNaN(h) || isNaN(mi) || mi > 59) return null;
    if (ampm) {
      if (h === 12) h = (ampm === 'am') ? 0 : 12;
      else if (ampm === 'pm') h += 12;
    }
    if (h > 23) return null;
    return h * 60 + mi;
  }

  // "2305" / "935"
  var m2 = s.match(/^(\d{3,4})$/);
  if (m2) {
    var n = m2[1];
    var hh = parseInt(n.length === 3 ? n.substring(0, 1) : n.substring(0, 2), 10);
    var mm = parseInt(n.substring(n.length - 2), 10);
    if (hh <= 23 && mm <= 59) {
      if (ampm) {
        if (hh === 12) hh = (ampm === 'am') ? 0 : 12;
        else if (ampm === 'pm') hh += 12;
      }
      return hh * 60 + mm;
    }
  }
  return null;
}

function hhmmssToMinutes_(s) {
  var p = String(s).split(':');
  var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM_(min) {
  var m = ((min % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60), mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

function parseDateCell_(rawVal, dispVal, tz) {
  if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
    if (rawVal.getFullYear() > 1900) {
      return {
        iso: Utilities.formatDate(rawVal, tz, 'yyyy-MM-dd'),
        label: Utilities.formatDate(rawVal, tz, 'dd-MMM-yyyy')
      };
    }
  }
  var s = String(dispVal || rawVal || '').trim();
  if (isBlankToken_(s)) return null;

  var m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if (m) {
    var a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = parseInt(m[3], 10);
    var y, mo, da;
    if (m[1].length === 4) { y = a; mo = b; da = c; }
    else if (CONFIG.DATE_ORDER === 'DMY') { da = a; mo = b; y = c; }
    else { mo = a; da = b; y = c; }
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      var dt = new Date(y, mo - 1, da);
      return {
        iso: Utilities.formatDate(dt, tz, 'yyyy-MM-dd'),
        label: Utilities.formatDate(dt, tz, 'dd-MMM-yyyy')
      };
    }
  }
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1900) {
    return {
      iso: Utilities.formatDate(parsed, tz, 'yyyy-MM-dd'),
      label: Utilities.formatDate(parsed, tz, 'dd-MMM-yyyy')
    };
  }
  return null;
}

function toNumberOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? null : n;
}

function pick_(values, display, idx) {
  if (idx === undefined) return '';
  var v = values[idx];
  if (v === '' || v === null || v === undefined) return display[idx];
  return v;
}

function pickRaw_(values, idx) {
  return idx === undefined ? '' : values[idx];
}

function isRowBlank_(arr) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] !== '' && arr[i] !== null && arr[i] !== undefined) return false;
  }
  return true;
}

/* =====================================================================
 * 6B. DEPLOYMENT / SETUP HEALTH CHECK
 * ===================================================================== */

/**
 * Run this function once from the Apps Script editor after replacing files.
 * It returns a plain object in the execution log and does not modify the sheet.
 */
function testDashboardSetup() {
  var result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    spreadsheetFound: false,
    fmh: {},
    osd: {},
    overnightTests: []
  };

  try {
    var ss = SpreadsheetApp.getActive();
    if (!ss) throw new Error('No active spreadsheet is attached to this Apps Script project.');
    result.spreadsheetFound = true;
    result.spreadsheetName = ss.getName ? ss.getName() : '';
    result.timezone = ss.getSpreadsheetTimeZone() || 'Asia/Dhaka';

    var fmhSheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    result.fmh.sheetFound = !!fmhSheet;
    if (fmhSheet) {
      result.fmh.rows = Math.max(0, fmhSheet.getLastRow() - CONFIG.HEADER_ROW);
      result.fmh.columns = fmhSheet.getLastColumn();
    }

    var osdSheet = ss.getSheetByName(CONFIG.OSD_SHEET_NAME);
    result.osd.sheetFound = !!osdSheet;
    if (osdSheet) {
      result.osd.rows = Math.max(0, osdSheet.getLastRow() - CONFIG.OSD_HEADER_ROW);
      result.osd.columns = osdSheet.getLastColumn();
      if (osdSheet.getLastColumn() > 0) {
        var headerDisplay = osdSheet.getRange(CONFIG.OSD_HEADER_ROW, 1, 1, osdSheet.getLastColumn()).getDisplayValues()[0];
        var mapped = mapOsdHeaders_(headerDisplay);
        result.osd.detectedHeaders = headerDisplay;
        result.osd.mappedColumns = mapped;
        result.osd.missingRequired = ['date', 'sender', 'route', 'departure', 'target', 'arrival']
          .filter(function (k) { return mapped[k] === undefined; });
      }
    }

    [
      { departure: 20 * 60, target: 2 * 60 + 30, arrival: 23 * 60 + 30, expected: 'No Late' },
      { departure: 20 * 60, target: 2 * 60 + 30, arrival: 1 * 60 + 45, expected: 'No Late' },
      { departure: 20 * 60, target: 2 * 60 + 30, arrival: 2 * 60 + 30, expected: 'No Late' },
      { departure: 20 * 60, target: 2 * 60 + 30, arrival: 4 * 60, expected: 'Late' }
    ].forEach(function (t) {
      var actual = calculateOsdArrivalSla_(t.departure, t.target, t.arrival);
      result.overnightTests.push({ expected: t.expected, actual: actual.status, passed: actual.status === t.expected });
    });

    if (!result.fmh.sheetFound || !result.osd.sheetFound ||
        (result.osd.missingRequired && result.osd.missingRequired.length)) {
      result.ok = false;
    }
  } catch (err) {
    result.ok = false;
    result.error = err && err.message ? err.message : String(err);
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/* =====================================================================
 * 7. DATA QUALITY CHECK (menu utility)
 * ===================================================================== */

function runDataQualityCheck() {
  var p = getDashboardData(true);
  if (!p.ok) { SpreadsheetApp.getUi().alert('FMH DQ Check', p.error, SpreadsheetApp.getUi().ButtonSet.OK); return; }
  var d = p.dq;
  var lines = [
    'Source rows read      : ' + d.totalSourceRows,
    'Blank rows skipped    : ' + d.blankRowsSkipped,
    'Unparsed date cells   : ' + d.unparsedDate,
    'Unparsed handover     : ' + d.unparsedHandover,
    'Unparsed van left     : ' + d.unparsedLeft,
    'Unparsed van reach    : ' + d.unparsedReach,
    'Sequence anomalies    : ' + d.sequenceAnomalies,
    'Implausible travel    : ' + d.implausibleTravel,
    'Unmapped hub names    : ' + Object.keys(d.unmappedHubs).join(', '),
    'Missing slot set time : ' + Object.keys(d.missingSlotConfig).join(', '),
    'Duplicate Date/Hub/Slot keys : ' + Object.keys(d.duplicateKeys).length
  ];
  SpreadsheetApp.getUi().alert('FMH Data Quality Check', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}
