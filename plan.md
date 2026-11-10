# Trade Edge ሙሉ ማሻሻያ እቅድ

## መሠረታዊ ውሳኔ

የአሁኑ Trade Edge ዲዛይን አይቀየርም። አዲስ feature ሁሉ አሁን ባለው dark/light theme፣navigation፣cards፣typography እና mobile layout ውስጥ ብቻ ይጨመራል። Backend፣Telegram bot፣authentication፣payment approval እና የተጠቃሚ ውሂብ አይሰረዝም አይresetም።

## ያለው ሲስተም ግኝት

- `public/index.html` ውስጥ ዋና website፣dashboard፣market analysis፣accounts፣models፣journal እና analytics አሉ።
- `public/admin/index.html` የTelegram Mini App owner/member control panel ነው።
- `netlify/functions/api.mjs` የauthentication፣Telegram identity፣scoped user data፣accounts/models/journal፣payments እና market/news API ያስተዳድራል።
- `netlify/functions/analysis-engine.mjs` የpair analysis እና report helpers ነው።
- Storage በNetlify Blobs ላይ ነው፤ ስለዚህ migration ሁሉ additive ይሆናል።
- MT5፣broker connection ወይም paid market data አይጨመርም።

## ደረጃ 1 — Actual-data Dashboard እና Analytics

Dashboard ላይ ካሉ የjournal records ብቻ ተጠቅሞ Total P/L፣win rate፣profit factor፣average win/loss፣expectancy፣risk/reward፣drawdown፣trades today፣daily target/limit እና account filter ይጨመራሉ። የሌለ ውሂብ እንደ ሐሰተኛ live value አይታይም።

## ደረጃ 2 — Accounts እና Risk Center

Account type፣starting/current balance፣equity፣daily target፣daily loss limit፣overall drawdown፣risk per trade እና max trades/day እንደ additive fields ይጨመራሉ። በዚህ መሠረት የrisk calculator እና prop-firm progress ይሰራሉ።

## ደረጃ 3 — Journal እና Strategy Playbook

ያለውን manual journal ሳይበላሽ advanced entry/exit፣position፣risk፣session፣setup፣psychology፣mistake tags፣rule adherence፣partial close እና multiple-entry metadata ይጨመራሉ። Models ወደ strategy playbook ይሻሻላሉ እና journal records ጋር ይያያዛሉ።

## ደረጃ 4 — Market Intelligence

ያለው market/news data ብቻ ይጠቀማል። D1/H4/H1/M15/M5፣market structure፣BOS/CHoCH፣FVG፣liquidity፣support/resistance፣sessions፣sentiment እና XAUUSD ይጨመራሉ ብቻ አስተማማኝ free source ካለ። ካልነበረ በግልጽ unavailable ይላል።

## ደረጃ 5 — AI Coach እና Discipline

AI Coach የሚጠቀመው የuser እውነተኛ journal data ብቻ ነው። overtrading፣revenge trading፣risk እና strategy performance ላይ ሪፖርት ይሰጣል። Discipline center ደግሞ goals፣checklist፣emotion፣mistakes፣no-trade days እና warnings ይይዛል።

## ደረጃ 6 — Backtesting እና Reports

Manual backtesting records፣strategy comparison፣win rate፣profit factor፣drawdown እና saved sessions ይጨመራሉ። Daily/weekly/monthly/account/strategy/risk reports በCSV እና በትክክለኛ የተቀናጀ PDF ይወጣሉ።

## ደረጃ 7 — Notifications እና quality verification

Daily loss limit፣profit target፣excessive risk፣consecutive losses እና weekly/monthly summary notifications ይጨመራሉ። እያንዳንዱ ደረጃ ከauthentication፣user isolation፣Telegram፣payment፣mobile responsiveness እና existing data ጋር ይፈተናል።

## የዲዛይን መመሪያ

- የአሁኑ layout እና visual identity አይቀየሩም።
- አዲስ cards/controls ያሉትን CSS variables፣spacing እና component patterns ይጠቀማሉ።
- ስራ የማይሰራ button አይጨመርም።
- የሌለ ውሂብ አይፈጠርም።
