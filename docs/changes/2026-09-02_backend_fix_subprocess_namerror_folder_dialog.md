# إصلاح NameError('subprocess') عند فتح نافذة اختيار مجلد الحفظ

**التاريخ:** 2026-09-02
**الملفات المعدَّلة:** `backend/app/services/ai_helpers.py`

## المشكلة

اختبار حقيقي: الضغط على "اختيار / تغيير مجلد الحفظ" بالإضافة يرمي
`NameError: name 'subprocess' is not defined`.

## التشخيص

`POST /api/paths/choose-folder` بـ`core_routes.py` يستدعي
`open_native_folder_dialog()`، المستوردة من `app.services.ai_helpers` (ليس من
`backend/app.py` القديم). الدالة الفعلية المُستدعاة، بـ`ai_helpers.py:308-333`، تستخدم
`subprocess.run(...)` (سطر 326) لفتح نافذة tkinter باختيار مجلد عبر عملية Python منفصلة —
لكن `ai_helpers.py` لا يستورد `subprocess` إطلاقاً بأعلى الملف. يوجد تعريف *مطابق* لنفس
الدالة بـ`backend/app.py` القديم، ومستورد `subprocess` بشكل صحيح هناك (سطر 8) — لكن ذاك
الملف غير مستخدم بنقطة التشغيل الفعلية (`backend/app/main.py`)، فالنسخة الوحيدة اللي
تعمل فعلاً هي نسخة `ai_helpers.py` المكسورة.

## الإصلاح

أُضيف `import subprocess` بأعلى `ai_helpers.py` مع بقية الاستيرادات القياسية.

## التحقق الفعلي

- استيراد الدالة مباشرة بـPython بعد التعديل يؤكد أن `subprocess` بقاموس globals
  الخاص بالدالة صار يشير فعلياً لموديول `subprocess` (لا أكثر `NameError`):
  `open_native_folder_dialog.__globals__['subprocess']` → `<module 'subprocess' ...>`.
- إعادة إنتاج فعلية كاملة للنقر على الزر بواجهة الإضافة (فتح نافذة tkinter حقيقية) تُركت
  للمستخدم لأنها تحتاج تفاعل GUI مباشر لا يمكن أتمتته من هذه الجلسة.
