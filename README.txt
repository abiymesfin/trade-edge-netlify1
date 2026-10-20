TRADE EDGE — Netlify

FIRST TIME
1. Double-click 1-install-and-login.bat (install dependencies and sign in to Netlify).
2. Double-click 2-deploy.bat (create/deploy the site; choose the site name when Netlify asks).
3. In Netlify Dashboard → Site configuration → Environment variables, add:
   BOT_TOKEN = your NEW Telegram bot token
   OWNER_ID = your Telegram numeric owner id
   SETUP_KEY = a long random secret used only for /api/setup
4. Deploy again with 2-deploy.bat so the function receives the environment variables.
5. Open https://YOUR-SITE.netlify.app/api/setup?key=YOUR_SETUP_KEY once. It should say Done.
6. In Telegram send /start to your bot → Open app.
7. /password you@mail.com YourSecretPassword
8. /payinfo Telebirr 09xxxxxxxx (Name). Send the reference after paying.
9. /addplan 3 Months | 90 | 1200 ETB

IMPORTANT SECURITY
- Never put BOT_TOKEN in a .bat file, source code, ZIP, screenshot, or Git repo.
- The old token from the previous ZIP must be revoked in BotFather immediately and replaced in Netlify Environment variables.
- 3-set-secrets.bat was intentionally removed from this project.
- Keep SETUP_KEY private. /api/setup is locked unless the correct secret is supplied.

DATA SAVING
- Account/model/trade create, edit, enable/disable and delete operations require a successful server response.
- There is no localStorage fallback for records. If the internet/server is unavailable, the UI shows an error and does not claim success.
- Netlify Blobs writes are protected with a small server-side write lock to reduce read-modify-write collisions.

HOME DATA
- /api/market serves the live market feed and caches it for 5 minutes.
- /api/news serves the Forex Factory weekly calendar feed and caches it for 60 minutes.

BOT TRADE ENTRY
The bot now explicitly asks for timeframe, trade date/time (UTC+3), USD P/L and ETB P/L when applicable. P/L percentage is calculated from the account starting balance so it matches the Mini App.


V11: Telegram owner Mini App now opens as a Super Admin Control Panel. Normal public website UI is unchanged. The panel manages subscribers, payments, plans, reminder, pairs/analysis, accounts, models and trades.

ADMIN MINI APP
- Super Admin Control Panel lives at https://YOUR-SITE.netlify.app/admin/ and is separate from the public website.
- Telegram /start, /panel, and the bot menu button open /admin/.
- After deploying this version, run /api/setup once again so Telegram's menu button is updated to /admin/.


V28: PLANS EDITOR - in Telegram send /editplans (or the menu button "Plans & prices") to change prices, plan names, days, notes, the services list on the Plans page, free-trial days and how-to-pay text. No redeploy needed.

Deployment source: GitHub main branch connected to Netlify.
