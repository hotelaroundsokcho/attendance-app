/* ============================================================
 * 호텔어라운드 속초 - 메이드 출근확인 및 점심식사 확인 앱
 * Hotel Around Sokcho - Maid Check-In & Lunch App
 * app.js  (독립 프론트엔드 / Apps Script 백엔드 연동)
 * 모든 사용자 문구 한영 병기 (Korean/English bilingual UI)
 * ============================================================ */

const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwXkuzb1Sl-YsVBiBQn6SNJ7yYEuSlldFsU5IiRBNHotlyC6c7ZKfU0ZftmRZN-EOc7/exec',
  DEVICE_TOKEN_KEY: 'attn_device_token',
  ADMIN_TOKEN_KEY: 'attn_admin_token',
  ADMIN_USER_KEY: 'attn_admin_user',
  ADMIN_ROLE_KEY: 'attn_admin_role',
  SLOW_MS: 1200
};

/* ---------------------------------------------------------
 * 0. 유틸: 기기 토큰, DOM 헬퍼, 토스트, 로딩 오버레이
 * --------------------------------------------------------- */
function getDeviceToken() {
  let t = localStorage.getItem(CONFIG.DEVICE_TOKEN_KEY);
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2)));
    localStorage.setItem(CONFIG.DEVICE_TOKEN_KEY, t);
  }
  return t;
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function showScreen(id) {
  $all('.screen').forEach(s => s.classList.remove('on'));
  const el = document.getElementById(id);
  if (el) el.classList.add('on');
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

let overlaySlowTimer = null;
let overlayDepth = 0;
function showOverlay(msg) {
  overlayDepth++;
  const ov = $('#overlay');
  $('.msg', ov).textContent = msg || '처리 중... Processing...';
  ov.classList.remove('slow');
  ov.classList.add('on');
  clearTimeout(overlaySlowTimer);
  overlaySlowTimer = setTimeout(() => ov.classList.add('slow'), CONFIG.SLOW_MS);
}
function hideOverlay() {
  overlayDepth = Math.max(0, overlayDepth - 1);
  if (overlayDepth === 0) {
    clearTimeout(overlaySlowTimer);
    $('#overlay').classList.remove('on', 'slow');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------
 * 1. 에러 코드 -> 사용자 메시지 매핑 (한영 병기)
 * --------------------------------------------------------- */
const ERR_MSG = {
  EMPTY_REQUEST: '요청이 비어 있습니다. 다시 시도해 주세요. / The request was empty. Please try again.',
  UNKNOWN_ACTION: '알 수 없는 요청입니다. / Unknown request.',
  SERVER_ERROR: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. / A server error occurred. Please try again shortly.',
  NO_TOKEN: '로그인이 필요합니다. / Please sign in.',
  SESSION_EXPIRED: '로그인이 만료되었습니다. 다시 로그인해 주세요. / Your session expired. Please sign in again.',
  MISSING_FIELDS: '필요한 정보가 빠졌습니다. 모두 입력해 주세요. / Some required information is missing. Please fill in everything.',
  INVALID_PIN_FORMAT: 'PIN은 숫자 4자리여야 합니다. / The PIN must be exactly 4 digits.',
  MAID_NOT_FOUND: '명단에서 이름을 찾을 수 없습니다. / Your name was not found in the list.',
  MAID_NOT_ACTIVE: '사용이 중지된 이름입니다. 관리자에게 문의해 주세요. / This name is deactivated. Please contact the manager.',
  ALREADY_REGISTERED: '이미 PIN이 등록되어 있습니다. PIN을 입력해 주세요. / A PIN is already registered. Please enter your PIN.',
  NOT_REGISTERED: '아직 PIN이 등록되지 않았습니다. 먼저 PIN을 만들어 주세요. / No PIN registered yet. Please create your PIN first.',
  WRONG_PIN: 'PIN이 올바르지 않습니다. / Incorrect PIN.',
  DEVICE_MISMATCH: '처음 등록한 폰이 아닙니다. 관리자에게 PIN 초기화를 요청해 주세요. / This is not your original phone. Please ask the manager to reset your PIN.',
  ALREADY_CHECKED_IN: '오늘은 이미 출근 처리되었습니다. / You have already checked in today.',
  NOT_CHECKED_IN_TODAY: '오늘 출근 기록이 없습니다. 먼저 출근해 주세요. / No check-in record today. Please check in first.',
  ADMIN_NOT_FOUND: '관리자 계정을 찾을 수 없습니다. / Manager account not found.',
  WRONG_PASSWORD: '비밀번호가 올바르지 않습니다. / Incorrect password.',
  MISSING_NAME: '이름을 입력해 주세요. / Please enter a name.',
  MASTER_ONLY: '마스터 관리자만 할 수 있는 작업입니다. / Only the master admin can do this.',
  USERNAME_TAKEN: '이미 사용 중인 아이디입니다. / This username is already in use.',
  CANNOT_DELETE_SELF: '자기 자신은 삭제할 수 없습니다. / You cannot delete your own account.',
  CANNOT_DELETE_MASTER: '마스터 계정은 삭제할 수 없습니다. / The master account cannot be deleted.',
  ALREADY_MASTER: '이미 마스터 권한을 가지고 있습니다. / This account is already the master.',
  TARGET_NOT_FOUND: '대상 계정을 찾을 수 없습니다. / Target account not found.',
  SELF_NOT_FOUND: '내 계정 정보를 찾을 수 없습니다. 다시 로그인해 주세요. / Your account was not found. Please sign in again.'
};
function errMsg(code) {
  return ERR_MSG[code] || ('오류가 발생했습니다 (' + code + '). / An error occurred (' + code + ').');
}

/* ---------------------------------------------------------
 * 2. API 래퍼 (Apps Script: text/plain POST로 preflight 회피)
 * --------------------------------------------------------- */
async function api(payload, opt) {
  opt = opt || {};
  if (!opt.silent) showOverlay(opt.msg);
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { success: false, error: 'NETWORK', _detail: String(e) };
  } finally {
    if (!opt.silent) hideOverlay();
  }
}
function apiFail(data) {
  if (!data) { toast('응답이 없습니다. / No response.'); return true; }
  if (data.success) return false;
  if (data.error === 'NETWORK') {
    toast('네트워크 연결을 확인해 주세요. / Please check your network connection.');
    return true;
  }
  toast(errMsg(data.error));
  return true;
}

/* ---------------------------------------------------------
 * 3. 메이드: 이름 선택
 * --------------------------------------------------------- */
let currentMaid = null;   // {maidId, name, hasPin}
let pinMode = null;       // 'register' | 'login' | 'reset'

async function loadNameGrid() {
  const data = await api({ action: 'getMaidList' }, { msg: '명단을 불러오는 중... Loading names...' });
  if (apiFail(data)) return;
  const grid = $('#name-grid');
  grid.innerHTML = '';
  const maids = data.maids || [];
  $('#name-empty').style.display = maids.length ? 'none' : 'block';
  maids.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = m.name;
    b.addEventListener('click', () => openPinScreen(m));
    grid.appendChild(b);
  });
  showScreen('scr-name');
}

/* ---------------------------------------------------------
 * 4. 메이드: PIN 등록 / 입력 / 재설정
 * --------------------------------------------------------- */
function setupPinBoxes() {
  ['#pin-box1', '#pin-box2'].forEach(boxSel => {
    const inputs = $all('input', $(boxSel));
    inputs.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
        if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
      });
    });
  });
}
function readPin(boxSel) {
  return $all('input', $(boxSel)).map(i => i.value).join('');
}
function clearPins() {
  $all('#pin-box1 input, #pin-box2 input').forEach(i => { i.value = ''; });
  $('#pin-err').textContent = '';
}
function focusFirstPin() {
  const first = $('#pin-box1 input');
  if (first) first.focus();
}

function openPinScreen(maid) {
  currentMaid = maid;
  pinMode = maid.hasPin ? 'login' : 'register';
  renderPinScreen();
  showScreen('scr-pin');
  focusFirstPin();
}

function renderPinScreen() {
  clearPins();
  const name = escapeHtml(currentMaid.name);
  if (pinMode === 'register') {
    $('#pin-title').innerHTML = name + '님, 처음 오셨네요!<span class="en">Welcome, ' + name + '!</span>';
    $('#pin-sub').innerHTML = '앞으로 사용할 비밀번호(PIN) 4자리를 만들어 주세요.<span class="en">Please create a 4-digit PIN to use from now on.</span>';
    $('#pin-confirm-wrap').style.display = 'block';
    $('#pin-reset-link').style.display = 'none';
  } else if (pinMode === 'login') {
    $('#pin-title').innerHTML = name + '님, 안녕하세요!<span class="en">Hello, ' + name + '!</span>';
    $('#pin-sub').innerHTML = '비밀번호(PIN) 4자리를 입력해 주세요.<span class="en">Please enter your 4-digit PIN.</span>';
    $('#pin-confirm-wrap').style.display = 'none';
    $('#pin-reset-link').style.display = 'block';
  } else { // reset
    $('#pin-title').innerHTML = 'PIN 다시 만들기<span class="en">Reset your PIN</span>';
    $('#pin-sub').innerHTML = '새로 사용할 PIN 4자리를 입력해 주세요. (처음 등록했던 폰에서만 가능)<span class="en">Enter a new 4-digit PIN. (Only possible on your original phone.)</span>';
    $('#pin-confirm-wrap').style.display = 'block';
    $('#pin-reset-link').style.display = 'none';
  }
}

async function submitPin() {
  const pin1 = readPin('#pin-box1');
  if (pin1.length !== 4) {
    $('#pin-err').textContent = '숫자 4자리를 모두 입력해 주세요. / Please enter all 4 digits.';
    return;
  }
  if (pinMode === 'register' || pinMode === 'reset') {
    const pin2 = readPin('#pin-box2');
    if (pin1 !== pin2) {
      $('#pin-err').textContent = '두 번 입력한 PIN이 서로 다릅니다. / The two PINs do not match.';
      return;
    }
  }
  $('#pin-err').textContent = '';

  if (pinMode === 'register') {
    const data = await api({
      action: 'registerMaid',
      maidId: currentMaid.maidId,
      pin: pin1,
      deviceToken: getDeviceToken()
    }, { msg: 'PIN 등록 중... Registering PIN...' });
    if (data.success) {
      toast('PIN이 등록되었습니다. / Your PIN has been registered.');
      currentMaid.hasPin = true;
      enterMain();
    } else if (data.error === 'ALREADY_REGISTERED') {
      toast(errMsg(data.error));
      pinMode = 'login'; renderPinScreen(); focusFirstPin();
    } else {
      apiFail(data); clearPins(); focusFirstPin();
    }
  } else if (pinMode === 'login') {
    const data = await api({
      action: 'loginMaid',
      maidId: currentMaid.maidId,
      pin: pin1
    }, { msg: '확인 중... Checking...' });
    if (data.success) {
      enterMain();
    } else if (data.error === 'NOT_REGISTERED') {
      toast(errMsg(data.error));
      pinMode = 'register'; renderPinScreen(); focusFirstPin();
    } else {
      apiFail(data); clearPins(); focusFirstPin();
    }
  } else { // reset
    const data = await api({
      action: 'resetPin',
      maidId: currentMaid.maidId,
      deviceToken: getDeviceToken(),
      newPin: pin1
    }, { msg: 'PIN 변경 중... Updating PIN...' });
    if (data.success) {
      toast('새 PIN이 저장되었습니다. / Your new PIN has been saved.');
      pinMode = 'login'; renderPinScreen(); focusFirstPin();
    } else {
      apiFail(data); clearPins(); focusFirstPin();
    }
  }
}

/* ---------------------------------------------------------
 * 5. 메이드: 메인 (출근 / 점심)
 * --------------------------------------------------------- */
let preLunch = null; // 출근 전 선택한 점심 값 'Y' | 'N'

function todayLabel() {
  const d = new Date();
  const ko = d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const en = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
  return ko + ' · ' + en;
}
function isLunchYes(v) { return v === 'Y' || v === '먹음' || v === '먹어요'; }
function isLunchNo(v) { return v === 'N' || v === '안먹음' || v === '안 먹어요'; }
function lunchLabel(v) {
  if (isLunchYes(v)) return '먹음/Yes';
  if (isLunchNo(v)) return '안먹음/No';
  return '-';
}

async function enterMain() {
  $('#main-name').textContent = currentMaid.name;
  $('#main-date').textContent = todayLabel();
  const data = await api({ action: 'checkStatusToday', maidId: currentMaid.maidId }, { msg: '오늘 기록 확인 중... Checking today...' });
  if (apiFail(data)) { showScreen('scr-name'); return; }
  if (data.checkedIn) {
    renderAfterCheckin(data.checkInTime, data.lunch, data.lunchUpdatedAt);
  } else {
    preLunch = null;
    paintLunchToggle('#lunch-pre', null);
    $('#before-checkin').style.display = 'block';
    $('#after-checkin').style.display = 'none';
  }
  showScreen('scr-main');
}

function paintLunchToggle(sel, v) {
  $all('button', $(sel)).forEach(b => {
    b.classList.remove('on-y', 'on-n');
    if (v && b.dataset.v === v) b.classList.add(v === 'Y' ? 'on-y' : 'on-n');
  });
}

function renderAfterCheckin(checkInTime, lunch, lunchUpdatedAt) {
  $('#before-checkin').style.display = 'none';
  $('#after-checkin').style.display = 'block';
  $('#done-time').textContent = checkInTime || '';
  const v = isLunchYes(lunch) ? 'Y' : (isLunchNo(lunch) ? 'N' : null);
  paintLunchToggle('#lunch-post', v);
  $('#lunch-updated').textContent = lunchUpdatedAt
    ? ('마지막 변경 Last change: ' + lunchUpdatedAt)
    : '';
}

async function doCheckIn() {
  if (!preLunch) {
    toast('점심을 먼저 선택해 주세요. / Please choose your lunch first.');
    return;
  }
  const data = await api({
    action: 'checkIn',
    maidId: currentMaid.maidId,
    lunch: preLunch
  }, { msg: '출근 처리 중... Checking in...' });
  if (data.success) {
    toast('출근이 완료되었습니다! / You are checked in!');
    renderAfterCheckin(data.checkInTime, data.lunch || preLunch, null);
  } else if (data.error === 'ALREADY_CHECKED_IN') {
    toast(errMsg(data.error));
    enterMain();
  } else {
    apiFail(data);
  }
}

async function changeLunch(v) {
  const data = await api({
    action: 'updateLunch',
    maidId: currentMaid.maidId,
    lunch: v
  }, { msg: '점심 변경 중... Updating lunch...' });
  if (data.success) {
    toast('점심 선택이 변경되었습니다. / Your lunch choice has been updated.');
    paintLunchToggle('#lunch-post', v);
    $('#lunch-updated').textContent = data.lunchUpdatedAt
      ? ('마지막 변경 Last change: ' + data.lunchUpdatedAt)
      : '';
  } else if (data.error === 'NOT_CHECKED_IN_TODAY') {
    toast(errMsg(data.error));
    enterMain();
  } else {
    apiFail(data);
  }
}

/* ---------------------------------------------------------
 * 6. 관리자: 로그인 / 세션
 * --------------------------------------------------------- */
function admToken() { return sessionStorage.getItem(CONFIG.ADMIN_TOKEN_KEY) || ''; }
function admUser() { return sessionStorage.getItem(CONFIG.ADMIN_USER_KEY) || ''; }
function admRole() { return sessionStorage.getItem(CONFIG.ADMIN_ROLE_KEY) || ''; }

function backToLoginOnExpire() {
  sessionStorage.removeItem(CONFIG.ADMIN_TOKEN_KEY);
  sessionStorage.removeItem(CONFIG.ADMIN_USER_KEY);
  sessionStorage.removeItem(CONFIG.ADMIN_ROLE_KEY);
  $('#whoami').textContent = '';
  toast(errMsg('SESSION_EXPIRED'));
  showScreen('scr-admin-login');
}
function handleAdminErr(data) {
  if (data && (data.error === 'NO_TOKEN' || data.error === 'SESSION_EXPIRED')) {
    backToLoginOnExpire();
    return true;
  }
  return false;
}
async function adminApi(payload, opt) {
  payload.token = admToken();
  const data = await api(payload, opt);
  if (handleAdminErr(data)) return null;
  return data;
}

async function adminLogin() {
  const username = $('#adm-id').value.trim();
  const password = $('#adm-pw').value;
  if (!username || !password) {
    toast('아이디와 비밀번호를 입력해 주세요. / Please enter your username and password.');
    return;
  }
  const data = await api({ action: 'adminLogin', username, password }, { msg: '로그인 중... Signing in...' });
  if (apiFail(data)) return;
  sessionStorage.setItem(CONFIG.ADMIN_TOKEN_KEY, data.token);
  sessionStorage.setItem(CONFIG.ADMIN_USER_KEY, data.username || username);
  sessionStorage.setItem(CONFIG.ADMIN_ROLE_KEY, data.role || '');
  $('#adm-pw').value = '';
  showAdmin();
}

function adminLogout() {
  sessionStorage.removeItem(CONFIG.ADMIN_TOKEN_KEY);
  sessionStorage.removeItem(CONFIG.ADMIN_USER_KEY);
  sessionStorage.removeItem(CONFIG.ADMIN_ROLE_KEY);
  $('#whoami').textContent = '';
  toast('로그아웃되었습니다. / Signed out.');
  loadNameGrid();
}

function showAdmin() {
  $('#whoami').textContent = admUser() + (admRole() === 'master' ? ' (master)' : '');
  switchTab('dash');
  showScreen('scr-admin');
  loadDash();
}

/* ---------------------------------------------------------
 * 7. 관리자: 탭 / 현황 대시보드
 * --------------------------------------------------------- */
function switchTab(name) {
  $all('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  ['dash', 'maids', 'admins', 'export'].forEach(t => {
    $('#tab-' + t).style.display = (t === name) ? 'block' : 'none';
  });
  if (name === 'dash') loadDash();
  if (name === 'maids') loadMaids();
  if (name === 'admins') loadAdmins();
  if (name === 'export') initExportDates();
}

async function loadDash() {
  const data = await adminApi({ action: 'adminGetDashboard' }, { msg: '현황 불러오는 중... Loading status...' });
  if (!data) return;
  if (apiFail(data)) return;
  $('#st-total').textContent = data.totalMaids != null ? data.totalMaids : '-';
  $('#st-in').textContent = data.checkedInCount != null ? data.checkedInCount : '-';
  $('#st-y').textContent = data.lunchYes != null ? data.lunchYes : '-';
  $('#st-n').textContent = data.lunchNo != null ? data.lunchNo : '-';

  const inBody = $('#tbl-in tbody');
  inBody.innerHTML = '';
  (data.checkedInList || []).forEach(r => {
    const tr = document.createElement('tr');
    const lv = r.lunch;
    const pill = isLunchYes(lv) ? '<span class="pill y">먹음/Yes</span>'
      : isLunchNo(lv) ? '<span class="pill n">안먹음/No</span>'
        : '<span class="pill gray">-</span>';
    tr.innerHTML = '<td>' + escapeHtml(r.name || r.maidName) + '</td>'
      + '<td>' + escapeHtml(r.checkInTime || '') + '</td>'
      + '<td>' + pill + '</td>'
      + '<td>' + escapeHtml(r.lunchUpdatedAt || '') + '</td>';
    inBody.appendChild(tr);
  });
  if (!(data.checkedInList || []).length) {
    inBody.innerHTML = '<tr><td colspan="4" class="notice">아직 출근한 메이드가 없습니다. / No one has checked in yet.</td></tr>';
  }

  const outBody = $('#tbl-out tbody');
  outBody.innerHTML = '';
  (data.notCheckedInList || []).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(r.name || r.maidName) + '</td>';
    outBody.appendChild(tr);
  });
  if (!(data.notCheckedInList || []).length) {
    outBody.innerHTML = '<tr><td class="notice">미출근 인원이 없습니다. / Everyone has checked in.</td></tr>';
  }
}

/* ---------------------------------------------------------
 * 8. 관리자: 메이드 관리
 * --------------------------------------------------------- */
async function loadMaids() {
  const data = await adminApi({ action: 'adminGetMaidList' }, { msg: '메이드 명단 불러오는 중... Loading maids...' });
  if (!data) return;
  if (apiFail(data)) return;
  const body = $('#tbl-maids tbody');
  body.innerHTML = '';
  (data.maids || []).forEach(m => {
    const active = m.status === 'active';
    const statusPill = active
      ? '<span class="pill y">활동중/Active</span>' + (m.hasPin ? '' : ' <span class="pill gray">PIN 미등록/No PIN</span>')
      : '<span class="pill gray">삭제됨/Removed</span>';
    const actions = active
      ? '<div class="row-actions">'
      + '<button class="btn small" data-act="rename" data-id="' + m.maidId + '" data-name="' + escapeHtml(m.name) + '">이름변경<span class="en">Rename</span></button>'
      + '<button class="btn small" data-act="pinreset" data-id="' + m.maidId + '" data-name="' + escapeHtml(m.name) + '">PIN초기화<span class="en">Reset PIN</span></button>'
      + '<button class="btn small danger" data-act="del" data-id="' + m.maidId + '" data-name="' + escapeHtml(m.name) + '">삭제<span class="en">Remove</span></button>'
      + '</div>'
      : '';
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(m.name) + '</td><td>' + statusPill + '</td><td>' + actions + '</td>';
    body.appendChild(tr);
  });
  if (!(data.maids || []).length) {
    body.innerHTML = '<tr><td colspan="3" class="notice">등록된 메이드가 없습니다. / No maids registered.</td></tr>';
  }
}

async function addMaid() {
  const name = $('#new-maid-name').value.trim();
  if (!name) { toast(errMsg('MISSING_NAME')); return; }
  const data = await adminApi({ action: 'adminAddMaid', name }, { msg: '추가 중... Adding...' });
  if (!data) return;
  if (apiFail(data)) return;
  $('#new-maid-name').value = '';
  toast('메이드가 추가되었습니다. / Maid added.');
  loadMaids();
}

async function maidRowAction(act, maidId, name) {
  if (act === 'rename') {
    const newName = prompt('새 이름을 입력해 주세요. / Enter the new name:', name);
    if (newName == null) return;
    const trimmed = newName.trim();
    if (!trimmed) { toast(errMsg('MISSING_NAME')); return; }
    const data = await adminApi({ action: 'adminEditMaid', maidId, newName: trimmed }, { msg: '이름 변경 중... Renaming...' });
    if (!data) return;
    if (apiFail(data)) return;
    toast('이름이 변경되었습니다. / Name updated.');
    loadMaids();
  } else if (act === 'pinreset') {
    if (!confirm('[' + name + '] PIN을 초기화할까요? 본인이 다시 등록해야 합니다.\nReset the PIN for [' + name + ']? They will need to register a new PIN.')) return;
    const data = await adminApi({ action: 'adminResetMaidPin', maidId }, { msg: 'PIN 초기화 중... Resetting PIN...' });
    if (!data) return;
    if (apiFail(data)) return;
    toast('PIN이 초기화되었습니다. / PIN has been reset.');
    loadMaids();
  } else if (act === 'del') {
    if (!confirm('[' + name + '] 메이드를 삭제할까요? 과거 출근기록은 이름 그대로 보존됩니다.\nRemove maid [' + name + ']? Past attendance records will be kept under this name.')) return;
    const data = await adminApi({ action: 'adminDeleteMaid', maidId }, { msg: '삭제 중... Removing...' });
    if (!data) return;
    if (apiFail(data)) return;
    toast('삭제되었습니다. / Removed.');
    loadMaids();
  }
}

/* ---------------------------------------------------------
 * 9. 관리자: 관리자 계정 관리 / 비밀번호 변경
 * --------------------------------------------------------- */
async function loadAdmins() {
  const data = await adminApi({ action: 'adminGetAdminList' }, { msg: '관리자 목록 불러오는 중... Loading admins...' });
  if (!data) return;
  if (apiFail(data)) return;
  const body = $('#tbl-admins tbody');
  body.innerHTML = '';
  const iAmMaster = admRole() === 'master';
  const me = admUser();
  (data.admins || []).forEach(a => {
    const rolePill = a.role === 'master'
      ? '<span class="pill y">마스터/Master</span>'
      : '<span class="pill gray">일반/Staff</span>';
    let actions = '<div class="row-actions">';
    if (iAmMaster && a.role !== 'master') {
      actions += '<button class="btn small" data-act="transfer" data-id="' + a.adminId + '" data-name="' + escapeHtml(a.username) + '">마스터위임<span class="en">Make master</span></button>';
      actions += '<button class="btn small danger" data-act="deladm" data-id="' + a.adminId + '" data-name="' + escapeHtml(a.username) + '">삭제<span class="en">Delete</span></button>';
    } else if (a.role !== 'master' && a.username !== me) {
      actions += '<button class="btn small danger" data-act="deladm" data-id="' + a.adminId + '" data-name="' + escapeHtml(a.username) + '">삭제<span class="en">Delete</span></button>';
    }
    actions += '</div>';
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(a.username) + '</td><td>' + rolePill + '</td><td>' + actions + '</td>';
    body.appendChild(tr);
  });
}

async function addAdmin() {
  const username = $('#new-adm-id').value.trim();
  const password = $('#new-adm-pw').value;
  if (!username || !password) {
    toast('아이디와 비밀번호를 입력해 주세요. / Please enter a username and password.');
    return;
  }
  const data = await adminApi({ action: 'adminAddAdmin', username, password }, { msg: '추가 중... Adding...' });
  if (!data) return;
  if (apiFail(data)) return;
  $('#new-adm-id').value = '';
  $('#new-adm-pw').value = '';
  toast('관리자가 추가되었습니다. / Admin added.');
  loadAdmins();
}

async function adminRowAction(act, targetAdminId, name) {
  if (act === 'deladm') {
    if (!confirm('[' + name + '] 관리자를 삭제할까요?\nDelete admin [' + name + ']?')) return;
    const data = await adminApi({ action: 'adminDeleteAdmin', targetAdminId }, { msg: '삭제 중... Deleting...' });
    if (!data) return;
    if (apiFail(data)) return;
    toast('삭제되었습니다. / Deleted.');
    loadAdmins();
  } else if (act === 'transfer') {
    if (!confirm('[' + name + '] 계정에 마스터 권한을 위임할까요? 내 권한은 일반 관리자로 바뀝니다.\nTransfer master role to [' + name + ']? Your role will become a regular admin.')) return;
    const data = await adminApi({ action: 'adminTransferMaster', targetAdminId }, { msg: '위임 중... Transferring...' });
    if (!data) return;
    if (apiFail(data)) return;
    sessionStorage.setItem(CONFIG.ADMIN_ROLE_KEY, 'admin');
    $('#whoami').textContent = admUser();
    toast('마스터 권한이 위임되었습니다. / Master role transferred.');
    loadAdmins();
  }
}

async function changeOwnPassword() {
  const oldPassword = $('#pw-old').value;
  const newPassword = $('#pw-new').value;
  if (!oldPassword || !newPassword) {
    toast('현재/새 비밀번호를 모두 입력해 주세요. / Please enter both current and new passwords.');
    return;
  }
  const data = await adminApi({ action: 'adminChangeOwnPassword', oldPassword, newPassword }, { msg: '비밀번호 변경 중... Changing password...' });
  if (!data) return;
  if (apiFail(data)) return;
  $('#pw-old').value = '';
  $('#pw-new').value = '';
  toast('비밀번호가 변경되었습니다. / Password changed.');
}

/* ---------------------------------------------------------
 * 10. 관리자: 정산 엑셀 다운로드 (SheetJS)
 * --------------------------------------------------------- */
function initExportDates() {
  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  if (!$('#exp-start').value) $('#exp-start').value = iso(first);
  if (!$('#exp-end').value) $('#exp-end').value = iso(today);
}

async function exportRange() {
  const startDate = $('#exp-start').value;
  const endDate = $('#exp-end').value;
  if (!startDate || !endDate) {
    toast('시작일과 종료일을 선택해 주세요. / Please choose both start and end dates.');
    return;
  }
  if (startDate > endDate) {
    toast('시작일이 종료일보다 늦을 수 없습니다. / The start date cannot be after the end date.');
    return;
  }
  const data = await adminApi({ action: 'adminExportRange', startDate, endDate }, { msg: '정산 데이터 불러오는 중... Loading export data...' });
  if (!data) return;
  if (apiFail(data)) return;
  const rows = data.rows || [];
  if (!rows.length) {
    toast('해당 기간에 기록이 없습니다. / No records in this period.');
    return;
  }
  if (typeof XLSX === 'undefined') {
    toast('엑셀 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요. / Excel module failed to load. Please refresh and try again.');
    return;
  }
  const aoa = [['날짜 Date', '이름 Name', '출근시각 Check-in', '점심 Lunch', '점심 변경시각 Lunch updated']];
  rows.forEach(r => {
    aoa.push([r.date || '', r.maidName || '', r.checkInTime || '', lunchLabel(r.lunch), r.lunchUpdatedAt || '']);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'attendance');
  XLSX.writeFile(wb, '출근기록_attendance_' + startDate + '_' + endDate + '.xlsx');
  toast('엑셀 파일이 다운로드되었습니다. / Excel file downloaded.');
}

/* ---------------------------------------------------------
 * 11. 이벤트 바인딩
 * --------------------------------------------------------- */
setupPinBoxes();

$('#pin-submit').addEventListener('click', submitPin);
$('#pin-reset-link').addEventListener('click', () => {
  pinMode = 'reset';
  renderPinScreen();
  focusFirstPin();
});
$('#pin-back').addEventListener('click', () => { currentMaid = null; loadNameGrid(); });

$all('#lunch-pre button').forEach(b => {
  b.addEventListener('click', () => {
    preLunch = b.dataset.v;
    paintLunchToggle('#lunch-pre', preLunch);
  });
});
$('#btn-checkin').addEventListener('click', doCheckIn);
$all('#lunch-post button').forEach(b => {
  b.addEventListener('click', () => changeLunch(b.dataset.v));
});
$('#main-logout').addEventListener('click', () => { currentMaid = null; loadNameGrid(); });

$('#goto-admin').addEventListener('click', async () => {
  if (admToken()) {
    showAdmin();
  } else {
    showScreen('scr-admin-login');
  }
});
$('#adm-login-btn').addEventListener('click', adminLogin);
$('#adm-pw').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
$('#adm-back').addEventListener('click', () => loadNameGrid());
$('#adm-logout').addEventListener('click', adminLogout);

$all('.tabs button').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});
$('#dash-refresh').addEventListener('click', loadDash);

$('#btn-add-maid').addEventListener('click', addMaid);
$('#new-maid-name').addEventListener('keydown', e => { if (e.key === 'Enter') addMaid(); });
$('#tbl-maids').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  maidRowAction(b.dataset.act, b.dataset.id, b.dataset.name);
});

$('#btn-add-admin').addEventListener('click', addAdmin);
$('#tbl-admins').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  adminRowAction(b.dataset.act, b.dataset.id, b.dataset.name);
});
$('#btn-pw-change').addEventListener('click', changeOwnPassword);

$('#btn-export').addEventListener('click', exportRange);

/* ---------------------------------------------------------
 * 12. 초기 진입
 * --------------------------------------------------------- */
loadNameGrid();
