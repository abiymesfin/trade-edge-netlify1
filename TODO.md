# TODO

## Website signup ከTelegram ጋር በአውቶማቲክ ማገናኘት — DONE

- Website signup ከTelegram Mini App ሲመጣ signed Telegram identityን ይጠቀማል።
- በመደበኛ browser signup ላይ 15-ደቂቃ የሚሰራ one-time `Connect Telegram` deep-link ይፈጠራል።
- ተጠቃሚው linkን ከከፈተ እና Telegram bot ላይ Start ከጫነ በኋላ account በራስ-ሰር ይገናኛል።
- አሮጌው `/login email password` የfallback መንገድ እንደቀጠለ ነው።

## Ethiopia / International payment flow — DONE

- Ethiopia የbank transfer እና Telebirr አማራጮች ተጨምረዋል።
- International cryptocurrency አማራጭ ተጨምሯል፣ network እና transaction ID/reference ይጠይቃል።
- Admin በPlans ክፍል ውስጥ የbank፣Telebirr እና crypto wallet/network መመሪያዎችን ማስተካከል ይችላል።
- Payment request የmethod name፣network እና reference/TxID ይይዛል፤ የአሁኑ approval በadmin/Telegram manual ነው።

## Later integration — OPEN

- ትክክለኛ የTelebirr/bank/crypto provider API ለመገናኘት provider credentials፣merchant account እና webhook specifications ያስፈልጋሉ።
- GitHub push ለማድረግ የrepository URL እና የተፈቀደ GitHub connector/credentials ያስፈልጋሉ።


## Telegram control-panel visual and payment-account upgrade — IN PROGRESS

- The control panel opens in Light Mode by default, remembers the user's Light/Dark selection, and provides a visible theme toggle without changing existing data or permissions.
- The panel receives a professional navigation/header/card treatment while preserving Overview, Website Access, Subscribers, Payments, Plans, trading data, and member views.
- The owner can add, edit, and remove payment accounts for Ethiopian banks, Telebirr, international crypto, and any other supported route. Each saved account has a region, name, and customer-facing details such as account/phone number, wallet address, accepted currency, and network.
- Existing payment options remain unchanged until the new account list is explicitly saved.
