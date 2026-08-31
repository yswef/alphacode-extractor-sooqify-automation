# Progress Tracker

| Phase | الحالة | تاريخ الإنجاز | ملاحظات |
|-------|--------|----------------|----------|
| 0 - Inventory & Analysis | ✅ مكتملة | 2026-08-27 | جرد كامل بدون تعديل كود. التقرير: `docs/reports/00_inventory.md`. تسع نقاط حُسمت من المستخدم — لا تنتقل لـ Phase 1 إلا بعد مراجعته للملف. |
| 1 - Setup Structure | ✅ مكتملة | 2026-08-27 | هيكل `app/` فارغ + نقل config/state. التقرير: `docs/reports/01_phase1.md`. |
| 2 - Config & State Layer | ✅ مكتملة | 2026-08-27 | JSON config/state عبر `core/config.py` + repositories. التقرير: `docs/reports/02_phase2.md`. |
| 3 - Extract Services | ✅ مكتملة | 2026-08-27 | `services/*` كانت منقولة مسبقاً لكن أجسامها بقيت مكررة بـ `app.py` (Shadowing) — تم حذف التكرار فعلياً + إصلاح NameError في `watch_variant_extractor`. التقرير: `docs/reports/03_phase3.md`. |
| 4 - Extract Repositories | ✅ مكتملة | 2026-08-29 | `archive_repository.py` (مسار متغيّر كمعامل) + `sync_config_repository.py` جديدان. التقرير: `docs/reports/04_repositories.md`. |
| 5 - API/Routes Layer | ✅ مكتملة فعلياً | **2026-08-31** | ⚠️ كانت مُعلَّمة مكتملة سابقاً بدون تنفيذ فعلي. تم الإكمال الحقيقي اليوم: (1) إصلاح `core_routes.py` وتسجيل `core_bp` في `main.py`، (2) تشغيل `app/main.py` فعلياً واختبار 7 endpoints حرجة بنجاح، (3) حذف كل الـ 38 `@app.route` من `app.py` (من 3142 سطر إلى 530). التقرير: `docs/reports/05_api_layer.md`. |
| 6 - Watchers/Background Jobs | ✅ مكتملة | 2026-08-30 | حذف `watch_variant_extractor.py` القديم + مجلد `watchers/` بالكامل. التقرير: `docs/reports/06_watchers.md`. |
| 7 - Tests & Cleanup | ✅ مكتملة | 2026-08-30 | تحديث `requirements.txt`، اختبارات الدخان، `CHANGELOG.md` شامل. ملاحظة: كان يفترض أن app.py محذوف — تم الحذف الفعلي في Phase 5 (2026-08-31). التقرير: `docs/reports/07_final_cleanup.md`. |

---

## قرارات المستخدم المثبتة (Phase 0)

1. `/api/dry-run` و brands fallback: محتمل أنهما كود ميت — لا يُنقلان حتى التحقق اليدوي.
2. `reports_config.json`: بقايا قديمة — يُحذف لاحقاً (ليس في Phase 0).
3. استيراد التقارير: السلوك المقصود هو try/except الاختياري.
4. `sync_background_worker`: تصميم المزامنة = مرة عند الإقلاع فقط. الحلقة الدورية كود ميت.
5. كاش AI: يُتجاهل في الهجرة (ميت).
6. سعر الساعة المعتمد: صيغة `/api/extract` (يوان × سعر الصرف).
7. `admin`/`admin` عند تعطيل المزامنة: للديف فقط — يُبقى كما هو.
8. Phase 6: لا watcher؛ النقل إلى `variant_extractor_service.py`.
9. `require_root_dir`: الاعتماد على الفحص اليدوي داخل `/api/extract` فقط.

---

## نقطة التشغيل النهائية (بعد Phase 5 المكتملة فعلياً)

```bash
cd backend
python -m app.main
```

**⛔ لا تستخدم:** `python app.py` — الملف القديم يُخرج رسالة خطأ واضحة ويخرج بكود 1.

---

## حالة الكود النهائية (2026-08-31)

| ملف | الحالة |
|-----|--------|
| `backend/app.py` | Stub فارغ من routes (530 سطر، بدون @app.route) |
| `backend/app/main.py` | ✅ create_app() يسجّل 4 Blueprints |
| `backend/app/api/routes/core_routes.py` | ✅ 5 routes (health, paths, brands) |
| `backend/app/api/routes/sync_routes.py` | ✅ 9 routes (sync/*) |
| `backend/app/api/routes/reports_routes.py` | ✅ 10 routes (reports, data-repair, logs) |
| `backend/app/api/routes/upload_routes.py` | ✅ 14 routes (extract, ai, archive, pending, images) |
| `backend/app/core/runtime.py` | ✅ RuntimePaths / paths_state |
| `backend/app/services/*` | ✅ ai_helpers, upload_service, sync_service, variant_extractor_service, report_service |
| `backend/app/repositories/*` | ✅ archive, paths, sync_config, sync_queue, sync_state |
