-- ===========================================================================
-- AlphaCode Extractor - حذف كل بيانات قاعدة بيانات المزامنة (نسخة جاهزة للتسليم)
-- AlphaCode Extractor - wipe every row of the shared sync database
--
-- الاستخدام: phpMyAdmin ← اختر قاعدة بيانات الأداة ← تبويب SQL ← الصق الملف كاملاً ← تنفيذ.
-- Usage: phpMyAdmin -> select the extension's database -> SQL tab -> paste this whole file -> Go.
--
-- ملاحظات / Notes:
--   • يُنفَّذ على قاعدة بيانات الأداة وحدها (كل جداولها تخصّ AlphaCode). راجع القائمة في
--     الخطوة 0 قبل التنفيذ للتأكد.
--     Run it on the extension's own database (every table in it belongs to AlphaCode). Check the
--     list in step 0 first.
--   • الحذف داخل معاملة واحدة: لو فشل أي جزء ترجع كل الصفوف كما كانت (جداول InnoDB).
--     The delete runs in one transaction: if any part fails, every row comes back (InnoDB tables).
--   • فحص المفاتيح الأجنبية يُعطَّل للحذف فقط ثم يُعاد تفعيله.
--     Foreign-key checks are disabled only for the delete, then restored.
--   • قبل التنفيذ: صدّر جدولي members و member_aliases من phpMyAdmin (تصدير ← SQL) إن أردت
--     إرجاع حسابات الأعضاء لاحقاً — النسخة الاحتياطية في الإضافة لا تشملهما، وبعد الحذف لا رجعة لهما.
--     Before running: export the members and member_aliases tables from phpMyAdmin if you ever want
--     those accounts back - the extension's own backup cannot contain them, and after the wipe they
--     are gone for good.
--   • آمن للتشغيل أكثر من مرة، ولا يحذف الجداول نفسها ولا قاعدة البيانات.
--     Safe to run repeatedly; it drops no tables and does not drop the database.
--
-- Arabic: هذا الملف هو المصدر الوحيد لنصّ الحذف: الباك اند يقرأه ويعرضه في لوحة الإضافة عبر
--         «تحضير ملف الحذف ورسالة الدعم»، ونسخة المستودع في backend/app/data/wipe_db.sql
--         مطابقة له واختبار الوحدة يمنع أي اختلاف بينهما.
-- English: This file is the single source of the wipe text: the backend reads it and serves it in
--          the popup via "prepare the wipe file and the support request"; the repository copy at
--          backend/app/data/wipe_db.sql is identical to it and a unit test prevents any drift.
-- ===========================================================================

-- 0) عرض الجداول التي ستُمسح (للمراجعة فقط - لا يحذف شيئاً).
--    Show the tables that will be wiped (informational only - deletes nothing).
SELECT table_name, table_rows AS approx_rows
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- 1) حذف كل صفوف كل جداول قاعدة البيانات الحالية / every row of every table in this database.
SET FOREIGN_KEY_CHECKS = 0;
START TRANSACTION;

SET @alphacode_tables := (
    SELECT GROUP_CONCAT(CONCAT('`', table_name, '`') SEPARATOR ', ')
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
);
SET @alphacode_sql := IF(
    @alphacode_tables IS NULL,
    'DO 0',
    CONCAT('DELETE FROM ', @alphacode_tables)
);
PREPARE alphacode_stmt FROM @alphacode_sql;
EXECUTE alphacode_stmt;
DEALLOCATE PREPARE alphacode_stmt;

COMMIT;

-- 2) إرجاع عدّاد المعرّفات للبداية (يتخطّى نفسه لو الجدول غير موجود).
--    Restart the ID counter (skips itself when the table is absent).
SET @alphacode_has_sequence := (
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'id_sequence'
);
SET @alphacode_sql := IF(
    @alphacode_has_sequence > 0,
    'ALTER TABLE id_sequence AUTO_INCREMENT = 1',
    'DO 0'
);
PREPARE alphacode_stmt FROM @alphacode_sql;
EXECUTE alphacode_stmt;
DEALLOCATE PREPARE alphacode_stmt;

SET FOREIGN_KEY_CHECKS = 1;

-- 3) تحقق: كل الجداول يجب أن تُرجع صفراً / verification: every table must report zero rows.
SET @alphacode_counts := (
    SELECT GROUP_CONCAT(
        CONCAT('SELECT ''', table_name, ''' AS table_name, COUNT(*) AS rows_left FROM `', table_name, '`')
        SEPARATOR ' UNION ALL '
    )
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
);
SET @alphacode_sql := IF(
    @alphacode_counts IS NULL,
    'DO 0',
    CONCAT('SELECT * FROM (', @alphacode_counts, ') AS alphacode_check ORDER BY rows_left DESC')
);
PREPARE alphacode_stmt FROM @alphacode_sql;
EXECUTE alphacode_stmt;
DEALLOCATE PREPARE alphacode_stmt;

-- ---------------------------------------------------------------------------
-- بديل يدوي لو تعذّر تنفيذ الجزء الديناميكي أعلاه (نفّذه جدولاً جدولاً):
-- Manual alternative when the dynamic part above cannot run (run it table by table):
--
--   SET FOREIGN_KEY_CHECKS = 0;
--   DELETE FROM products;
--   DELETE FROM brands;
--   DELETE FROM members;
--   DELETE FROM member_aliases;
--   DELETE FROM id_sequence;
--   -- وأي جدول فرعي (مثل product_images / product_sizes / product_variations):
--   -- and any child table as well (e.g. product_images / product_sizes / product_variations)
--   ALTER TABLE id_sequence AUTO_INCREMENT = 1;
--   SET FOREIGN_KEY_CHECKS = 1;
--
-- ولمعرفة الأسماء الفعلية للجداول: SHOW TABLES;
-- To discover the real table names: SHOW TABLES;
-- ---------------------------------------------------------------------------
