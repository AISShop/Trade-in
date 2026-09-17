/****************************************************************
 * AIS Trade-in Dashboard — Backend (Google Apps Script)
 * หน้าที่:
 *   1) เป็นตัวกลาง (proxy) ซ่อน username/password และลิงก์ Sheet
 *      ไม่ให้โผล่ใน source code ของ dashboard
 *   2) ส่งอีเมลสรุปทุกเช้า 08:00 (By Area + By Location, รายวัน+สะสมเดือน)
 *
 * วิธีติดตั้งดูในไฟล์ INSTALL_APPS_SCRIPT.md
 ****************************************************************/

// ====== ตั้งค่าตรงนี้ ======
var CONFIG = {
  // รหัสเข้า dashboard (ซ่อนฝั่ง server — ไม่โผล่ใน HTML)
  USERS: {
    'tradein': 'iphone17'
  },

  // ชีตที่เก็บข้อมูล (เว้นว่างไว้ = ใช้ชีตที่ผูก script นี้)
  SHEET_ID: '1Ja1M_JHvjrI5ctZZ2CQZ3IG_IuGHscJm1TIBtPivivI',
  SHEET_NAME: 'การตอบแบบฟอร์ม 1',

  // อีเมลสรุปเช้า
  // ต้องการส่งแบบ "สำเนาลับ (BCC)" อย่างเดียว -> เว้น MAIL_TO ว่างได้
  // ระบบจะตั้ง To = อีเมลผู้ส่ง (เจ้าของ script) อัตโนมัติ แล้วผู้รับจริงอยู่ใน BCC
  MAIL_TO: '',                    // เว้นว่าง = ส่งหาตัวเอง (กัน error no recipient)
  MAIL_CC: '',                    // สำเนา (CC) — เว้นว่างได้
  MAIL_BCC: 'narongsr@ais.co.th, nutchana@ais.co.th', // สำเนาลับ (BCC) — ผู้รับจริง ใส่หลายคนคั่นด้วย ,
  MAIL_SUBJECT_PREFIX: '[External] Report Trade in AIS Shop',
  TARGET_ATR: 15,        // เป้า %ATR

  // ชื่อคอลัมน์ (ตรงกับหัวตารางใน Google Form)
  COL_DATE: 'ประทับเวลา',
  COL_LOCATION: 'สาขา',
  COL_STAFF: 'ชื่อ / (Staff,PC)',
  COL_TRADE: 'เสนอขาย Trade in ลูกค้าตอบรับหรือไม่'
};

// mapping ชื่อสาขา -> มาตรฐาน + Area (SU=ใต้ตอนบน, SL=ใต้ตอนล่าง ปรับได้)
// รองรับทั้งชื่อไทยเดิม (จาก Google Form) และชื่ออังกฤษใหม่ (จากระบบ LIFF)
var LOC_MAP = {
  // ---- ชื่อไทยเดิม (Google Form) ----
  'เซ็นทรัลหาดใหญ่': {name:'Shop Central Hat Yai', area:'SL'},
  'เซ็นทรัลนครศรีธรรมราช': {name:'Shop Central Nakhon Si Thammarat', area:'SU'},
  'เซ็นทรัลภูเก็ต': {name:'Shop Central Phuket Festival', area:'SU'},
  'ภูเก็ต ฟลอเรสต้า': {name:'Shop Central Phuket Floresta', area:'SU'},
  'เซ็นทรัลสมุย': {name:'Shop Central Samui', area:'SU'},
  'เซ็นทรัลสุราษฎร์ธานี': {name:'Shop Central Surat Thani', area:'SU'},
  'หาดใหญ่วิลเลจ': {name:'Shop Hatyai Village', area:'SL'},
  'เซเรเนด หาดใหญ่': {name:'Shop Serenade Club Central Festival Hat Yai', area:'SL'},

  // ---- ชื่ออังกฤษใหม่ (ระบบ LIFF ส่งมาตรงแล้ว -> map กลับตัวเอง + area) ----
  'Shop Central Phuket Festival': {name:'Shop Central Phuket Festival', area:'SU'},
  'Shop Central Phuket Floresta': {name:'Shop Central Phuket Floresta', area:'SU'},
  'Shop Central Surat Thani': {name:'Shop Central Surat Thani', area:'SU'},
  'Shop Central Samui': {name:'Shop Central Samui', area:'SU'},
  'Shop Central Nakhon Si Thammarat': {name:'Shop Central Nakhon Si Thammarat', area:'SU'},
  'Shop Central Hat Yai': {name:'Shop Central Hat Yai', area:'SL'},
  'Shop Serenade Club Central Festival Hat Yai': {name:'Shop Serenade Club Central Festival Hat Yai', area:'SL'},
  'Shop Hatyai Village': {name:'Shop Hatyai Village', area:'SL'},
  'Shop Robinson Trang': {name:'Shop Robinson Trang', area:'SL'}
};

// ====== Web App endpoint (dashboard เรียกผ่านตรงนี้) ======
// doGet — รองรับการเรียกแบบ GET (กัน CORS/preflight ของ POST ข้ามโดเมน)
// ใช้ ?action=login&user=..&pass=..  หรือ  ?action=data&token=..
function doGet(e) {
  var out = {ok:false};
  var p = (e && e.parameter) ? e.parameter : {};
  try {
    var action = p.action || 'login';
    if (action === 'login') {
      var u = String(p.user||'').trim();
      var pw = String(p.pass||'');
      if (CONFIG.USERS[u] !== undefined && CONFIG.USERS[u] === pw) {
        out.ok = true;
        out.token = Utilities.base64Encode(u + ':' + Date.now());
        out.rows = getRows();
      } else { out.error = 'invalid'; }
    } else if (action === 'data') {
      if (p.token) { out.ok = true; out.rows = getRows(); }
      else out.error = 'no token';
    } else if (action === 'ping') {
      out.ok = true; out.msg = 'AIS Trade-in backend OK';
    }
  } catch (err) { out.error = String(err); }

  var json = JSON.stringify(out);
  // JSONP: ถ้ามี ?callback=xxx ห่อด้วยชื่อฟังก์ชัน (เลี่ยง CORS)
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out = {ok:false};
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var action = body.action || 'login';

    if (action === 'login') {
      var u = String(body.user||'').trim();
      var p = String(body.pass||'');
      if (CONFIG.USERS[u] !== undefined && CONFIG.USERS[u] === p) {
        out.ok = true;
        out.token = Utilities.base64Encode(u + ':' + Date.now());
        out.rows = getRows();   // ส่งข้อมูลกลับเลยหลัง login ผ่าน
      } else {
        out.error = 'invalid';
      }
    } else if (action === 'data') {
      // ต้องมี token (เบื้องต้นแค่เช็คว่า decode ได้)
      if (body.token) { out.ok = true; out.rows = getRows(); }
      else out.error = 'no token';
    }
  } catch (err) {
    out.error = String(err);
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// อ่านข้อมูลจาก Sheet -> array of objects
function getRows() {
  var ss = CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
                           : SpreadsheetApp.getActiveSpreadsheet();
  var sh = CONFIG.SHEET_NAME ? ss.getSheetByName(CONFIG.SHEET_NAME) : ss.getSheets()[0];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var o = {};
    for (var c = 0; c < head.length; c++) o[head[c]] = values[i][c];
    rows.push(o);
  }
  return rows;
}

// ====== สร้างสรุปและส่งเมล (ตั้ง trigger เรียก sendDailyMail ทุกเช้า 08:00) ======
function isAccept(v) {
  var s = String(v||'').toLowerCase();
  if (/ไม่รับ|ไม่ตอบรับ|no|reject|ปฏิเสธ/.test(s)) return false;
  return /รับ|ตอบรับ|yes|accept|✓/.test(s);
}
function parseThaiDate(v) {
  if (v instanceof Date) return v;
  var s = String(v||'').trim();
  var iso = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (iso) { var y=+iso[1]; if(y>2500)y-=543; return new Date(y, +iso[2]-1, +iso[3]); }
  var dm = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dm) { var yy=+dm[3]; if(yy<100)yy+=2000; if(yy>2500)yy-=543; return new Date(yy, +dm[2]-1, +dm[1]); }
  var d = new Date(s); return isNaN(d) ? null : d;
}
function mapLoc(raw) {
  var k = String(raw||'').replace(/\s+/g,'').trim();
  for (var key in LOC_MAP) if (key.replace(/\s+/g,'') === k) return LOC_MAP[key];
  // partial
  for (var key2 in LOC_MAP) { var kk=key2.replace(/\s+/g,''); if (k && (k.indexOf(kk)>=0||kk.indexOf(k)>=0)) return LOC_MAP[key2]; }
  return {name: raw||'-', area:'-'};
}

// auto-detect ชื่อคอลัมน์จากคีย์เวิร์ด (กันชื่อไม่ตรงเป๊ะ/เว้นวรรค)
function pickCol(keys, cands){
  for (var i=0;i<keys.length;i++){
    var lk=String(keys[i]).toLowerCase();
    for (var j=0;j<cands.length;j++) if(lk.indexOf(cands[j])>=0) return keys[i];
  }
  return null;
}
function detectCols(rows){
  if(!rows.length) return {};
  var keys=Object.keys(rows[0]);
  // staff: เลือกคอลัมน์ "ชื่อพนักงาน" ให้เจาะจง — กันไปชนคอลัมน์ "Staff Type (AIS or PC)"
  // ใช้ keyword ที่อยู่เฉพาะคอลัมน์ชื่อ: 'staff_name','user name','ชื่อ' ก่อน
  // ถ้าไม่เจอค่อย fallback ไป keyword กว้าง แต่ "ยกเว้น" คอลัมน์ที่มีคำว่า 'type'
  var staffCol = pickColExclude(keys,
                   ['staff_name','staffname','user name','username','ชื่อ','พนักงาน'],
                   ['type']) ||
                 pickColExclude(keys, ['staff','pc','name','sale'], ['type']);
  return {
    date:  pickCol(keys,['ประทับเวลา','timestamp','date','วันที่','เวลา']) || keys[0],
    loc:   pickCol(keys,['สาขา','location','branch','ร้าน']),
    staff: staffCol,
    trade: pickCol(keys,['ตอบรับหรือไม่','trade in','trade-in','tradein','เสนอขาย trade'])
  };
}
// เหมือน pickCol แต่ข้ามคอลัมน์ที่มี keyword ใน excludes (เช่น 'type')
function pickColExclude(keys, cands, excludes){
  for (var i=0;i<keys.length;i++){
    var lk=String(keys[i]).toLowerCase();
    var skip=false;
    for (var e=0;e<excludes.length;e++){ if(lk.indexOf(excludes[e])>=0){ skip=true; break; } }
    if(skip) continue;
    for (var j=0;j<cands.length;j++) if(lk.indexOf(cands[j])>=0) return keys[i];
  }
  return null;
}

function sendDailyMail() {
  var rows = getRows();
  var tz = Session.getScriptTimeZone();
  var COLS = detectCols(rows);

  // ส่งเช้านี้ -> สรุปข้อมูล "เมื่อวาน" (Day-1) เพราะวันนี้ยังไม่มีคนกรอก
  var base = new Date();
  base.setDate(base.getDate() - 1);
  var yKey = Utilities.formatDate(base, tz, 'yyyy-MM-dd');   // เมื่อวาน
  var mPrefix = Utilities.formatDate(base, tz, 'yyyy-MM');   // เดือนของเมื่อวาน

  // aggregate
  var area = {};
  var AREA_NAME = 'AIS Shop Area South';
  var loc = {};
  area[AREA_NAME] = {dayT:0,dayA:0,monT:0,monA:0};
  rows.forEach(function(r){
    var d = parseThaiDate(r[COLS.date]); if(!d) return;
    var dk = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    var mk = Utilities.formatDate(d, tz, 'yyyy-MM');
    var inMonth = (mk === mPrefix);
    var isDay = (dk === yKey);   // = เมื่อวาน
    if (!inMonth) return;
    var acc = isAccept(r[COLS.trade]);
    var m = mapLoc(r[COLS.loc]);
    loc[m.name]  = loc[m.name]  || {dayT:0,dayA:0,monT:0,monA:0};
    area[AREA_NAME].monT++; if(acc)area[AREA_NAME].monA++;
    loc[m.name].monT++;  if(acc)loc[m.name].monA++;
    if (isDay){ area[AREA_NAME].dayT++; if(acc)area[AREA_NAME].dayA++; loc[m.name].dayT++; if(acc)loc[m.name].dayA++; }
  });

  var today = base; // ใช้วันที่ของข้อมูล (เมื่อวาน) ในหัวเมล

  var html = buildMailHtml(area, loc, today, tz);
  // subject: [External] Report Trade in AIS Shop mmddyy
  var subj = CONFIG.MAIL_SUBJECT_PREFIX + ' ' + Utilities.formatDate(today, tz, 'dd/MM/yyyy');

  // ต้องมี To อย่างน้อย 1 คนเสมอ — ถ้าเว้นว่าง ใช้อีเมลผู้ส่ง (เจ้าของ script)
  var toAddr = (CONFIG.MAIL_TO && CONFIG.MAIL_TO.trim())
      ? CONFIG.MAIL_TO
      : Session.getActiveUser().getEmail();

  var mailOpts = { to: toAddr, subject: subj, htmlBody: html };
  if (CONFIG.MAIL_CC && CONFIG.MAIL_CC.trim())  mailOpts.cc  = CONFIG.MAIL_CC;
  if (CONFIG.MAIL_BCC && CONFIG.MAIL_BCC.trim()) mailOpts.bcc = CONFIG.MAIL_BCC;
  MailApp.sendEmail(mailOpts);
}

function pct(a,t){ return t ? (100*a/t) : 0; }
function pctTxt(a,t){ return t ? (100*a/t).toFixed(1)+'%' : '-'; }
function badge(p){ var ok = p>=CONFIG.TARGET_ATR; return '<span style="color:'+(ok?'#0A5C36':'#c0392b')+';font-weight:bold">'+p.toFixed(1)+'%</span>'; }

function buildMailHtml(area, loc, today, tz) {
  var dateStr = Utilities.formatDate(today, tz, 'dd/MM/yyyy');
  var green='#0A5C36', lime='#8DC63F';
  var h = '';
  h += '<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden">';
  h += '<div style="background:'+green+';color:#fff;padding:18px 22px"><div style="font-size:20px;font-weight:bold">AIS Trade-in — Daily Report</div><div style="color:'+lime+';font-size:13px;margin-top:3px">Area South · '+dateStr+' · Target '+CONFIG.TARGET_ATR+'%</div></div>';
  h += '<div style="padding:20px 22px">';

  // Summary — Area South (combined)
  h += '<div style="font-size:16px;font-weight:bold;color:'+green+';border-left:4px solid '+lime+';padding-left:8px;margin-bottom:10px">Summary — AIS Shop Area South</div>';
  h += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">';
  h += '<tr style="color:#777;text-align:left"><th style="padding:6px;border-bottom:2px solid #eee">Area</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">Day %ATR</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">(Acc/Total)</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">MTD %ATR</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">(Acc/Total)</th></tr>';
  Object.keys(area).forEach(function(k){
    var a=area[k];
    h += '<tr><td style="padding:6px;border-bottom:1px solid #f0f0f0;font-weight:bold">'+k+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right">'+badge(pct(a.dayA,a.dayT))+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;color:#999">'+a.dayA+'/'+a.dayT+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right">'+badge(pct(a.monA,a.monT))+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;color:#999">'+a.monA+'/'+a.monT+'</td></tr>';
  });
  h += '</table>';

  // By Location
  h += '<div style="font-size:16px;font-weight:bold;color:'+green+';border-left:4px solid '+lime+';padding-left:8px;margin-bottom:10px">By Location</div>';
  h += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  h += '<tr style="color:#777;text-align:left"><th style="padding:6px;border-bottom:2px solid #eee">Location</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">Day %ATR</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">(Acc/Total)</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">MTD %ATR</th><th style="padding:6px;border-bottom:2px solid #eee;text-align:right">(Acc/Total)</th></tr>';
  // sort by MTD %ATR desc
  var locArr = Object.keys(loc).map(function(n){ return {name:n, v:loc[n]}; })
    .sort(function(x,y){ return pct(y.v.monA,y.v.monT)-pct(x.v.monA,x.v.monT); });
  locArr.forEach(function(it){
    var a=it.v;
    h += '<tr><td style="padding:6px;border-bottom:1px solid #f0f0f0">'+it.name+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right">'+(a.dayT?badge(pct(a.dayA,a.dayT)):'<span style="color:#c0392b">No data</span>')+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;color:#999">'+a.dayA+'/'+a.dayT+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right">'+badge(pct(a.monA,a.monT))+'</td>'
       + '<td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;color:#999">'+a.monA+'/'+a.monT+'</td></tr>';
  });
  h += '</table>';

  h += '<div style="margin-top:18px;color:#999;font-size:11px">Automated email from AIS Trade-in Dashboard · Sent daily at 08:00</div>';
  h += '</div></div>';
  return h;
}

// เรียกครั้งเดียวเพื่อสร้าง trigger ส่งเมลทุกเช้า 08:00
function setupDailyTrigger() {
  // ลบ trigger เดิมของฟังก์ชันนี้ก่อน กันซ้ำ
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'sendDailyMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyMail').timeBased().everyDays(1).atHour(8).create();
}
