# تقرير المرحلة: Phase 0 — الجرد والتحليل (Inventory & Analysis)

**التاريخ:** 2026-08-27  
**الحالة:** مكتملة (توثيق فقط — لم يُمس أي ملف كود)  
**المصدر:** قراءة كاملة لـ `backend/app.py` (~3750 سطر)، `backend/Reports.py`، `backend/watch_variant_extractor.py`، `backend/reports_config.json`، `backend/test_upload_main_image_only.py`

## الملفات المتأثرة

- لا ملفات كود — Phase 0 توثيق فقط.
- إنشاء: `docs/reports/00_inventory.md` (هذا الملف)
- إنشاء: `backend/PROGRESS.md`

## ملخص التغيير

لا تغيير سلوكي. جرد لكل Function/Class، ملفات config/state، والارتباط بينها. تسع نقاط كانت مشكوكة؛ حُسمت من المستخدم (القسم الأخير). القرارات تُطبَّق من Phase 1 فصاعداً، **بدون تنفيذ في هذه المرحلة**.

## سبب التغيير

تفكيك `app.py` لاحقاً يتطلب خريطة دقيقة حتى لا يُنقل كود ميت أو منطق سعر خاطئ.

## كيف يعمل المنطق الجديد

لا منطق جديد. السلوك الحالي موثّق أدناه كما هو في الكود.

---

## ملاحظة تسمية

`watch_variant_extractor.py` **ليس watcher**. يبني البرومبت والـ JSON schema ويتحقق من رد الموديل. اتصال الـ AI يبقى في `app.py`. قرار المستخدم (نقطة 8): النقل لاحقاً إلى `app/services/variant_extractor_service.py`؛ مجلد `watchers/` يبقى فارغاً أو يُحذف.

---

## ملفات config / state الحالية

| ملف | موجود في المستودع؟ | من يستخدمه | قرار الهجرة |
|-----|---------------------|------------|-------------|
| `backend/paths_config.json` | لا (gitignore) | `load/save_paths_config` → `recompute_paths` | يبقى؛ Phase 1 ينقله إلى `backend/config/` |
| `backend/sync_config.json` | لا (gitignore) | كل مسار المزامنة + login | يبقى؛ → `backend/config/` |
| `backend/sync_state.json` | لا (gitignore) | `load/save_sync_state` | يبقى؛ → `backend/data/` |
| `backend/sync_queue.json` | لا (gitignore) | طابور إعادة دفع المنتجات | يبقى؛ → `backend/data/` |
| `backend/reports_config.json` | نعم | **لا يُقرأ من أي كود Python/JS** | بقايا قديمة — **يُحذف لاحقاً** (ليس في Phase 0) |
| `archive_db.json` | تحت `ROOT_DIR` وقت التشغيل | الأرشيف | ليس ملف إعدادات المستودع |
| `ai_copy_cache.json` | تحت `ROOT_DIR` | مسح فقط عند `/api/archive/clear` | كود الكاش ميت — يُتجاهل في الهجرة |
| `items_bulk_format_nodata.xlsx` | تحت `ROOT_DIR` | Excel المتجر | مسار مشتق من المجلد المختار |
| `logs/alphacode.log`, `logs/price_patterns.jsonl` | تحت `ROOT_DIR` | السجل | |

مسارات الإعدادات الحالية بجانب `app.py` (ليس تحت `config/` بعد).

`.gitignore` يذكر `ai_cache.json` بينما الكود يشير إلى `ai_copy_cache.json` (اختلاف اسم؛ الكاش ميت حسب القرار 5).

---

## `Reports.py`

| الاسم | المسؤولية | Config/State | Coupling |
|-------|-----------|--------------|----------|
| `_rtl` | تشكيل نص عربي للـ PDF أو إرجاعه كما هو | خط ويندوز ثابت `ARABIC_FONT_PATH` | مستقل |
| `_entries_for_scope` | تصفية الأرشيف يومي/شهري؛ يتجاهل عناصر بلا `id` | لا | شكل عنصر الأرشيف |
| `_build_summary_table` | جدول العدد / النوع / `id_source` | لا | حقول المنتج |
| `_build_per_user_table` | تجميع حسب `added_by` | لا | نفس الشكل |
| `_table_style` | تنسيق جداول reportlab | لا | مستقل |
| `generate_report` | بناء PDF وحفظه في `output_path` | مسار الخرج من المستدعي | `/api/reports/generate` عبر `archive_entries` |

استيراد الوحدة في `app.py`: سطر إلزامي `import Reports` **و** `try/except` يجعل التقارير اختيارية. **السلوك المقصود (قرار 3):** try/except الاختياري. الاستيراد الإلزامي حالياً يكسر الإقلاع إذا `reportlab` ناقص — يُصلح عند استخراج طبقة التقارير، ليس الآن.

`requirements.txt` لا يذكر `reportlab` / `arabic-reshaper` / `python-bidi`.

---

## `watch_variant_extractor.py`

| الاسم | المسؤولية | Config/State | Coupling |
|-------|-----------|--------------|----------|
| `WATCH_VARIANT_SCHEMA` / `WATCH_VARIANT_SCHEMA_NAME` | JSON schema للألوان والأسعار | لا | `make_provider_payload` في `app.py` |
| `build_watch_variant_messages` | رسائل system/user لاستخراج ألوان الساعة | لا | `/api/ai/extract-watch-variants` |
| `validate_watch_variants` | تنظيف الرد؛ `found` فقط إذا سعر أساسي أو variant صالح | لا | نفس الـ endpoint |

---

## `app.py` — بنية / لوج

| الاسم | المسؤولية | Config/State | Coupling |
|-------|-----------|--------------|----------|
| `handle_local_request_too_large` | JSON عند HTTP 413 | `MAX_CONTENT_LENGTH` | Flask |
| `ColoredConsoleFormatter` | ألوان الطرفية فقط (ليس ملف السجل) | لا | logging |
| `_enable_windows_ansi_support` | ANSI على cmd ويندوز | لا | ctypes |
| `configure_application_logging` | ملف دوّار + كونسول | `LOG_PATH` | يُعاد من `recompute_paths` |
| `log_failed_http_responses` (`@app.after_request`) | يسجّل أي HTTP ≥ 400 | لا | كل الـ routes |

---

## `app.py` — helpers عامة

| الاسم | المسؤولية | Config/State | Coupling |
|-------|-----------|--------------|----------|
| `normalize_text` | توحيد النصوص | لا | واسع |
| `compact_prompt_text` | تقليص برومبت وحذف روابط/base64 | لا | AI + dry-run |
| `is_valid_marker` | رفض أكواد وهمية | `INVALID_MARKERS` | تكرار / مفاتيح أرشيف |
| `safe_int` / `safe_float` / `safe_bool` | تحويل آمن | لا | واسع |
| `unique_text_values` | إزالة تكرار مع حفظ الترتيب | لا | مقاسات / أسماء |
| `sanitize_log_value` | إخفاء توكنات في اللوج | لا | لوج العميل + workflow |
| `read_recent_log_lines` | آخر أسطر السجل | `LOG_PATH` | `/api/logs/recent` |
| `json_cell` | JSON مضغوط لخلايا Excel | لا | variants |
| `clean_folder_name` | اسم مجلد ويندوز آمن | لا | extract |
| `clean_code_for_path` | جزء مسار من الكود | لا | extract |

---

## `app.py` — JSON / أرشيف (مرشح لـ repositories)

| الاسم | المسؤولية | ملفات | Coupling |
|-------|-----------|-------|----------|
| `load_json_file` | قراءة JSON مع افتراضي عند التلف | أي JSON | كل الطبقات |
| `write_json_temp` | كتابة مؤقتة بنفس القرص | أي JSON | الحفظ الذري |
| `save_json_atomic` | استبدال ذري | أي JSON | كل الكتّاب |
| `load_archive` | تحميل الأرشيف | `archive_db.json` | SAVE_LOCK عند الكتابة |
| `archive_entries` | استبعاد مفاتيح تبدأ بـ `_` | الأرشيف | تقارير، إحصاء، تكرار |
| `get_next_id` | `max(id)+1` محلي | الأرشيف | بعد فشل `sync_reserve_id` |
| `find_existing_product` | تكرار بـ Search Code ثم Style Code | الأرشيف | check + extract |
| `find_product_by_id` / `find_archive_key_by_id` | بحث بالـ ID | الأرشيف | حذف، صور، pending |
| `rebuild_archive_metadata` | `_last_added_id` / `_last_added_code` | الأرشيف | بعد الحذف |
| `create_temp_excel` | صف Excel جديد مؤقت | `items_bulk_format_nodata.xlsx` | extract |
| `create_filtered_excel_temp` | Excel بعد حذف IDs أو مسح الكل | نفس Excel | حذف / مسح |
| `commit_transaction` | صور + Excel + أرشيف مع rollback | Excel + archive + مجلد صور | قلب `/api/extract` |
| `commit_archive_excel` | أرشيف + Excel مع rollback | نفس الملفين | حذف / مسح |
| `delete_product_folder` | حذف مجلد صور داخل `BASE_DIR` فقط | نظام الملفات | حذف منتج / مسح أرشيف |
| `update_product_workflow_status` | حالة التجهيز/الإرسال | الأرشيف | route الحالة |
| `build_pending_product` | حزمة تعبئة الإضافة | لا ملف | URLs ثابتة `http://127.0.0.1:5000` |

---

## `app.py` — مسارات المجلد

| الاسم | المسؤولية | ملفات | Coupling |
|-------|-----------|-------|----------|
| `load_paths_config` / `save_paths_config` | `RootDir` | `paths_config.json` | |
| `is_root_dir_valid` | وجود المجلد + قابلية الكتابة (probe) | القرص | |
| `recompute_paths` | إعادة حساب كل المسارات العامة | paths + `ALPHACODE_ROOT_DIR` | **globals كثيرة** |
| `reconfigure_logging_target` | إعادة توجيه ملف اللوج بعد تغيير المجلد | `LOG_PATH` | `recompute_paths` |
| `RootDirNotConfigured` | استثناء عند الكتابة قبل الاختيار | | |
| `require_root_dir` | يرفع الاستثناء أعلاه | | **غير مستدعى** — قرار 9: الاعتماد على فحص `/api/extract` اليدوي فقط |
| `open_native_folder_dialog` | tkinter في subprocess منفصل | | `/api/paths/choose-folder` |
| `get_brand_folder_name` / `get_brand_dir` | اسم/مسار براند (ميتاداتا؛ المسار الحالي بالتاريخ) | `BASE_DIR` | |
| `get_product_image_dir` | مسار منتج: تاريخ (الحالي) أو براند قديم أو جذر أقدم | `BASE_DIR` | تقديم الصور + الحذف |

---

## `app.py` — مزامنة

| الاسم | المسؤولية | ملفات | Coupling |
|-------|-----------|-------|----------|
| `load_sync_config` / `save_sync_config` | Enabled / URL / Token / AddedByName | `sync_config.json` | |
| `load_sync_state` / `save_sync_state` | last_pull/push، خطأ، `throttled_until` | `sync_state.json` | |
| `load_sync_queue` / `save_sync_queue` | إعادة دفع | `sync_queue.json` | |
| `sync_call` | HTTP موحّد لـ `sync.php` + دائرة أمان بعد 403 | config + state | كل أكشنات السيرفر عدا login (يستخدم urllib) |
| `sync_reserve_id` | حجز ID مركزي؛ `None` → ترقيم محلي | سيرفر بعيد | داخل `extract_product` |
| `sync_reserve_key` | قفل تفاؤلي للمفتاح قبل تنزيل الصور | سيرفر بعيد | داخل `extract_product` |
| `sync_push_product` | دفع منتج أو وضعه في الطابور | queue + state | extract + repair + reconcile |
| `sync_flush_queue` | إعادة محاولة حتى 20 مرة ثم إسقاط العنصر | queue | `/api/sync/now`؛ العامل الدوري **ميت** |
| `sync_pull_updates` | دمج مفاتيح غير موجودة محلياً (لا يستبدل الموجود) | أرشيف | `/api/sync/pull` |
| `sync_reconcile_full` | pull كامل ثم push للمحلي-فقط مع pacing | أرشيف + سيرفر | إقلاع + `/api/sync/reconcile` |
| `sync_background_worker` | حلقة كل 90 ثانية: pull + flush | | **كود ميت (قرار 4).** التصميم الصحيح: مزامنة مرة عند الإقلاع فقط عبر `_startup_reconcile` |

`login_sync` لا يستخدم `sync_call`؛ يستخدم `urllib.request` مباشرة. عند تعطيل المزامنة: قبول `admin`/`admin` — **مقصود للديف، يُبقى (قرار 7).**

---

## `app.py` — إصلاح بيانات

| الاسم | المسؤولية | ملفات | Coupling |
|-------|-----------|-------|----------|
| `scan_data_repair_issues` | حقول ناقصة/زائدة، أخطاء، تعارض مع السيرفر (قراءة فقط) | أرشيف + pull بعيد | `REFERENCE_PRODUCT_FIELDS` |
| `apply_data_repair_fix` | backup ثم تعبئة حقول ناقصة فقط ثم push | أرشيف + sync | SAVE_LOCK |
| `generate_data_repair_reports` | Excel أخطاء + حقول زائدة | `ROOT_DIR/reports` | pandas |

---

## `app.py` — صور ومتجر

| الاسم | المسؤولية | Coupling |
|-------|-----------|----------|
| `extract_settings` | قراءة إعدادات الطلب بقيم افتراضية | قلب `/api/extract` |
| `normalize_image_format` | إجبار JPEG بدل WebP | تنزيل |
| `strip_existing_image_transform` | إزالة `imageMogr2` القديم | روابط صور |
| `build_optimized_image_url` | thumbnail من CDN إلا في وضع الصورة الرئيسية فقط | تنزيل |
| `sniff_image_extension` | امتداد من البايتات | وضع raw |
| `get_dominant_bg_color` | متوسط زوايا الصورة | تربيع |
| `prepare_image_for_save` | مربع 1:1 + ضغط | غير raw |
| `download_single_image` | 3 محاولات؛ raw أو معالجة | extract |
| `build_variant_fields` | صفوف Sooqify للأحذية، وللساعات عبر `WatchColors` (أساسي + delta + رسم ثابت) | **ليس صيغة السعر المعتمدة للساعات عند وجود Variants من الإضافة** |
| `resolve_store_images_for_upload` | رئيسية فقط أو رئيسية + حتى 5 معرض | مختبر في `test_upload_main_image_only.py` |

**سعر الساعة المعتمد (قرار 6):** صيغة `/api/extract` عندما تصل `Variants` من الإضافة: سعر مطلق باليوان × `ExchangeRate` (بدون إعادة إضافة `WatchFlatFeeYuan` في هذا المسار). مسار `build_variant_fields` للساعات مختلف؛ عند النقل يُحافظ على سلوك extract الفعلي ولا يُوحَّد التخمين.

---

## `app.py` — براند وأسماء

| الاسم | المسؤولية | Coupling |
|-------|-----------|----------|
| `canonicalize_brand_name` | توحيد أسماء براندات معروفة | أسماء + خريطة |
| `parse_brand_map_json` | خريطة الاسم→ID من الإعدادات | extract |
| `normalize_allowed_brands` | قائمة مسموحة فقط | AI + extract |
| `detect_allowed_brand_from_text` | اكتشاف من النص ضمن القائمة | |
| `resolve_allowed_brand` | رفض براند خارج الخريطة | AI + extract |
| `enforce_product_name_rules` | اسم إنجليزي: براند مرة + كود مرة | `/api/ai/generate` |
| `enforce_arabic_product_name` | اسم عربي؛ يتفرع أحذية/ساعات | `/api/ai/generate` |

---

## `app.py` — ذكاء اصطناعي

| الاسم | المسؤولية | Config/State | قرار الهجرة |
|-------|-----------|--------------|-------------|
| `ai_cache_key` | مفتاح كاش حسب نسخة البرومبت | لا استدعاء ظاهر | **ميت — يُتجاهل (قرار 5)** |
| `AI_CACHE_LOCK` | قفل الكاش | غير مستخدم فعلياً للكتابة | ميت |
| `resolve_official_store_domains` | نطاق رسمي حسب البراند | لا | توليد مع بحث |
| `extract_first_json_object` | أول كائن JSON متوازن | لا | AI |
| `read_retry_after_seconds` | مدة 429 | لا | `send_ai_request` |
| `validate_generated_copy` | حقول الاسم/الوصف مطلوبة | لا | generate |
| `product_copy_schema` | schema مخرجات المحتوى | لا | payload |
| `normalize_ai_provider` | groq / openai / custom | لا | runtime |
| `resolve_ai_runtime` | endpoint + موديل + مفتاح من البيئة | env vars | كل طلبات AI |
| `build_normal_ai_messages` | برومبت توليد أول | لا | generate |
| `build_official_research_prompt` | بحث نطاق رسمي | لا | بحث |
| `build_official_rewrite_messages` | صياغة بعد البحث | لا | generate |
| `make_provider_payload` | تنسيق Chat vs Responses + schema اختياري | لا | copy + watch variants |
| `extract_ai_output_text` | قراءة النص من شكلي الرد | لا | |
| `AIProviderRequestError` | خطأ مزود مع status | لا | generate |
| `send_ai_request` | طلب واحد؛ لا إعادة تلقائية لـ 413/429 | لا | كل AI |
| `send_copy_generation` | JSON ثم fallback نصي مرة | لا | copy فقط |
| `repair_json_once` | إصلاح JSON مرة | لا | copy |
| `generate_official_research` | بحث ويب مضبوط النطاق | GROQ/OpenAI | generate |

الاستخدام الظاهر لـ `AI_CACHE_PATH`: مسح الملف عند `/api/archive/clear` إذا طُلب. لا قراءة/كتابة كاش أثناء التوليد.

---

## `app.py` — لوج عميل

| الاسم | المسؤولية | ملفات | ملاحظات |
|-------|-----------|-------|---------|
| `log_price_pattern` | JSONL لأنماط السعر | `price_patterns.jsonl` | |
| `record_client_log_internal` | كتابة لوج + أنماط سعر | | |
| `record_client_log` | `/api/log/client` | | بعد `return` يوجد كود ميت مكرر (unreachable) |

---

## Routes في `app.py`

| المسار | الدالة | دور مختصر | قرار الهجرة |
|--------|--------|-----------|-------------|
| `GET /api/health` | `health_check` | مفاتيح AI + مجلد + sync | يُنقل مع routes |
| `GET /api/paths/status` | `get_paths_status` | حالة مجلد الحفظ | paths |
| `POST /api/paths/choose-folder` | `choose_root_folder` | نافذة اختيار مجلد | paths |
| `GET/POST /api/sync/config` | `get_sync_config` / `set_sync_config` | إعدادات المزامنة (توكن مقنّع في GET) | sync |
| `GET /api/sync/status` | `get_sync_status` | last pull/push + حجم الطابور | sync |
| `POST /api/sync/now` | `trigger_sync_now` | pull + flush فوري | sync |
| `POST /api/sync/login` | `login_sync` | whoami بعيد أو admin محلي | يُبقى admin/admin للديف |
| `POST /api/sync/logout` | `logout_sync` | نجاح شكلي (stateless) | |
| `POST /api/sync/pull` | `api_sync_pull` | pull خفيف | |
| `POST /api/sync/reconcile` | `api_sync_reconcile` | reconcile كامل | |
| `POST /api/reports/generate` | `generate_pdf_report` | PDF يومي/شهري | report_service |
| `GET /api/reports/download/<filename>` | `download_pdf_report` | تنزيل PDF | |
| `GET /api/brands` | `api_get_brands` | براندات من السيرفر أو fallback محلي عبر `load_settings()` | مسار السيرفر يُنقل؛ **الـ fallback لا يُنقل حتى التحقق اليدوي (قرار 1)** |
| `POST /api/brands/add` | `api_add_brand` | إضافة براند عبر sync.php | sync |
| `GET /api/logs/price-patterns` | `get_price_patterns_log` | تنزيل JSONL | |
| `POST /api/log/client` | `record_client_log` | لوج الإضافة | |
| `GET /api/logs/recent` | `get_recent_logs` | آخر الأسطر | |
| `GET /api/logs/download` | `download_application_log` | تنزيل alphacode.log | |
| `POST /api/check` | `check_product` | تكرار قبل التنزيل | |
| `GET /api/archive/product/<id>` | `get_archived_product` | قراءة منتج | |
| `GET /api/archive/last` | `get_last_archived_product` | آخر منتج | |
| `GET /api/archive/stats` | `get_archive_stats` | إحصاءات | |
| `GET /api/archive/recent` | `get_recent_products` | آخر الإضافات | |
| `GET /api/pending/latest` | `get_latest_pending_product` | آخر حزمة تعبئة | |
| `GET /api/pending/<id>` | `get_pending_product` | حزمة تعبئة بالـ ID | |
| `POST /api/archive/product/<id>/status` | `set_archived_product_status` | workflow | |
| `DELETE /api/archive/product/<id>` | `delete_archived_product` | حذف سجل ± صور | |
| `POST /api/archive/clear` | `clear_archive_data` | مسح الكل ± صور ± كاش | |
| `GET /api/data-repair/scan` | `api_data_repair_scan` | فحص | |
| `POST /api/data-repair/apply` | `api_data_repair_apply` | تطبيق افتراضيات | |
| `POST /api/data-repair/report` | `api_data_repair_report` | Excel تقارير | |
| `GET /api/data-repair/download/<filename>` | `api_data_repair_download` | تنزيل تقرير | |
| `GET /api/product-images/<id>/<filename>` | `serve_product_image` | تقديم صورة دون كشف المسار | |
| `POST /api/ai/generate` | `generate_ai_copy` | أسماء/أوصاف ± بحث رسمي | |
| `POST /api/ai/extract-watch-variants` | `extract_watch_variants_endpoint` | ألوان/أسعار ساعات | variant_extractor_service |
| `POST /api/dry-run` | `dry_run_extract` | محاكاة extract؛ يستدعي `load_settings` و`parse_sizes_list` **غير المعرّفتين** | **لا يُنقل حتى التحقق اليدوي (قرار 1)** |
| `POST /api/extract` | `extract_product` | العملية الرئيسية | upload + archive + sync |

تشغيل: `if __name__ == "__main__"` على `127.0.0.1:5000`. إذا sync مفعّل: خيط daemon `_startup_reconcile` → `sync_reconcile_full` مرة واحدة. لا حلقة دورية.

---

## اختبار موجود

`backend/test_upload_main_image_only.py`: يحمّل `app.py` كوحدة ويختبر `resolve_store_images_for_upload` (رئيسية فقط مقابل معرض). مرجع سلوك الرفع في Phase 3/7.

---

## ربط مع الهيكل المستهدف

| طبقة مستهدفة | المرشح الحالي | ملاحظات النقل |
|--------------|----------------|----------------|
| `report_service` | `Reports.py` + routes التقارير | جعل الاستيراد اختيارياً كما هو مقصود |
| `variant_extractor_service` | `watch_variant_extractor.py` + endpoint + AI مشترك للطلب | ليس watcher |
| `sync_service` | كتلة `sync_*` عدا العامل الدوري الميت | لا تنقل `sync_background_worker` كسلوك حي |
| `upload_service` | صور + `extract_product` + `resolve_store_images_for_upload` | سعر الساعات = صيغة extract |
| repositories | load/save JSON للمسارات / sync / queue / archive | |
| `watchers/` | لا يوجد | فارغ أو يُحذف (قرار 8) |
| config | globals أعلى `app.py` + `extract_settings` من الطلب | |
| لا يُنقل الآن | `dry_run_extract`، brands fallback عبر `load_settings`، كاش AI، `sync_background_worker` كحلقة، `reports_config.json` | قرارات 1، 4، 5، 2 |

---

## نقاط تحتاج اختبار يدوي من المستخدم

- [ ] مراجعة هذا الجرد قبل Phase 1
- [ ] تشغيل `/api/dry-run` وتسجيل هل يرجع 500 بسبب `load_settings` / `parse_sizes_list`
- [ ] تشغيل `GET /api/brands` والمزامنة **مطفأة** — هل الـ fallback يكسر الطلب؟
- [ ] تأكيد أن الإقلاع الحالي ينجح مع/بدون `reportlab` (الاستيراد الإلزامي قد يمنع الإقلاع بدون الحزمة)

## قرارات المستخدم (كانت مشكوكة — حُسمت، لا تخمين إضافي)

1. **`/api/dry-run` و brands fallback:** التحقق يدوي لاحقاً. حالياً: **كود محتمل أنه ميت — لا يُنقل.**
2. **`reports_config.json`:** بقايا قديمة — **آمن للحذف لاحقاً.** لم يُحذف في Phase 0.
3. **استيراد Reports:** السلوك المقصود هو **try/except الاختياري.**
4. **`sync_background_worker`:** التصميم الصحيح = **مزامنة مرة عند الإقلاع فقط.** الحلقة كود ميت.
5. **كاش AI:** **يُتجاهل في الهجرة** (ميت).
6. **سعر الساعة:** المعتمد هو **يوان × سعر الصرف** كما في `/api/extract`.
7. **`admin`/`admin`:** للديف فقط — **يُبقى.**
8. **Phase 6:** كل منطق الاستخراج → **`variant_extractor_service.py`**. `watchers/` فارغ أو يُحذف.
9. **`require_root_dir`:** **الاعتماد على الفحص اليدوي في `/api/extract` فقط.**

## ملاحظات ظاهرة (ليست تخميناً لوظيفة مجهولة)

- كود unreachable بعد `return` في `record_client_log`.
- `.gitignore`: `ai_cache.json` مقابل `ai_copy_cache.json` في الكود.
- `requirements.txt` بدون حزم PDF العربية.
- `FeePercent` يظهر في dry-run فقط؛ `extract_settings` يستخدم `AddedFeeYuan` — غير ذي صلة بالنقل ما دام dry-run لا يُنقل.
