# سحب فرع الجلسة إلى فرع `dev` على جهازك (Windows)

> هذا الملف تعليمات نسخ/لصق. لا تنفّذ شيئاً على `master`، وكل الدمج يتم على جهازك أنت.

---

## ١) الفرع والكومِتات

| البند | القيمة |
|---|---|
| **فرع الجلسة** | `arena/29e16c53-alphacode-extractor-sooqify-au` |
| أساس الفرع | `ed653a5` (طرف `master` الحالي) |
| كومِت الواجهة (تبويب «حذف البيانات») | `5a3bb14` — Give the danger zone its own «حذف البيانات» tab, admin-only |
| كومِت التوثيق | `be331e8` — Spell out the standalone «حذف البيانات» tab in the docs |
| كومِت ملف التسليم (هذا الملف) | آخر كومِت في الفرع — استعلم عنه بالأمر `git rev-parse origin/arena/29e16c53-alphacode-extractor-sooqify-au` |

للتأكد من طرف الفرع الحقيقي بعد السحب:

```bat
git rev-parse origin/arena/29e16c53-alphacode-extractor-sooqify-au
git log --oneline -5 origin/arena/29e16c53-alphacode-extractor-sooqify-au
```

---

## ٢) أوامر السحب والدمج إلى `dev` (Windows — CMD أو PowerShell)

```bat
cd C:\path\to\alphacode-extractor-sooqify-automation

git fetch origin
git checkout dev
:: لو ما عندك فرع dev محلي بعد، استخدم بدلاً منها:
:: git checkout -b dev origin/dev

git pull origin dev
git merge --no-ff origin/arena/29e16c53-alphacode-extractor-sooqify-au
git push origin dev
```

ملاحظة: رسالة الدمج المقترحة عند ظهور محرّر النص:

```
Merge branch 'arena/29e16c53-alphacode-extractor-sooqify-au' into dev
```

---

## ٣) التحقق بعد الدمج

```bat
git log --oneline -3
python -m pytest backend/tests -q
```

**المتوقع:** آخر كومِت في السجل هو كومِت الدمج، ونتيجة الاختبارات:

```
131 passed, 2 skipped
```

(المجموع 133 مجموعة. الرقم 124 المذكور في §7.4 من ملف التغيير كان قبل دمج `test_brand_id_sync.py`
السابق لهذا الفرع؛ لا شيء في هذا الفرع يفشل.)

فحوصات سريعة إضافية (كلها يجب أن تخرج بلا مخرجات / بلا أخطاء):

```bat
python -m pyflakes backend\app\services\emergency_service.py backend\app\services\neutralize_service.py backend\app\api\routes\sync_routes.py
node --check extension\popup.js
git diff --quiet -- backend\app\data\wipe_db.sql hostinger\alphacode_storage\wipe_db.sql || echo "النسختان مختلفتان!"
```

> على Linux/macOS استبدل `python -m ...` بـ `.venv/bin/python -m ...` إن كنت تستخدم بيئة افتراضية،
> وبالمثل مسارات الملفات بـ `/`.

---

## ٤) خطة التراجع

**قبل الدمج** (رجوع كامل لـ `dev` كما هو على السيرفر):

```bat
git reset --hard origin/dev
```

**بعد الدمج** (بدون إعادة كتابة التاريخ — الأنظف لو كنت دفعت بالفعل):

```bat
:: كومِت الدمج هو HEAD مباشرة بعد الدمج
git revert -m 1 HEAD
git push origin dev
```

أو لو أردت تحديد SHA الدمج صراحةً:

```bat
git log --oneline -1
git revert -m 1 <SHA_كومِت_الدمج>
git push origin dev
```

`-m 1` تعني: أبقِ على جهة `dev` الأصلية وألغِ ما جاء من فرع الجلسة.

---

## ٥) بديل عند تعارض الدمج: Cherry-pick بالترتيب

لو رفض الدمج لكثرة التعارضات، ارجع عن الدمج ثم خُذ الكومِتات واحداً واحداً:

```bat
git merge --abort                 :: أو: git reset --hard origin/dev
git checkout dev
git pull origin dev

git cherry-pick 5a3bb14
:: لو تعارض الأول: أصلح الملفات ثم
:: git add -A && git cherry-pick --continue
:: أو للإلغاء الكامل: git cherry-pick --abort

git cherry-pick be331e8
git push origin dev
```

أو دفعة واحدة بعد جلب الفرع:

```bat
git cherry-pick ed653a5..origin/arena/29e16c53-alphacode-extractor-sooqify-au
git push origin dev
```

---

## ٦) خلاصة الجاهزية

- **الشغل سليم ومختبَر:** `131 passed, 2 skipped` (لا فشل، ولا تحذيرات `pyflakes`، و`popup.js` سليم
  نحوياً، ونسختا `wipe_db.sql` متطابقتان بايت ببايت).
- لا تُرفع أي مفاتيح سرية: الباك اند لا يكتب `Token` في النسخ الاحتياطية (`sync_token_included: false`),
  ورمز الحماية المحلي يُخزَّن بصمة `SHA-256` بملح فقط.
- ملفات الحالة (`sync_lock.json`، `restore_state.json`، `neutralize_state.json`، `backend/backups/`)
  مُستثناة في `.gitignore`، فلا تُسحب إلى فرع `dev` بالخطأ.
