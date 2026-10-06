# alphacode_storage — سكربت المزامنة المركزي (نسخة الرفع على الاستضافة)

**العربية:**

هذا المجلد هو ما يُرفع مرة واحدة إلى استضافة PHP + قاعدة بيانات، وتتصل به كل الأجهزة التي تعمل
على نفس المتجر. الملف المتتبَّع في Git هو `sync.php` فقط (لتوثيق العقد البرمجي)، وبقية الملفات
تُضاف على الاستضافة نفسها ولا تدخل Git أبداً:

| ملف | من يوفّره |
|---|---|
| `db.php` | يُضاف على الاستضافة (اتصال PDO + `alphacode_db()` و`alphacode_db_driver()`) |
| `db_config.php` | بيانات قاعدة البيانات (يُضاف على الاستضافة فقط، ومستثنى من Git) |
| `sync_write_helpers.php` | `sync_write_product_children()` لحفظ تفاصيل المنتج (يُضاف على الاستضافة) |
| `schema.sql` | جريان مرة واحدة لإنشاء الجداول (`products`, `brands`, `members`, `member_aliases`, `id_sequence`, …) |

**الإعداد الإلزامي:** كود المزامنة السري يُقرأ من متغير البيئة `ALPHACODE_SYNC_TOKEN`
(في PHP-FPM أو Apache)، ولا يُكتب داخل الملف أبداً. نفس الكود يُدخل في لوحة الإضافة.

## الإيقاف النهائي: `action=erase` وملف `shutdown.lock`

أُضيف إلى `sync.php` في هذا الإصدار ما يجعل إيقاف المزامنة نهائياً ممكناً من داخل الإضافة:

1. `action=erase` مع `confirm=ERASE`:
   - يحذف **كل صفوف كل الجداول** (منتجات، أعضاء، أسماء بديلة، براندات، حجوزات المعرّفات) داخل
     معاملة واحدة، مع تعطيل فحص المفاتيح الأجنبية مؤقتاً ثم إعادته.
   - يعيد عدّاد المعرّفات (`id_sequence`) إلى البداية، لأن الجداول صارت فارغة.
   - يكتب ملف `shutdown.lock` بجانب السكربت.
   - يرجع تقريراً بعدد الصفوف المحذوفة لكل جدول (`deleted`, `total_deleted`).
2. `shutdown.lock`: ما دام الملف موجوداً يرفض `sync.php` **كل** الطلبات بـ`410 Gone`
   (`"shutdown": true`) قبل فتح قاعدة البيانات إطلاقاً، فلا يمكن استخدام المزامنة من أي جهاز
   حتى لو كان معه الكود السري القديم.
3. `action=bump_sequence` مع `{"value": N}`: يرفع عدّاد المعرّفات فوق أعلى معرّف بعد إعادة رفع
   نسخة احتياطية، فلا يحصل منتج جديد على معرّف استُخدم سابقاً في المتجر.

**ترتيب الاستخدام الآمن:** تُؤخذ النسخة الاحتياطية من لوحة الإضافة أولاً
(المزامنة والمجلد ← منطقة خطر)، ثم يُنفَّذ المسح، ثم يُقفل الجهاز نفسه ويُمسح منه رابط السيرفر
والكود السري.

**لإعادة التشغيل لاحقاً:** احذف `shutdown.lock` من الاستضافة، أو ارفع نسخة جديدة على استضافة
أخرى واضبط `ALPHACODE_SYNC_TOKEN` الجديد (يُستحسن تغييره)، ثم استخدم «استعادة النسخة إلى السيرفر»
في لوحة الإضافة: ترفع البراندات أولاً ثم كل المنتجات ثم تضبط عدّاد المعرّفات.

> تنبيه: لا يوجد action لقراءة جدول الأعضاء، فحسابات الأعضاء وكلمات المرور **لا** تدخل النسخة
> الاحتياطية — بعد إعادة الرفع أعد إنشاءهم من قاعدة البيانات على الاستضافة.

---

**English:**

This folder is what gets uploaded once to a PHP + database host, and every machine working on the
same store talks to it. Only `sync.php` is tracked in Git (to document the wire contract); the
rest is added on the host itself and never enters Git:

| File | Who provides it |
|---|---|
| `db.php` | added on the host (PDO connection + `alphacode_db()` / `alphacode_db_driver()`) |
| `db_config.php` | database credentials (host only, git-ignored) |
| `sync_write_helpers.php` | `sync_write_product_children()` for product details (added on the host) |
| `schema.sql` | run once to create the tables (`products`, `brands`, `members`, `member_aliases`, `id_sequence`, …) |

**Required setup:** the sync token is read from the `ALPHACODE_SYNC_TOKEN` environment variable
(PHP-FPM or Apache) and is never written inside the file. The same token goes into the popup.

## Stopping for good: `action=erase` and `shutdown.lock`

This release adds what makes a permanent shutdown possible from inside the extension:

1. `action=erase` with `confirm=ERASE`:
   - deletes **every row of every table** (products, members, aliases, brands, ID reservations) in
     one transaction, temporarily disabling foreign-key checks and restoring them after,
   - resets the ID counter (`id_sequence`) since the tables are now empty,
   - writes a `shutdown.lock` file next to the script,
   - returns a per-table report of deleted rows (`deleted`, `total_deleted`).
2. `shutdown.lock`: while it exists, `sync.php` refuses **every** request with `410 Gone`
   (`"shutdown": true`) before even opening the database, so sync cannot be used from any machine
   even one still holding the old secret token.
3. `action=bump_sequence` with `{"value": N}`: raises the ID counter above the highest ID after a
   backup is re-uploaded, so a new product never gets an ID the store has already seen.

**Safe order of use:** take the backup from the popup first (Sync & Folder -> danger zone), then run
the erase, then the machine locks itself and its server URL and token are wiped.

**Reviving it later:** delete `shutdown.lock` on the host, or deploy a fresh copy to another host
with a new `ALPHACODE_SYNC_TOKEN` (rotating it is recommended), then use "restore the backup to the
server" in the popup: brands first, then every product, then the ID counter.

> Note: there is no action that reads the members table, so member accounts and passwords are
> **not** part of the backup - recreate them on the host from the database after the re-upload.
