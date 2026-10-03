(() => {
  'use strict';

  const TOKEN_KEY = 'sooqify_audit_dashboard_token';
  const $ = id => document.getElementById(id);
  const stateNames = {
    not_configured: 'غير مهيأ', disabled: 'متوقف', connecting: 'جارٍ الاتصال', qr: 'بانتظار مسح QR',
    connected: 'متصل', disconnected: 'منقطع', logged_out: 'يتطلب إعادة ربط',
    number_mismatch: 'رقم غير مطابق', error: 'تعذر الاتصال',
  };
  const eventNames = {
    delete_confirmation_created: 'إنشاء معاينة حذف',
    delete_confirmed_and_queued: 'تأكيد حذف وإضافته للطابور',
    local_record_backup_saved: 'حفظ نسخة السجل المحلي',
    delete_local_archive_record_completed: 'اكتمال حذف السجل المحلي',
    delete_local_archive_record_failed: 'فشل حذف السجل المحلي',
    delete_local_archive_record_retry: 'إعادة محاولة حذف السجل',
    restore_requested: 'طلب استرجاع',
    restore_local_archive_record_completed: 'اكتمال مزامنة الاسترجاع',
    restore_local_archive_record_failed: 'فشل مزامنة الاسترجاع',
    delete_cancelled: 'إلغاء طلب حذف',
  };
  let qrObjectUrl = '';
  let lastQrFetchAt = 0;
  let qrExpiresAt = 0;
  let pollBusy = false;

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token()}`);
    headers.set('Accept', options.raw ? '*/*' : 'application/json');
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body.error) message = body.error;
      } catch (_) {}
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return options.raw ? response : response.json();
  }

  function setNotice(message, isError = false) {
    const element = $('global-notice');
    element.textContent = String(message || '');
    element.hidden = !message;
    element.style.background = isError ? '#fff0ee' : '';
    element.style.color = isError ? '#a94743' : '';
  }

  function setStatusPill(element, text, mood) {
    element.textContent = text;
    element.className = `status-pill status-${mood}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('ar', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Aden',
    }).format(date);
  }

  function clearQr() {
    $('qr-image').hidden = true;
    $('qr-placeholder').hidden = false;
    $('qr-countdown').textContent = '';
    qrExpiresAt = 0;
    if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
    qrObjectUrl = '';
  }

  async function updateQr(state) {
    const expiresAt = state.state?.qr_expires_at ? new Date(state.state.qr_expires_at).getTime() : 0;
    const valid = Boolean(state.state?.qr_available && expiresAt > Date.now());
    qrExpiresAt = valid ? expiresAt : 0;
    if (!valid) {
      clearQr();
      $('qr-placeholder').querySelector('b').textContent = state.state?.connected ? 'الجهاز مرتبط بالفعل' : 'بانتظار رمز الربط';
      $('qr-placeholder').querySelector('small').textContent = state.state?.connected
        ? 'تأكد من الرقم المصرح به في أعلى بطاقة الاتصال.'
        : 'سيظهر الرمز هنا بعد بدء العامل.';
      return;
    }
    const secondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $('qr-countdown').textContent = `ينتهي خلال ${secondsLeft} ث`;
    if (Date.now() - lastQrFetchAt < 12_000 && qrObjectUrl) return;
    lastQrFetchAt = Date.now();
    try {
      const response = await api('/api/whatsapp/qr.svg', { raw: true });
      const blob = await response.blob();
      if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
      qrObjectUrl = URL.createObjectURL(blob);
      $('qr-image').src = qrObjectUrl;
      $('qr-image').hidden = false;
      $('qr-placeholder').hidden = true;
    } catch (_) {
      clearQr();
      $('qr-placeholder').querySelector('b').textContent = 'تعذر تحميل رمز QR';
      $('qr-placeholder').querySelector('small').textContent = 'تحقق من إعداد qrcode وتحديث الحالة.';
    }
  }

  function renderTombstones(items) {
    const tbody = $('tombstone-rows');
    tbody.replaceChildren();
    const valid = Array.isArray(items) ? items : [];
    $('tombstone-count').textContent = `${valid.length} نشط`;
    if (!valid.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'empty-cell';
      cell.textContent = 'لا توجد طلبات نشطة.';
      row.append(cell);
      tbody.append(row);
      return;
    }
    for (const item of valid.slice(0, 200)) {
      const row = document.createElement('tr');
      const id = document.createElement('td');
      id.textContent = String(item.local_id ?? '—');
      const backup = document.createElement('td');
      backup.textContent = String(item.backup_id ?? '—');
      backup.dir = 'ltr';
      const date = document.createElement('td');
      date.textContent = formatDate(item.created_at);
      const command = document.createElement('td');
      const code = document.createElement('code');
      code.className = 'restore-code';
      code.textContent = `RESTORE ${String(item.backup_id || '')}`;
      command.append(code);
      row.append(id, backup, date, command);
      tbody.append(row);
    }
  }

  function renderEvents(items) {
    const container = $('event-list');
    container.replaceChildren();
    const events = Array.isArray(items) ? items.slice(-30).reverse() : [];
    if (!events.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-cell';
      empty.textContent = 'لا توجد أحداث بعد.';
      container.append(empty);
      return;
    }
    for (const event of events) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const name = document.createElement('span');
      name.className = 'event-name';
      name.textContent = `${eventNames[event.event] || String(event.event || 'نشاط')} · Local ID ${event.local_id ?? '—'}`;
      const date = document.createElement('time');
      date.className = 'event-time';
      date.dateTime = String(event.at || '');
      date.textContent = formatDate(event.at);
      row.append(name, date);
      container.append(row);
    }
  }

  async function refreshState() {
    if (!token() || pollBusy) return;
    pollBusy = true;
    try {
      const response = await api('/api/whatsapp/state');
      $('token-gate').hidden = true;
      $('dashboard-content').hidden = false;
      setNotice('');
      const state = response.state || {};
      const stateName = stateNames[state.state] || state.state || 'غير معروف';
      $('wa-state').textContent = stateName;
      $('wa-number').textContent = response.primary_number
        ? `الرقم المصرّح به: +${response.primary_number}`
        : 'لم يُضبط WHATSAPP_PRIMARY_NUMBER بعد.';
      $('wa-updated').textContent = state.updated_at ? `تحديث ${formatDate(state.updated_at)}` : '—';
      $('wa-error').textContent = state.last_error || '';
      $('wa-error').hidden = !state.last_error;
      setStatusPill($('wa-indicator'), state.connected ? 'آمن ومتصل' : stateName, state.connected ? 'good' : (['error', 'number_mismatch', 'logged_out'].includes(state.state) ? 'bad' : 'warn'));
      if (!response.enabled) {
        setNotice('WhatsApp غير مفعّل. راجع WHATSAPP_ENABLED وWHATSAPP_PRIMARY_NUMBER في إعدادات الخدمة.', true);
      }

      const scan = response.latest_scan;
      if (scan) {
        $('scan-count').textContent = Number(scan.product_count || 0).toLocaleString('ar') + ' منتج';
        $('scan-meta').textContent = `لقطة قائمة مكتملة · ${formatDate(scan.captured_at)}`;
        $('scan-id').textContent = `Scan ID ${scan.scan_id || '—'}`;
        $('scan-pages').textContent = `${Number(scan.pages_scanned || 0).toLocaleString('ar')} صفحة`;
        setStatusPill($('scan-status'), 'مكتمل', 'good');
      } else {
        $('scan-count').textContent = 'لا توجد بيانات';
        $('scan-meta').textContent = 'شغّل الفحص من صفحة قائمة المنتجات في Sooqify.';
        $('scan-id').textContent = 'Scan ID —';
        $('scan-pages').textContent = '— صفحة';
        setStatusPill($('scan-status'), 'بانتظار الفحص', 'warn');
      }

      const queues = response.queues || {};
      $('queue-count').textContent = Number(queues.outbox_queued || 0).toLocaleString('ar');
      $('queue-delete').textContent = `${Number(queues.archive_jobs_queued || 0).toLocaleString('ar')} طلب أرشيف`;
      $('queue-tombstones').textContent = `${Number(queues.active_archive_tombstones || 0).toLocaleString('ar')} منع حذف نشط`;
      renderTombstones(queues.tombstones);
      renderEvents(response.last_archive_events);
      await updateQr(state);
    } catch (error) {
      if (error.status === 401 || error.status === 503) {
        sessionStorage.removeItem(TOKEN_KEY);
        $('dashboard-content').hidden = true;
        $('token-gate').hidden = false;
        $('gate-error').textContent = error.message === 'Unauthorized.' ? 'رمز الوصول غير صحيح؛ أعد إدخاله.' : error.message;
      } else {
        setNotice(`تعذر تحديث لوحة التحكم: ${error.message}`, true);
      }
    } finally {
      pollBusy = false;
    }
  }

  async function downloadReport(kind) {
    const routes = {
      csv: ['/api/reports/latest.csv', 'sooqify_audit.csv'],
      employees: ['/api/reports/latest.employees.csv', 'sooqify_audit_employees.csv'],
      xlsx: ['/api/reports/latest.xlsx', 'sooqify_audit.xlsx'],
    };
    const [path, fallbackName] = routes[kind] || routes.csv;
    const response = await api(path, { raw: true });
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  $('token-form').addEventListener('submit', async event => {
    event.preventDefault();
    const value = $('token-input').value.trim();
    $('gate-error').textContent = '';
    if (value.length < 20) {
      $('gate-error').textContent = 'أدخل الرمز الكامل المضبوط في Railway.';
      return;
    }
    sessionStorage.setItem(TOKEN_KEY, value);
    $('token-input').value = '';
    await refreshState();
  });

  $('lock-button').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    clearQr();
    $('dashboard-content').hidden = true;
    $('token-gate').hidden = false;
    $('gate-error').textContent = 'انتهت الجلسة وأُزيل الرمز من sessionStorage.';
  });
  $('refresh-button').addEventListener('click', () => refreshState());

  $('generate-report').addEventListener('click', async event => {
    const button = event.currentTarget;
    const result = $('report-result');
    button.disabled = true;
    button.textContent = 'جارٍ إنشاء التقرير…';
    result.hidden = true;
    try {
      const response = await api('/api/reports/generate', { method: 'POST', body: {} });
      result.className = 'report-result result-success';
      result.textContent = `اكتمل التقرير. ${response.report?.snapshot_product_count ?? 0} منتجاً · ${response.report?.employees?.length ?? 0} موظفاً. يمكنك تنزيل الملفات أدناه.`;
      result.hidden = false;
    } catch (error) {
      result.className = 'report-result result-error';
      result.textContent = error.message;
      result.hidden = false;
    } finally {
      button.disabled = false;
      button.innerHTML = '<span class="button-icon">✦</span> إنشاء تقرير الآن';
      await refreshState();
    }
  });

  document.querySelectorAll('[data-download]').forEach(button => {
    button.addEventListener('click', async event => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        await downloadReport(target.dataset.download);
      } catch (error) {
        setNotice(`تعذر تنزيل الملف: ${error.message}`, true);
      } finally {
        target.disabled = false;
      }
    });
  });

  if (token()) {
    $('token-gate').hidden = true;
    $('dashboard-content').hidden = false;
    refreshState();
  }
  window.setInterval(refreshState, 5000);
  window.setInterval(() => {
    if (!qrExpiresAt || $('qr-image').hidden) return;
    const secondsLeft = Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000));
    $('qr-countdown').textContent = secondsLeft ? `ينتهي خلال ${secondsLeft} ث` : 'انتهت صلاحية الرمز';
  }, 1000);
})();
