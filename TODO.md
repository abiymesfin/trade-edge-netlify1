# TODO

## ዲዛይን እና የአሁኑ ሲስተም — የማይነካ

- የአሁኑ dark/light design፣navigation፣cards፣mobile layout እና visual identity እንዳሉ ይቆያሉ።
- ነባር authentication፣Telegram bot/admin panel፣payment flow እና user data አይሰረዙም አይresetም።
- MT5፣broker connection ወይም paid trading integration አይጨመርም።

## Website signup ከTelegram ጋር በአውቶማቲክ ማገናኘት — DONE

Website signup ከTelegram Mini App signed identity ጋር ይሰራል፣ browser signup ላይ one-time deep-link ይፈጥራል፣email/password fallback ይቀጥላል።

## Customer payment submission flow — DONE

Customer admin ያስቀመጠውን payment account ይመርጣል። Customer የሚያስገባው phone number፣transaction ID/reference እና optional screenshot ብቻ ነው። Bank account/crypto address የሚያስገባው admin ነው፤customer የራሱን bank/crypto account አይሞላም። `files is not defined` የpayment submission ስህተት ተስተካክሏል።

## ደረጃ 1 — Dashboard እና Analytics — IN PROGRESS

- **DONE:** የእውነተኛ journal records ብቻ በመጠቀም Total Loss፣Maximum Drawdown፣Win Rate፣Profit Factor፣Expectancy፣Average Win፣Average Loss፣Average R:R፣Total Trades እና Open Trades ወደ existing account summary card ተጨምረዋል።
- **DONE:** የmetrics ስሌት በenabled account/trade records ላይ ብቻ ይሰራል፤fake data አይፈጠርም።
- **OPEN:** Date range/account filters፣equity curve፣monthly/daily performance፣trading calendar፣today status እና recent-trade analytics እንደ ቀጣይ additive ማሻሻያ ይጨመራሉ።

## ደረጃ 2 — Accounts እና Risk Center — OPEN

Personal/demo/prop account type፣balance፣equity፣target፣loss limit፣drawdown፣risk per trade፣max trades/day፣prop-firm challenge progress እና smart risk calculator ይጨመራሉ።

## ደረጃ 3 — Journal እና Strategy Playbook — OPEN

Advanced trade entry፣risk፣session፣setup፣psychology፣mistake tags፣rule adherence፣partial close፣multiple entries፣strategy rules፣checklist እና strategy screenshots ይጨመራሉ።

## ደረጃ 4 — Market Intelligence — OPEN

D1/H4/H1/M15/M5፣market structure፣BOS/CHoCH፣FVG፣liquidity፣support/resistance፣sessions፣sentiment፣watchlist እና XAUUSD ይጨመራሉ። Reliable free source ካልተገኘ unavailable ይታያል።

## ደረጃ 5 — AI Coach እና Discipline — OPEN

AI Coach actual journal data ብቻ ተጠቅሞ mistakes፣emotion፣revenge trading፣overtrading፣risk እና strategy performance ይተንትናል። Goals፣checklist፣emotion tracking፣mistakes፣no-trade days እና warnings ይጨመራሉ።

## ደረጃ 6 — Backtesting እና Reports — OPEN

Manual backtesting sessions፣strategy comparison፣win rate፣profit factor፣drawdown እና daily/weekly/monthly/account/strategy/risk CSV/PDF reports ይጨመራሉ።

## ደረጃ 7 — Notifications እና verification — OPEN

Daily loss/profit alerts፣excessive risk፣consecutive losses፣weekly/monthly summaries ይጨመራሉ። እያንዳንዱ phase authentication፣user privacy፣Telegram፣payment፣mobile layout እና existing data ጋር ይፈተናል።
