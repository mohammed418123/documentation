# Red Planet Collection — تطبيق التحصيل

هذا المسار مخصص لمصدر تطبيق التحصيل، ومعزول عن محتوى مستودع التوثيق الأصلي.

## الفروع والبيئات

- هذا المصدر موجود على الفرع `red-planet-collection` ولا يعدل فرع `18.0`.
- الإنتاج المرجعي: `https://red-planet-collection.vercel.app/`
- أي تطوير جديد يجب اختباره على Preview/Staging قبل النقل إلى Production.

## المصدر

- `supabase/functions/collection-portal-api-v2/`: مصدر Backend الفعلي المسترجع من Supabase.
- `supabase/functions/collection-portal-staging-site/`: بوابة Staging الحالية.
- `vercel-deployment-snapshot/`: لقطة من ملفات النشر المبنية على Vercel عند الحاجة، وليست بديلًا عن المصدر الأصلي للواجهة.

## الأمان

لا يتم حفظ مفاتيح Odoo أو Supabase Service Role أو رموز الجلسات أو أي أسرار في GitHub. القيم السرية تبقى في متغيرات البيئة/مخزن الأسرار فقط.
