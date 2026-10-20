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
