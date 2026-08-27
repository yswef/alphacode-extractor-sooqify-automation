# Progress Tracker

| Phase | الحالة | تاريخ الإنجاز | ملاحظات |
|-------|--------|----------------|----------|
| 0 - Inventory & Analysis | ✅ مكتملة | 2026-08-27 | جرد كامل بدون تعديل كود. التقرير: `docs/reports/00_inventory.md`. تسع نقاط حُسمت من المستخدم — لا تنتقل لـ Phase 1 إلا بعد مراجعته للملف. |
| 1 - Setup Structure | ✅ مكتملة | 2026-08-27 | هيكل `app/` فارغ + نقل config/state. التقرير: `docs/reports/01_phase1.md`. لا تنتقل لـ Phase 2 إلا بعد تشغيل يدوي. |
| 2 - Config & State Layer | ✅ مكتملة | 2026-08-27 | JSON config/state عبر `core/config.py` + repositories. التقرير: `docs/reports/02_phase2.md`. لا تنتقل لـ Phase 3 إلا بعد تشغيل يدوي. |
| 3 - Extract Services | ⏳ لم يبدأ | - | - |
| 4 - Extract Repositories | ⏳ لم يبدأ | - | `paths_repository` أُنشئ مبكراً في Phase 2؛ المتبقي أرشيف/Excel. |
| 5 - API/Routes Layer | ⏳ لم يبدأ | - | - |
| 6 - Watchers/Background Jobs | ⏳ لم يبدأ | - | مجلد `watchers/` يبقى فارغاً أو يُحذف. منطق الساعات → `variant_extractor_service.py`. |
| 7 - Tests & Cleanup | ⏳ لم يبدأ | - | - |

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

## للموديل التالي

اقرأ هذا الملف ثم آخر تقرير في `docs/reports/` (`02_phase2.md`). Phase 2 مكتملة بانتظار اختبار تشغيل يدوي من المستخدم قبل Phase 3. لا تعدّل منطقاً مشكوكاً فيه؛ القواعد في `Backend refactor plan.md`.
