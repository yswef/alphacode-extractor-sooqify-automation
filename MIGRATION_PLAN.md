# خطة الترحيل المعماري — AlphaCode v6.0

> **الحالة:** مسودة للمراجعة — لا يبدأ التنفيذ قبل اكتمال الإصلاحات الحالية واستقرار رفع الساعات.

---

## المرحلة أ: ترحيل archive_db.json → MySQL (الأولوية الأعلى)

### الوضع الحالي
- كل منتج يُحفظ في `archive_db.json` محلياً على كل جهاز.
- `sync.php` يُزامن نسخة `archive_shared.json` على السيرفر.
- Flask يشغّل طلبات HTTP لـ`sync.php` بشكل دوري لجلب التحديثات — يستهلك نت حتى لو ما تغير شيء.

### الهدف
- Flask يتصل مباشرة بـMySQL على Hostinger (بدون PHP كوسيط للبيانات).
- لا `archive_db.json` — قاعدة البيانات هي المصدر الوحيد.
- المزامنة تحصل **فقط**: عند بدء التشغيل + عند إضافة/تعديل منتج + عند طلب يدوي.

### خطوات التنفيذ

#### ١. إضافة اتصال MySQL مباشر لـFlask
```
requirements.txt: + pymysql أو mysql-connector-python
backend/db.py (جديد): إدارة connection pool + helper queries
backend/db_config.json (جديد): host/port/user/password/database (خارج git)
```

#### ٢. استبدال load_archive / save_archive
```python
# القديم
def load_archive(): return json.load(open(ARCHIVE_PATH))
def save_json_atomic(path, data): ...

# الجديد
def load_archive(): return db.fetch_all_products()
def save_product(key, item): db.upsert_product(key, item)
```

#### ٣. ترحيل البيانات الموجودة
- سكربت Python واحد: `migrate_local_to_mysql.py`
- يقرأ `archive_db.json` ويكتب كل منتج لـMySQL
- يتحقق من التكرارات قبل الكتابة
- يُشغَّل **مرة واحدة فقط** ثم يُحذف

#### ٤. حذف ملفات JSON
- `archive_db.json`
- `archive_shared.json` على السيرفر
- `id_counter.json`
- تبقى: `sync_config.json`, `sync_state.json`, `sync_queue.json` (إعدادات/حالة فقط)

#### ٥. تعديل sync.php
- يصير **للمصادقة فقط** (`whoami`, `brands`, `add_brand`)
- حذف endpoints: `pull`, `push`, `reserve`, `batch_push`

### المخاطر
| المخاطرة | التخفيف |
|---|---|
| فقدان بيانات أثناء الترحيل | نسخة احتياطية كاملة من archive_db.json قبل أي خطوة |
| MySQL غير متاح (انقطاع شبكة) | queue محلي مؤقت + retry تلقائي |
| تعارض بيانات بين جهازين | row-level locking في MySQL |

---

## المرحلة ب: مزامنة المتجر (تقرير PDF للمنتجات)

> **تحذير:** هذه الميزة تتطلب API للمتجر (Sooqify) أو scraping — راجع حدود المعدل قبل التنفيذ.

### الفكرة
عند فتح الإضافة، يُولَّد تقرير PDF يحوي:
1. المنتجات الموجودة في قاعدة البيانات **والمتجر** معاً (حالة: مزامَن ✅)
2. المنتجات في قاعدة البيانات **فقط** (لم تُرفع) — مع روابط SZWEGO للرفع اليدوي
3. المنتجات في المتجر **فقط** (لا يعرفها النظام) — تنبيه للمشرف

### التنفيذ المقترح
```
backend/store_sync.py (جديد):
  - fetch_store_products(): يجلب المنتجات من Sooqify API
  - compare_with_db(): يقارن مع قاعدة البيانات
  - generate_pdf_report(): يُولّد ملف PDF بـreportlab

/api/store-sync/report (endpoint جديد):
  - GET: يُولِّد ويُعيد رابط تنزيل PDF
  - نتيجة: التقرير يُحفظ في reports/ ورابطه يُرسل للمشرف

background alarm (كل 24 ساعة):
  - يستدعي الـendpoint
  - يُرسل إشعار Chrome بـ"تقرير مزامنة جديد جاهز"
```

### الاعتبارات الحرجة
- **حد المعدل:** Sooqify قد يحظر طلبات كثيرة — استخدام `SYNC_REQUEST_PACING_SECONDS`
- **حجم البيانات:** 2500 منتج = طلبات متعددة (pagination) — معالجة في background
- **الجدوى:** تحقق من أن Sooqify عنده API للقراءة وليس scraping فقط

---

## الجدول الزمني المقترح

| المرحلة | المتطلب | الوقت التقريبي |
|---|---|---|
| **أ١** اتصال MySQL مباشر لـFlask | استقرار الإصلاحات الحالية | جلسة واحدة |
| **أ٢** ترحيل البيانات | أ١ جاهز + اتفاق على schema | جلسة واحدة |
| **أ٣** حذف الـJSON | أ٢ اختُبر واستقر | جلسة واحدة |
| **ب** مزامنة المتجر | أ٣ مكتمل + Sooqify API متاح | جلستان |

---

## ملاحظات Schema المقترح لـMySQL

```sql
-- الجدول الرئيسي (يستبدل archive_db.json)
ALTER TABLE products ADD COLUMN IF NOT EXISTS
  local_path VARCHAR(512),       -- مجلد الصور المحلي
  workflow_status VARCHAR(50),   -- prepared/submitted/...
  payload_json LONGTEXT;         -- نفس بنية archive_item الحالية

-- جدول جديد للإعدادات (يستبدل ملفات JSON الثابتة)
CREATE TABLE IF NOT EXISTS settings (
  key_name VARCHAR(100) PRIMARY KEY,
  value_json TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```
