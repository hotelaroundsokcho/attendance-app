/**
 * 호텔어라운드 속초 - 메이드 출근확인 및 점심식사 확인 앱 백엔드
 * Google Apps Script (Web App)
 *
 * 시트 구성 (자동 생성됨):
 *  - maids      : 메이드 명단 및 인증 정보
 *  - attendance : 일별 출근/점심 기록 (영구 누적)
 *  - admins     : 관리자 계정
 *
 * [2026-07-11 정책 변경]
 *  - 출근을 점심 선택보다 우선한다 (점심 미선택이어도 출근 가능)
 *  - 점심은 13:00까지 메이드가 직접 선택/변경 가능
 *  - 13:00까지 무입력이면 자동으로 '안먹음(N)'으로 확정
 *  - 13:00 이후에는 메이드는 변경 불가, 관리자만 adminUpdateLunch로 수정 가능
 */

// ===================== 공통 상수 =====================

const SHEET_MAIDS = 'maids';
const SHEET_ATTENDANCE = 'attendance';
const SHEET_ADMINS = 'admins';

const TIMEZONE = 'Asia/Seoul';
const SESSION_TTL_SEC = 21600; // CacheService 최대치 6시간

const DEFAULT_MASTER_USERNAME = 'master';
const DEFAULT_MASTER_PASSWORD = 'master1234';

const LUNCH_DEADLINE_HOUR = 13; // 13:00 이후 메이드 직접 변경 불가 (관리자만 가능)
const LUNCH_AUTOLOCK_CACHE_TTL_SEC = 300; // 마감 자동처리 스윕 주기 (5분에 1회)

// ===================== 엔트리 포인트 =====================

function doPost(e) {
  var result;
  try {
    ensureSheetsExist();
    ensureMasterAdminExists();
    enforcePlainTextFormats();
    autoLockPastDueLunches();

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'EMPTY_REQUEST' });
    }

    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    switch (action) {
      // ---- 메이드 ----
      case 'getMaidList':
        result = handleGetMaidList();
        break;
      case 'registerMaid':
        result = handleRegisterMaid(body);
        break;
      case 'loginMaid':
        result = handleLoginMaid(body);
        break;
      case 'resetPin':
        result = handleResetPin(body);
        break;
      case 'checkStatusToday':
        result = handleCheckStatusToday(body);
        break;
      case 'checkIn':
        result = handleCheckIn(body);
        break;
      case 'updateLunch':
        result = handleUpdateLunch(body);
        break;

      // ---- 관리자 인증 ----
      case 'adminLogin':
        result = handleAdminLogin(body);
        break;
      case 'adminChangeOwnPassword':
        result = withAdminAuth(body, function (admin) {
          return handleAdminChangeOwnPassword(admin, body);
        });
        break;

      // ---- 관리자: 대시보드 ----
      case 'adminGetDashboard':
        result = withAdminAuth(body, function (admin) {
          return handleAdminGetDashboard();
        });
        break;

      // ---- 관리자: 점심 수정 (13:00 마감 이후에도 항상 허용) ----
      case 'adminUpdateLunch':
        result = withAdminAuth(body, function (admin) {
          return handleAdminUpdateLunch(body);
        });
        break;

      // ---- 관리자: 메이드 관리 ----
      case 'adminGetMaidList':
        result = withAdminAuth(body, function (admin) {
          return handleAdminGetMaidList();
        });
        break;
      case 'adminAddMaid':
        result = withAdminAuth(body, function (admin) {
          return handleAdminAddMaid(body);
        });
        break;
      case 'adminEditMaid':
        result = withAdminAuth(body, function (admin) {
          return handleAdminEditMaid(body);
        });
        break;
      case 'adminDeleteMaid':
        result = withAdminAuth(body, function (admin) {
          return handleAdminDeleteMaid(body);
        });
        break;
      case 'adminResetMaidPin':
        result = withAdminAuth(body, function (admin) {
          return handleAdminResetMaidPin(body);
        });
        break;

      // ---- 관리자: 관리자 계정 관리 (마스터 전용) ----
      case 'adminGetAdminList':
        result = withAdminAuth(body, function (admin) {
          return handleAdminGetAdminList();
        });
        break;
      case 'adminAddAdmin':
        result = withAdminAuth(body, function (admin) {
          return handleAdminAddAdmin(admin, body);
        });
        break;
      case 'adminDeleteAdmin':
        result = withAdminAuth(body, function (admin) {
          return handleAdminDeleteAdmin(admin, body);
        });
        break;
      case 'adminTransferMaster':
        result = withAdminAuth(body, function (admin) {
          return handleAdminTransferMaster(admin, body);
        });
        break;

      // ---- 관리자: 정산용 데이터 내보내기 ----
      case 'adminExportRange':
        result = withAdminAuth(body, function (admin) {
          return handleAdminExportRange(body);
        });
        break;

      default:
        result = { success: false, error: 'UNKNOWN_ACTION' };
    }
  } catch (err) {
    result = { success: false, error: 'SERVER_ERROR', message: String(err && err.message ? err.message : err) };
  }

  return jsonResponse(result);
}

function doGet(e) {
  return jsonResponse({ success: true, message: 'Hotel Around Sokcho 출근관리 API is running.' });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===================== 시트 초기화 =====================

function ensureSheetsExist() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(SHEET_MAIDS)) {
    var maidsSheet = ss.insertSheet(SHEET_MAIDS);
    maidsSheet.appendRow([
      'maidId', 'name', 'status', 'pinHash', 'pinSalt',
      'deviceTokenHash', 'registeredAt', 'createdAt', 'deletedAt'
    ]);
  }

  if (!ss.getSheetByName(SHEET_ATTENDANCE)) {
    var attSheet = ss.insertSheet(SHEET_ATTENDANCE);
    attSheet.appendRow([
      'recordId', 'date', 'maidId', 'maidName',
      'checkInTime', 'lunch', 'lunchUpdatedAt', 'createdAt'
    ]);
  }

  if (!ss.getSheetByName(SHEET_ADMINS)) {
    var adminSheet = ss.insertSheet(SHEET_ADMINS);
    adminSheet.appendRow([
      'adminId', 'username', 'passwordHash', 'passwordSalt', 'role', 'createdAt'
    ]);
  }

  // 기본 '시트1' 빈 탭이 남아있으면 정리(다른 탭이 최소 1개 이상 있을 때만)
  var blank = ss.getSheetByName('시트1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) {
    ss.deleteSheet(blank);
  }
}

function ensureMasterAdminExists() {
  var sheet = getSheet(SHEET_ADMINS);
  var data = sheet.getDataRange().getValues();
  var hasMaster = false;
  for (var i = 1; i < data.length; i++) {
    if (data[i][4] === 'master') { hasMaster = true; break; }
  }
  if (!hasMaster && data.length <= 1) {
    var salt = Utilities.getUuid();
    var hash = hashValue(DEFAULT_MASTER_PASSWORD, salt);
    sheet.appendRow([
      Utilities.getUuid(), DEFAULT_MASTER_USERNAME, hash, salt, 'master', nowIso()
    ]);
  }
}

// ===================== 유틸리티 =====================

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function nowIso() {
  return Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function todayKey() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

function nowTimeOnly() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'HH:mm:ss');
}

function hashValue(value, salt) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value) + '::' + String(salt)
  );
  return Utilities.base64Encode(digest);
}

function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = data[i][j];
    }
    obj.__row = i + 1; // 실제 시트 행 번호 (1-indexed, 헤더 포함)
    rows.push(obj);
  }
  return rows;
}

function findRowIndexById(sheet, idColName, idValue) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = headers.indexOf(idColName);
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === idValue) return i + 1; // 1-indexed
  }
  return -1;
}

function colIndex(sheet, colName) {
  var headers = sheet.getDataRange().getValues()[0];
  return headers.indexOf(colName) + 1; // getRange는 1-indexed
}

// ===================== 점심 13:00 마감 판정 유틸 =====================

// 지금 이 순간이 13:00을 지났는지 (Asia/Seoul 기준)
function isPastLunchDeadlineNow() {
  var hour = Number(Utilities.formatDate(new Date(), TIMEZONE, 'H'));
  return hour >= LUNCH_DEADLINE_HOUR;
}

// 특정 날짜(yyyy-MM-dd)의 점심 마감이 이미 지났는지
// - 오늘보다 이전 날짜: 무조건 마감 지남
// - 오늘 날짜: 현재 시각이 13:00을 지났는지로 판정
// - 오늘보다 이후 날짜: 있을 수 없는 값이지만 방어적으로 false 처리
function isLunchDeadlinePassedForDate(dateStr) {
  var today = todayKey();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return isPastLunchDeadlineNow();
}

// attendance 시트 전체를 훑어 마감이 지났는데도 점심이 미선택(빈값)인 행을
// 전부 '안먹음(N)'으로 자동 확정한다. 요청마다 매번 전체 스캔하면 비용이 크므로
// CacheService로 5분에 1회만 실행되도록 가드한다.
function autoLockPastDueLunches() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('lunch_autolock_guard')) return;
    cache.put('lunch_autolock_guard', '1', LUNCH_AUTOLOCK_CACHE_TTL_SEC);

    var today = todayKey();
    var sheet = getSheet(SHEET_ATTENDANCE);
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;

    var headers = data[0];
    var dateCol = headers.indexOf('date');
    var lunchCol = headers.indexOf('lunch');
    var lunchUpdatedCol = headers.indexOf('lunchUpdatedAt');
    var pastDeadlineToday = isPastLunchDeadlineNow();

    var rowsToFix = [];
    for (var i = 1; i < data.length; i++) {
      var rowDate = data[i][dateCol];
      var rowLunch = data[i][lunchCol];
      if (rowLunch === 'Y' || rowLunch === 'N') continue; // 이미 선택됨
      var deadlinePassed = (rowDate < today) || (rowDate === today && pastDeadlineToday);
      if (deadlinePassed) rowsToFix.push(i + 1); // 1-indexed 시트 행 번호
    }
    if (rowsToFix.length === 0) return;

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var nowFull = nowIso();
      for (var k = 0; k < rowsToFix.length; k++) {
        sheet.getRange(rowsToFix[k], lunchCol + 1).setValue('N');
        sheet.getRange(rowsToFix[k], lunchUpdatedCol + 1).setValue(nowFull);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    // 자동 처리 실패는 치명적이지 않음 - 다음 요청(또는 다음 5분 주기)에서 재시도
  }
}

// ===================== 관리자 인증 미들웨어 =====================

function withAdminAuth(body, fn) {
  var token = body.token;
  if (!token) return { success: false, error: 'NO_TOKEN' };

  var cache = CacheService.getScriptCache();
  var raw = cache.get('session_' + token);
  if (!raw) return { success: false, error: 'SESSION_EXPIRED' };

  var admin = JSON.parse(raw);
  return fn(admin);
}

// ===================== 메이드: 명단 조회 =====================

function handleGetMaidList() {
  var sheet = getSheet(SHEET_MAIDS);
  var rows = sheetToObjects(sheet);
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.status !== 'active') continue;
    list.push({
      maidId: r.maidId,
      name: r.name,
      hasPin: !!r.pinHash
    });
  }
  return { success: true, maids: list };
}

// ===================== 메이드: PIN 최초 등록 =====================

function handleRegisterMaid(body) {
  var maidId = body.maidId;
  var pin = body.pin;
  var deviceToken = body.deviceToken;

  if (!maidId || !pin || !deviceToken) {
    return { success: false, error: 'MISSING_FIELDS' };
  }
  if (!/^\d{4}$/.test(pin)) {
    return { success: false, error: 'INVALID_PIN_FORMAT' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet(SHEET_MAIDS);
    var rowIdx = findRowIndexById(sheet, 'maidId', maidId);
    if (rowIdx === -1) return { success: false, error: 'MAID_NOT_FOUND' };

    var row = sheet.getRange(rowIdx, 1, 1, sheet.getLastColumn()).getValues()[0];
    var headers = sheet.getDataRange().getValues()[0];
    var statusVal = row[headers.indexOf('status')];
    var existingPinHash = row[headers.indexOf('pinHash')];

    if (statusVal !== 'active') return { success: false, error: 'MAID_NOT_ACTIVE' };
    if (existingPinHash) return { success: false, error: 'ALREADY_REGISTERED' };

    var pinSalt = Utilities.getUuid();
    var pinHash = hashValue(pin, pinSalt);
    var deviceTokenHash = hashValue(deviceToken, maidId);

    sheet.getRange(rowIdx, colIndex(sheet, 'pinHash')).setValue(pinHash);
    sheet.getRange(rowIdx, colIndex(sheet, 'pinSalt')).setValue(pinSalt);
    sheet.getRange(rowIdx, colIndex(sheet, 'deviceTokenHash')).setValue(deviceTokenHash);
    sheet.getRange(rowIdx, colIndex(sheet, 'registeredAt')).setValue(nowIso());

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 메이드: 로그인 =====================

function handleLoginMaid(body) {
  var maidId = body.maidId;
  var pin = body.pin;
  if (!maidId || !pin) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_MAIDS);
  var rows = sheetToObjects(sheet);
  var maid = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].maidId === maidId) { maid = rows[i]; break; }
  }
  if (!maid) return { success: false, error: 'MAID_NOT_FOUND' };
  if (maid.status !== 'active') return { success: false, error: 'MAID_NOT_ACTIVE' };
  if (!maid.pinHash) return { success: false, error: 'NOT_REGISTERED' };

  var hash = hashValue(pin, maid.pinSalt);
  if (hash !== maid.pinHash) return { success: false, error: 'WRONG_PIN' };

  return { success: true, maidId: maid.maidId, name: maid.name };
}

// ===================== 메이드: PIN 재설정 (기기 바인딩) =====================

function handleResetPin(body) {
  var maidId = body.maidId;
  var deviceToken = body.deviceToken;
  var newPin = body.newPin;

  if (!maidId || !deviceToken || !newPin) return { success: false, error: 'MISSING_FIELDS' };
  if (!/^\d{4}$/.test(newPin)) return { success: false, error: 'INVALID_PIN_FORMAT' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet(SHEET_MAIDS);
    var rowIdx = findRowIndexById(sheet, 'maidId', maidId);
    if (rowIdx === -1) return { success: false, error: 'MAID_NOT_FOUND' };

    var headers = sheet.getDataRange().getValues()[0];
    var row = sheet.getRange(rowIdx, 1, 1, sheet.getLastColumn()).getValues()[0];
    var storedDeviceTokenHash = row[headers.indexOf('deviceTokenHash')];

    if (!storedDeviceTokenHash) return { success: false, error: 'NOT_REGISTERED' };

    var incomingHash = hashValue(deviceToken, maidId);
    if (incomingHash !== storedDeviceTokenHash) {
      return { success: false, error: 'DEVICE_MISMATCH' };
    }

    var newSalt = Utilities.getUuid();
    var newHash = hashValue(newPin, newSalt);
    sheet.getRange(rowIdx, colIndex(sheet, 'pinHash')).setValue(newHash);
    sheet.getRange(rowIdx, colIndex(sheet, 'pinSalt')).setValue(newSalt);

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 메이드: 당일 상태 조회 =====================

function handleCheckStatusToday(body) {
  var maidId = body.maidId;
  if (!maidId) return { success: false, error: 'MISSING_FIELDS' };

  var today = todayKey();
  var sheet = getSheet(SHEET_ATTENDANCE);
  var rows = sheetToObjects(sheet);

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.maidId === maidId && r.date === today) {
      return {
        success: true,
        checkedIn: true,
        checkInTime: r.checkInTime,
        lunch: r.lunch,
        lunchUpdatedAt: r.lunchUpdatedAt,
        lunchLocked: isPastLunchDeadlineNow()
      };
    }
  }
  return { success: true, checkedIn: false, lunchLocked: isPastLunchDeadlineNow() };
}

// ===================== 메이드: 출근 체크 (+ 점심 선택, 선택 사항) =====================

function handleCheckIn(body) {
  var maidId = body.maidId;
  // 정책 변경: 점심 선택은 더 이상 출근의 필수 조건이 아니다.
  // 유효하지 않은 값(빈 문자열 포함)은 '미선택'으로 간주한다.
  var lunch = (body.lunch === 'Y' || body.lunch === 'N') ? body.lunch : '';

  if (!maidId) {
    return { success: false, error: 'MISSING_FIELDS' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var today = todayKey();
    var attSheet = getSheet(SHEET_ATTENDANCE);
    var rows = sheetToObjects(attSheet);

    for (var i = 0; i < rows.length; i++) {
      if (rows[i].maidId === maidId && rows[i].date === today) {
        return { success: false, error: 'ALREADY_CHECKED_IN' };
      }
    }

    var maidSheet = getSheet(SHEET_MAIDS);
    var maidRows = sheetToObjects(maidSheet);
    var maid = null;
    for (var j = 0; j < maidRows.length; j++) {
      if (maidRows[j].maidId === maidId) { maid = maidRows[j]; break; }
    }
    if (!maid || maid.status !== 'active') return { success: false, error: 'MAID_NOT_ACTIVE' };

    var checkInTime = nowTimeOnly();
    var nowFull = nowIso();

    // 이미 13:00이 지난 시각에 출근하면서 점심을 선택하지 않았다면
    // 대기할 필요 없이 즉시 '안먹음'으로 확정한다.
    var finalLunch = lunch;
    var lunchUpdatedAt = lunch ? nowFull : '';
    if (!finalLunch && isPastLunchDeadlineNow()) {
      finalLunch = 'N';
      lunchUpdatedAt = nowFull;
    }

    attSheet.appendRow([
      Utilities.getUuid(), today, maidId, maid.name,
      checkInTime, finalLunch, lunchUpdatedAt, nowFull
    ]);

    return {
      success: true,
      checkInTime: checkInTime,
      lunch: finalLunch,
      lunchLocked: isPastLunchDeadlineNow()
    };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 메이드: 점심 선택 변경 (13:00까지만) =====================

function handleUpdateLunch(body) {
  var maidId = body.maidId;
  var lunch = body.lunch;

  if (!maidId || (lunch !== 'Y' && lunch !== 'N')) {
    return { success: false, error: 'MISSING_FIELDS' };
  }

  // 13:00 마감 이후에는 메이드 본인이 직접 변경 불가 - 관리자에게 문의해야 함
  if (isPastLunchDeadlineNow()) {
    return { success: false, error: 'LUNCH_LOCKED' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var today = todayKey();
    var sheet = getSheet(SHEET_ATTENDANCE);
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var dateCol = headers.indexOf('date');
    var maidCol = headers.indexOf('maidId');
    var lunchCol = headers.indexOf('lunch');
    var lunchUpdatedCol = headers.indexOf('lunchUpdatedAt');

    for (var i = 1; i < data.length; i++) {
      if (data[i][maidCol] === maidId && data[i][dateCol] === today) {
        var rowIdx = i + 1;
        var nowFull = nowIso();
        sheet.getRange(rowIdx, lunchCol + 1).setValue(lunch);
        sheet.getRange(rowIdx, lunchUpdatedCol + 1).setValue(nowFull);
        return { success: true, lunch: lunch, lunchUpdatedAt: nowFull };
      }
    }
    return { success: false, error: 'NOT_CHECKED_IN_TODAY' };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 관리자: 로그인 =====================

function handleAdminLogin(body) {
  var username = body.username;
  var password = body.password;
  if (!username || !password) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_ADMINS);
  var rows = sheetToObjects(sheet);
  var admin = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].username === username) { admin = rows[i]; break; }
  }
  if (!admin) return { success: false, error: 'ADMIN_NOT_FOUND' };

  var hash = hashValue(password, admin.passwordSalt);
  if (hash !== admin.passwordHash) return { success: false, error: 'WRONG_PASSWORD' };

  var token = Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put('session_' + token, JSON.stringify({
    adminId: admin.adminId, username: admin.username, role: admin.role
  }), SESSION_TTL_SEC);

  return { success: true, token: token, role: admin.role, username: admin.username };
}

function handleAdminChangeOwnPassword(admin, body) {
  var oldPassword = body.oldPassword;
  var newPassword = body.newPassword;
  if (!oldPassword || !newPassword) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_ADMINS);
  var rowIdx = findRowIndexById(sheet, 'adminId', admin.adminId);
  if (rowIdx === -1) return { success: false, error: 'ADMIN_NOT_FOUND' };

  var headers = sheet.getDataRange().getValues()[0];
  var row = sheet.getRange(rowIdx, 1, 1, sheet.getLastColumn()).getValues()[0];
  var currentHash = row[headers.indexOf('passwordHash')];
  var currentSalt = row[headers.indexOf('passwordSalt')];

  if (hashValue(oldPassword, currentSalt) !== currentHash) {
    return { success: false, error: 'WRONG_PASSWORD' };
  }

  var newSalt = Utilities.getUuid();
  var newHash = hashValue(newPassword, newSalt);
  sheet.getRange(rowIdx, colIndex(sheet, 'passwordHash')).setValue(newHash);
  sheet.getRange(rowIdx, colIndex(sheet, 'passwordSalt')).setValue(newSalt);

  return { success: true };
}

// ===================== 관리자: 대시보드 =====================

function handleAdminGetDashboard() {
  var today = todayKey();
  var maidRows = sheetToObjects(getSheet(SHEET_MAIDS)).filter(function (r) { return r.status === 'active'; });
  var attRows = sheetToObjects(getSheet(SHEET_ATTENDANCE)).filter(function (r) { return r.date === today; });

  var checkedInIds = {};
  var lunchYes = 0, lunchNo = 0, lastLunchUpdate = null;
  var checkedInList = [];

  attRows.forEach(function (r) {
    checkedInIds[r.maidId] = true;
    checkedInList.push({ maidId: r.maidId, name: r.maidName, checkInTime: r.checkInTime, lunch: r.lunch, lunchUpdatedAt: r.lunchUpdatedAt });
    if (r.lunch === 'Y') lunchYes++;
    if (r.lunch === 'N') lunchNo++;
    if (r.lunchUpdatedAt && (!lastLunchUpdate || r.lunchUpdatedAt > lastLunchUpdate)) {
      lastLunchUpdate = r.lunchUpdatedAt;
    }
  });

  var notCheckedIn = maidRows
    .filter(function (m) { return !checkedInIds[m.maidId]; })
    .map(function (m) { return { maidId: m.maidId, name: m.name }; });

  return {
    success: true,
    date: today,
    totalMaids: maidRows.length,
    checkedInCount: attRows.length,
    notCheckedInCount: notCheckedIn.length,
    lunchYes: lunchYes,
    lunchNo: lunchNo,
    lastLunchUpdate: lastLunchUpdate,
    checkedInList: checkedInList,
    notCheckedInList: notCheckedIn,
    lunchLocked: isPastLunchDeadlineNow()
  };
}

// ===================== 관리자: 점심 수정 (13:00 마감 이후에도 항상 허용) =====================

function handleAdminUpdateLunch(body) {
  var maidId = body.maidId;
  var lunch = body.lunch;
  var dateStr = body.date || todayKey(); // 미지정 시 오늘 기록 대상

  if (!maidId || (lunch !== 'Y' && lunch !== 'N')) {
    return { success: false, error: 'MISSING_FIELDS' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet(SHEET_ATTENDANCE);
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var maidCol = headers.indexOf('maidId');
    var dateCol = headers.indexOf('date');
    var lunchCol = headers.indexOf('lunch');
    var lunchUpdatedCol = headers.indexOf('lunchUpdatedAt');

    for (var i = 1; i < data.length; i++) {
      if (data[i][maidCol] === maidId && data[i][dateCol] === dateStr) {
        var rowIdx = i + 1;
        var nowFull = nowIso();
        sheet.getRange(rowIdx, lunchCol + 1).setValue(lunch);
        sheet.getRange(rowIdx, lunchUpdatedCol + 1).setValue(nowFull);
        return { success: true, lunch: lunch, lunchUpdatedAt: nowFull, maidId: maidId, date: dateStr };
      }
    }
    return { success: false, error: 'NOT_CHECKED_IN_TODAY' };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 관리자: 메이드 관리 =====================

function handleAdminGetMaidList() {
  var rows = sheetToObjects(getSheet(SHEET_MAIDS));
  var list = rows.map(function (r) {
    return {
      maidId: r.maidId,
      name: r.name,
      status: r.status,
      hasPin: !!r.pinHash,
      registeredAt: r.registeredAt,
      createdAt: r.createdAt,
      deletedAt: r.deletedAt
    };
  });
  return { success: true, maids: list };
}

function handleAdminAddMaid(body) {
  var name = body.name;
  if (!name || !String(name).trim()) return { success: false, error: 'MISSING_NAME' };

  var sheet = getSheet(SHEET_MAIDS);
  var maidId = Utilities.getUuid();
  sheet.appendRow([
    maidId, String(name).trim(), 'active', '', '', '', '', nowIso(), ''
  ]);
  return { success: true, maidId: maidId };
}

function handleAdminEditMaid(body) {
  var maidId = body.maidId;
  var newName = body.newName;
  if (!maidId || !newName || !String(newName).trim()) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_MAIDS);
  var rowIdx = findRowIndexById(sheet, 'maidId', maidId);
  if (rowIdx === -1) return { success: false, error: 'MAID_NOT_FOUND' };

  sheet.getRange(rowIdx, colIndex(sheet, 'name')).setValue(String(newName).trim());
  return { success: true };
}

function handleAdminDeleteMaid(body) {
  var maidId = body.maidId;
  if (!maidId) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_MAIDS);
  var rowIdx = findRowIndexById(sheet, 'maidId', maidId);
  if (rowIdx === -1) return { success: false, error: 'MAID_NOT_FOUND' };

  sheet.getRange(rowIdx, colIndex(sheet, 'status')).setValue('deleted');
  sheet.getRange(rowIdx, colIndex(sheet, 'deletedAt')).setValue(nowIso());
  // 과거 attendance 기록은 maidName 스냅샷으로 보존되어 있으므로 별도 처리 불필요
  return { success: true };
}

function handleAdminResetMaidPin(body) {
  var maidId = body.maidId;
  if (!maidId) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_MAIDS);
  var rowIdx = findRowIndexById(sheet, 'maidId', maidId);
  if (rowIdx === -1) return { success: false, error: 'MAID_NOT_FOUND' };

  sheet.getRange(rowIdx, colIndex(sheet, 'pinHash')).setValue('');
  sheet.getRange(rowIdx, colIndex(sheet, 'pinSalt')).setValue('');
  sheet.getRange(rowIdx, colIndex(sheet, 'deviceTokenHash')).setValue('');
  sheet.getRange(rowIdx, colIndex(sheet, 'registeredAt')).setValue('');

  return { success: true };
}

// ===================== 관리자: 관리자 계정 관리 (마스터 전용) =====================

function handleAdminGetAdminList() {
  var rows = sheetToObjects(getSheet(SHEET_ADMINS));
  var list = rows.map(function (r) {
    return { adminId: r.adminId, username: r.username, role: r.role, createdAt: r.createdAt };
  });
  return { success: true, admins: list };
}

function handleAdminAddAdmin(admin, body) {
  if (admin.role !== 'master') return { success: false, error: 'MASTER_ONLY' };

  var username = body.username;
  var password = body.password;
  if (!username || !password) return { success: false, error: 'MISSING_FIELDS' };

  var sheet = getSheet(SHEET_ADMINS);
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].username === username) return { success: false, error: 'USERNAME_TAKEN' };
  }

  var salt = Utilities.getUuid();
  var hash = hashValue(password, salt);
  sheet.appendRow([Utilities.getUuid(), username, hash, salt, 'admin', nowIso()]);

  return { success: true };
}

function handleAdminDeleteAdmin(admin, body) {
  if (admin.role !== 'master') return { success: false, error: 'MASTER_ONLY' };

  var targetAdminId = body.targetAdminId;
  if (!targetAdminId) return { success: false, error: 'MISSING_FIELDS' };
  if (targetAdminId === admin.adminId) return { success: false, error: 'CANNOT_DELETE_SELF' };

  var sheet = getSheet(SHEET_ADMINS);
  var rowIdx = findRowIndexById(sheet, 'adminId', targetAdminId);
  if (rowIdx === -1) return { success: false, error: 'ADMIN_NOT_FOUND' };

  var headers = sheet.getDataRange().getValues()[0];
  var row = sheet.getRange(rowIdx, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (row[headers.indexOf('role')] === 'master') {
    return { success: false, error: 'CANNOT_DELETE_MASTER' };
  }

  sheet.deleteRow(rowIdx);
  return { success: true };
}

function handleAdminTransferMaster(admin, body) {
  if (admin.role !== 'master') return { success: false, error: 'MASTER_ONLY' };

  var targetAdminId = body.targetAdminId;
  if (!targetAdminId) return { success: false, error: 'MISSING_FIELDS' };
  if (targetAdminId === admin.adminId) return { success: false, error: 'ALREADY_MASTER' };

  var sheet = getSheet(SHEET_ADMINS);
  var targetRowIdx = findRowIndexById(sheet, 'adminId', targetAdminId);
  if (targetRowIdx === -1) return { success: false, error: 'TARGET_NOT_FOUND' };

  var selfRowIdx = findRowIndexById(sheet, 'adminId', admin.adminId);
  if (selfRowIdx === -1) return { success: false, error: 'SELF_NOT_FOUND' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet.getRange(targetRowIdx, colIndex(sheet, 'role')).setValue('master');
    sheet.getRange(selfRowIdx, colIndex(sheet, 'role')).setValue('admin');
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ===================== 관리자: 정산용 데이터 내보내기 =====================

function handleAdminExportRange(body) {
  var startDate = body.startDate; // 'yyyy-MM-dd'
  var endDate = body.endDate;     // 'yyyy-MM-dd'
  if (!startDate || !endDate) return { success: false, error: 'MISSING_FIELDS' };

  var rows = sheetToObjects(getSheet(SHEET_ATTENDANCE));
  var filtered = rows.filter(function (r) {
    return r.date >= startDate && r.date <= endDate;
  }).map(function (r) {
    return {
      date: r.date,
      maidName: r.maidName,
      checkInTime: r.checkInTime,
      lunch: r.lunch === 'Y' ? '먹음' : '안먹음',
      lunchUpdatedAt: r.lunchUpdatedAt
    };
  });

  filtered.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.maidName < b.maidName ? -1 : 1;
  });

  return { success: true, rows: filtered };
}

// ==================== 데이터 무결성: 텍스트 형식 강제 ====================
// Google Sheets가 yyyy-MM-dd 등의 문자열을 Date로 자동 변환하면 getValues()
// 문자열 비교가 실패하므로, 세 시트 전체를 일반 텍스트(@) 형식으로 고정한다.
// CacheService 가드로 6시간에 1회만 실제 실행된다.
function enforcePlainTextFormats() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('fmt_enforced')) return;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    [SHEET_MAIDS, SHEET_ATTENDANCE, SHEET_ADMINS].forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (sh) sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    });
    cache.put('fmt_enforced', '1', 21600);
  } catch (err) {
    // 형식 지정 실패는 치명적이지 않음 - 다음 요청에서 재시도
  }
}
