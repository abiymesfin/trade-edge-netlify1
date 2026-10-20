# Trade Edge ማሻሻያ እቅድ

## የተመረጠው አቀራረብ

- **የእይታ አቀራረብ:** ያለውን dark/orange Trade Edge ብራንድ ሳይቀይር ግልጽ የሆነ የsetup እና payment flow።
- **የመግቢያ ፍልስፍና:** የwebsite መመዝገብ ከተጠናቀቀ በኋላ ኢሜልና ፓስወርድ እንደገና ሳይጻፉ አንድ-ጊዜ የሚሰራ Telegram deep-link።
- **የክፍያ ፍልስፍና:** በአካባቢ የEthiopia bank/Telebirr እና በውጭ የcrypto መንገድ በአንድ የpayment request ፍሰት፣ ከadmin ሊስተካከል የሚችል መመሪያ ጋር።

## Implementation

- `public/index.html` የTelegram Mini App signed init dataን ለPOST ጥያቄዎች ያስተላልፋል፣ ከsignup በኋላ 15-ደቂቃ የሚሰራ one-time Telegram link ያሳያል።
- `netlify/functions/api.mjs` የlink token ፍጠራ/መጠቀም፣ Telegram `/start link_...` auto-connect፣ `SameSite=None; Secure` session cookie፣ የbank/Telebirr/crypto payment method ማረጋገጫ እና የpayment record ያክላል።
- `public/admin/index.html` ባለቤቱ የpayment method ስምና መመሪያ እንዲያስተካክል ያደርጋል። ይህ አሁን manual approval ነው፤ የbank/Telebirr/crypto provider API ማስገባት ከprovider credentials ጋር በቀጣይ ይደረጋል።

## የፕሮጀክት መዋቅር

- `public/index.html`: public website, authentication, subscription/payment UI, Telegram connection UX.
- `public/admin/index.html`: owner control panel and payment-method configuration.
- `netlify/functions/api.mjs`: Netlify API, Telegram bot/webhook, sessions, payment requests and data storage.
- `netlify/functions/analysis-engine.mjs`: trading analysis helpers.
