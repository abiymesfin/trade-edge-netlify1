# TODO

## Website signup ከTelegram ጋር በአውቶማቲክ ማገናኘት — DONE

- Website signup ከTelegram Mini App ሲመጣ signed Telegram identityን ይጠቀማል።
- በመደበኛ browser signup ላይ 15-ደቂቃ የሚሰራ one-time `Connect Telegram` deep-link ይፈጠራል።
- Signup ከተሳካ በኋላ Telegram deep-link በራስ-ሰር ለመክፈት ይሞክራል፣ fallback button ግን ይቀራል።
- ተጠቃሚው linkን ከከፈተ እና Telegram bot ላይ Start ከጫነ በኋላ account በራስ-ሰር ይገናኛል።
- አሮጌው email/password fallback መንገድ እንደቀጠለ ነው።

## Customer payment submission flow — DONE

- Customer My Plan ላይ `View payment instructions` ሲጫን የpayment options እና የpayment submission form ይከፈታል።
- Customer የሚከፍልበትን plan እና admin ያስቀመጠውን payment account ይመርጣል።
- Phone number፣paying account/wallet፣transaction ID/reference እና optional payment screenshot ይላካል።
- Website payment flow እና Telegram Mini App payment flow ተመሳሳይ `/api/subscribe` endpoint ይጠቀማሉ።
- Owner Payments tab ላይ payer phone፣payer account፣transaction ID እና screenshot link ይታያሉ፤ approval አሁንም manual ነው።

## Ethiopia / International payment flow — DONE

- Ethiopia የbank transfer እና Telebirr አማራጮች ተጨምረዋል።
- International cryptocurrency አማራጭ ተጨምሯል፣ network እና transaction ID/reference ይጠይቃል።
- Admin በPlans ክፍል ውስጥ የbank፣Telebirr እና crypto wallet/network መመሪያዎችን ማስተካከል ይችላል።
- Payment account edits now persist to the backend immediately; Save all accounts also persists the full list.

## Later integration — OPEN

- ትክክለኛ የTelebirr/bank/crypto provider API ለመገናኘት provider credentials፣merchant account እና webhook specifications ያስፈልጋሉ።

## Telegram control-panel visual and payment-account upgrade — DONE

- The control panel opens in Light Mode by default, remembers the user's Light/Dark selection, and provides a visible theme toggle.
- Professional navigation/header/card treatment, dark mobile tabs and SVG navigation icons are included.
- Add/Edit/Delete/Save plan and payment actions use compact icon controls with tooltips.

## Next requested items — OPEN

The next product changes can be added without replacing the existing account, payment approval, or trading data flows.
