# تقرير المرحلة: Phase 3 — استخراج طبقة الـ Services (Extract Services)

**التاريخ:** 2026-08-27
**الحالة:** مكتملة (نقل/تنظيف منطق داخلي فقط — لم يُغيَّر منطق عمل ولم تُمس أي route)
**المصدر:** `Backend refactor plan.md` Phase 3 + قرارات الجرد في `docs/reports/00_inventory.md` + تأكيد يدوي لـ Phase 2

## ملاحظة هامة قبل البدء

عند فحص المشروع المرفوع، تبيّن أن محتوى الملفات الأربعة تحت `backend/app/services/` كان **منقولاً بالفعل** (نفس المنطق حرفياً)، وأن الاستيراد في أعلى `backend/app.py` كان **مضافاً بالفعل**. لكن `backend/app.py` كان لا يزال يحتفظ بالأجسام الكاملة القديمة لنفس الدوال تحت نفس الأسماء — أي أن تعريف Python المتأخر (الأسفل) كان يُغطّي (Shadowing) الاستيراد المبكر (الأعلى)، فيبقى التطبيق فعلياً يشغّل الكود القديم رغم وجود الاستيراد. العمل الفعلي في هذه المرحلة كان: **حذف الأجسام المكررة** حتى يعمل الاستيراد فعلاً — تماماً بنفس نمط Phase 2 الموثّق ("حذف أجسام الدوال واستبدالها باستيراد بنفس الأسماء").

كذلك تبيّن وجود خطأ فعلي (`NameError`) داخل `/api/ai/extract-watch-variants`: استدعاء `watch_variant_extractor.func(...)` بأسلوب `module.name` دون وجود `import watch_variant_extractor` بالملف إطلاقاً. تم إصلاحه بحذف بادئة الموديول في 4 مواضع فقط، لأن الدوال نفسها مستوردة بالفعل بنفس الاسم أعلى الملف (لا تغيير منطقي، ولا تعديل في تدفق الـ route).

## الملفات المتأثرة

### كانت موجودة مسبقاً (تحقق من محتواها ولم تُعدَّل في هذه المرحلة)

- `backend/app/services/report_service.py` — تحقق: مطابق لمحتوى `Reports.py` الأصلي، ومربوط صح عبر `try/except` اختياري في `app.py` (قرار 3).
- `backend/app/services/variant_extractor_service.py` — تحقق: مطابق لـ `watch_variant_extractor.py` الأصلي، وليس Watcher (قرار 8).
- `backend/app/services/sync_service.py` — تحقق: مطابق لكتلة `sync_*` الأصلية، **بدون** نقل `sync_background_worker` كسلوك حي (قرار 4).
- `backend/app/services/upload_service.py` — تحقق: مطابق لكتلة الصور/الإعدادات/الـ variants الأصلية، وفيها `build_watch_variations_from_absolute_yuan` المطابقة لصيغة `/api/extract` المعتمدة للساعات (قرار 6) — جاهزة للاستخدام من الـ route في مرحلة لاحقة (Phase 5) دون المساس بالـ route الآن.
- `backend/Reports.py` و `backend/watch_variant_extractor.py` — كانا بالفعل مجرد ملفات إعادة تصدير (`re-export shim`) للأسماء من الـ services الجديدة، تركا كما هما.
- `backend/app/repositories/*`, `backend/app/core/config.py` — من Phase 2، لم تُمس.

### تعديل

- `backend/app.py`:
  - حذف الأجسام الكاملة المكررة لـ: `sync_call`, `sync_reserve_id`, `sync_reserve_key`, `sync_push_product`, `sync_flush_queue`, `sync_pull_updates`, `sync_reconcile_full` — استبدال فعلي بالاستيراد الموجود مسبقاً من `app.services.sync_service`.
  - حذف الأجسام الكاملة المكررة لـ: `extract_settings`, `normalize_image_format`, `strip_existing_image_transform`, `build_optimized_image_url`, `sniff_image_extension`, `get_dominant_bg_color`, `prepare_image_for_save`, `download_single_image`, `json_cell`, `build_variant_fields`, `resolve_store_images_for_upload` — استبدال فعلي بالاستيراد الموجود مسبقاً من `app.services.upload_service`.
  - إصلاح مرجع مكسور داخل `/api/ai/extract-watch-variants`: حذف بادئة `watch_variant_extractor.` في 4 مواضع (الدوال مستوردة بنفس الاسم من `app.services.variant_extractor_service` أعلى الملف).
  - **لم يُحذف** `sync_background_worker` (كود ميت، قرار 4) — أُبقي في `app.py` بقرارك، ليُنظَّف لاحقاً في Phase 7.
  - لم تُعدَّل أي دالة route، ولم يتغيّر أي استدعاء بالاسم (كل الاستدعاءات القديمة بقيت كما هي وتُحل الآن تلقائياً من الاستيراد).
- `backend/PROGRESS.md` → تحديث حالة Phase 3.
- إنشاء `docs/reports/03_phase3.md` (هذا الملف).

لم يُمس: أي `@app.route`، `/api/dry-run` وبراندات fallback (قرار 1)، `reports_config.json` (قرار 2)، كاش AI (قرار 5)، `admin`/`admin` (قرار 7)، `require_root_dir` (قرار 9).

## ملخص التغيير

لا تغيير سلوكي. الحجم: `backend/app.py` من 3699 سطر إلى 3138 سطر (تقليص 561 سطر كود مكرر). كل الدوال المذكورة أعلاه صارت مصدرها الوحيد `app/services/*`، وتحققنا فعلياً (تحميل `app.py` ديناميكياً بنفس أسلوب `test_upload_main_image_only.py`) أن كل اسم يتحل الآن من الموديول الصحيح:

| الدالة | المصدر بعد الإصلاح |
|---|---|
| `sync_call`, `sync_reserve_id`, `sync_push_product`, `sync_flush_queue`, `sync_pull_updates`, `sync_reconcile_full` | `app.services.sync_service` |
| `extract_settings`, `normalize_image_format`, `resolve_store_images_for_upload`, `build_variant_fields`, وباقي دوال الصور | `app.services.upload_service` |
| `build_watch_variant_messages`, `validate_watch_variants` | `app.services.variant_extractor_service` |
| `sync_background_worker` | بقيت محلية في `app.py` (كود ميت، بقرارك) |

اختبار `test_upload_main_image_only.py` الموجود مسبقاً شُغِّل ونجح (2/2) بعد الحذف — تأكيد عملي أن `resolve_store_images_for_upload` تعمل الآن من `upload_service.py` بنفس السلوك تماماً.

## سبب التغيير

بدون حذف الأجسام المكررة، الاستيراد من الـ services كان ميتاً فعلياً (Shadowing)، وبالتالي المشروع لم يكن قد أنجز الاستخراج الحقيقي رغم وجود ملفات `services/` جاهزة. هذه الخطوة هي ما يجعل الطبقة الجديدة فعّالة فعلاً في التشغيل، تمهيداً لـ Phase 4 (الأرشيف/Excel) و Phase 5 (الـ Routes).

## كيف يعمل المنطق الجديد

لا منطق جديد. نفس السلوك تماماً، فقط مصدر واحد بدل مصدرين متعارضين. صيغة سعر الساعة المعتمدة (قرار 6) لم تتغير في `/api/extract` — لا تزال محسوبة inline في الـ route كما هي، والدالة `build_watch_variations_from_absolute_yuan` في `upload_service.py` جاهزة كخطوة بناء لمرحلة الـ Routes لاحقاً دون أي تعديل على الـ route الآن.

## القرارات التسعة — ما تم التعامل معه فعلياً في هذه المرحلة

- **قرار 4 (`sync_background_worker`):** تم التأكد أنه غير منقول كسلوك حي في `sync_service.py` (وهذا صحيح مسبقاً)، وتم تثبيت قرارك بإبقائه كما هو في `app.py` كود ميت لحين Phase 7.
- **قرار 6 (سعر الساعة):** تم التحقق أن `upload_service.py` يحوي الصيغة الصحيحة (`build_watch_variations_from_absolute_yuan`، يوان × سعر الصرف بدون إعادة إضافة `WatchFlatFeeYuan`) دون تغيير الـ route الفعلي الذي لا يزال يستخدم حسابه inline — لا نقل تخميني.
- **قرار 8 (تسمية Watchers):** تأكدنا أن `variant_extractor_service.py` هو المكان الصحيح (وليس watcher)، وأن `backend/app/watchers/` فارغ (`__init__.py` فقط) كما هو منصوص.
- باقي القرارات (1، 2، 3، 5، 7، 9) لم تحتج تدخلاً في هذه المرحلة — لم تُمس.

## نقاط تحتاج اختبار يدوي منك قبل Phase 4

- [ ] تشغيل السيرفر فعلياً (`python app.py`) والتأكد أن الإقلاع سليم وأن رسائل اللوج تظهر كالمعتاد.
- [ ] تجربة `/api/sync/now` أو `/api/sync/reconcile` (لو المزامنة مفعّلة) للتأكد عملياً أن المسار المستخرج يعمل بنفس السلوك.
- [ ] تجربة `/api/ai/extract-watch-variants` فعلياً (كان سيتعطل بـ NameError قبل هذا الإصلاح) للتأكد من نجاحه الآن.
- [ ] تشغيل `pytest backend/test_upload_main_image_only.py` عندك أيضاً (نجح هنا 2/2).
